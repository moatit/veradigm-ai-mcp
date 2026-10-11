import * as fs from 'fs';
import type { PlatformDeps } from '../../registry';
import { DocTypeCache } from './doctypes';
import { fileToChart, filingMode, filingStatus, IntakeFilingError } from './file';
import { extractFields } from './extract';
import { matchPatient } from './match';
import { FaxApiError, isOcrPending, MoatitFaxClient } from './moatit-fax';
import { OcrClient, OcrError, ocrReviewReason } from './ocr';
import { IntakeItem, IntakeStore } from './store';

/**
 * Intake processing: received → read → matched | needs_review | failed.
 *
 * 1. Fax items: fetch the job (OCR text, sender) and the original from MOATiT Fax. While OCR is
 *    still running the item waits (re-checked every OCR_WAIT_MS, at most OCR_MAX_WAITS times).
 * 2. Read: the text layer / MOATiT Fax OCR; when there is none, Drawbridge's own OCR container
 *    (ocr.ts, INTAKE_OCR_URL). An OCR failure leaves the item 'failed' with an OCR_* code (staff
 *    can retry); OCR text below INTAKE_OCR_MIN_CONFIDENCE is never auto-matched.
 *    Then extract fields from the text (extract.ts).
 * 3. Match the patient through unity_search_patients (match.ts).
 * 4. Suggest a Veradigm® EHR document type (doctypes.ts).
 * 5. Auto-file (file.ts) only when INTAKE_FILING=auto, filing is enabled, the match is 'auto', the
 *    document type was found by keyword and the sender is not in INTAKE_NO_AUTO_SENDERS (batch
 *    reports such as a lab's daily file). Everything else waits for staff.
 *
 * One item at a time (a serial queue), so a burst of faxes never floods Veradigm or MOATiT Fax.
 * Without platform deps (before the module starts) items stop at 'read' and are resumed at start.
 * Logs carry item IDs and error codes only.
 */
export const OCR_WAIT_MS = 60_000;
export const OCR_MAX_WAITS = 5;

export interface PipelineOptions {
  store: () => IntakeStore;
  fax?: () => MoatitFaxClient | null;
  docTypes?: DocTypeCache | null;
  deps?: Pick<PlatformDeps, 'runTool'> | null;
  /** Local OCR for files without text (default: OcrClient.fromEnv(); null = OCR off). */
  ocr?: () => OcrClient | null;
  now?: () => Date;
  /** Schedule a delayed re-check (tests replace it). */
  later?: (fn: () => void, ms: number) => void;
}

const AUTO = 'drawbridge';

export class IntakePipeline {
  private queue: Promise<void> = Promise.resolve();
  private queued = new Set<string>();

  constructor(private opts: PipelineOptions) {}

  setDeps(deps: Pick<PlatformDeps, 'runTool'>, docTypes: DocTypeCache | null): void {
    this.opts.deps = deps;
    this.opts.docTypes = docTypes;
  }

  /** Queue one item. Duplicate requests while it is waiting are ignored. */
  enqueue(id: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queue = this.queue
      .then(() => {
        this.queued.delete(id);
        return this.process(id);
      })
      .catch((e: any) => console.error(`[Intake] processing ${id} failed: ${e?.code || e?.name || 'error'}`));
  }

  /** Resolves when everything queued so far is done (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Re-queue items left unfinished by a restart. */
  resumePending(): number {
    const pending = this.opts.store().list().filter((i) => i.status === 'received' || i.status === 'read');
    for (const i of pending) this.enqueue(i.id);
    return pending.length;
  }

  async process(id: string): Promise<void> {
    const store = this.opts.store();
    let item = store.get(id);
    if (!item || (item.status !== 'received' && item.status !== 'read')) return;

    // 1. Fax: text and original from MOATiT Fax
    if (item.source === 'moatit_fax' && (!item.file || !item.has_text)) {
      const done = await this.fetchFax(store, item);
      if (!done) return;
      item = store.get(id)!;
    }

    // 2. Read (local OCR when the document came without text)
    let text = store.readText(id);
    if (!text.trim() && item.file) {
      const ocr = this.opts.ocr ? this.opts.ocr() : OcrClient.fromEnv();
      if (ocr) {
        const done = await this.runOcr(store, item, ocr);
        if (!done) return;
        item = store.get(id)!;
        text = store.readText(id);
      }
    }
    if (!text.trim()) {
      const note = item.ocr
        ? 'OCR found no readable text in this document. Review it and pick the patient by hand.'
        : 'No readable text in this document. Review it and pick the patient by hand.';
      store.update(id, { status: 'needs_review', note }, 'no readable text');
      return;
    }
    const extracted = extractFields(text, this.now());
    item = store.update(id, { status: 'read', extracted, error_code: undefined }, 'read');

    const deps = this.opts.deps;
    if (!deps) return; // resumed once the module starts

    // 3. Match
    const match = await matchPatient(extracted, deps.runTool, () => this.now());
    if (match.decision === 'error') {
      store.update(id, { status: 'failed', match, error_code: match.error_code }, `patient search failed (${match.error_code})`);
      return;
    }

    // 4. Document type (a failure here leaves the suggestion empty; it never blocks the match)
    let documentType = item.document_type ?? null;
    let typeNote = '';
    if (this.opts.docTypes) {
      try {
        documentType = await this.opts.docTypes.suggest(extracted.kind.value, extracted.subtype?.value);
      } catch (e: any) {
        typeNote = ` (document types unavailable: ${e?.code || 'error'})`;
      }
    }

    // Low-confidence OCR text is never auto-matched (the candidate is still shown to staff).
    const ocrGate = match.decision === 'auto' && item.ocr ? ocrReviewReason(item.ocr) : null;
    const auto = match.decision === 'auto' && !ocrGate;
    store.update(
      id,
      { status: auto ? 'matched' : 'needs_review', match, document_type: documentType, note: auto ? undefined : ocrGate || match.reason },
      `${auto ? 'matched' : `needs review: ${ocrGate ? 'low OCR confidence' : match.decision}`}${typeNote}`,
      AUTO
    );

    // 5. Auto-file
    const why = auto ? autoFileBlocker(store.get(id)!) : 'not auto-matched';
    if (why) {
      // In auto mode, say why a matched document still waits (e.g. a batch sender set to staff review).
      if (auto && filingMode() === 'auto') store.update(id, { note: `Matched, waiting for staff: ${why}.` }, `not auto-filed: ${why}`, AUTO);
      return;
    }
    try {
      const r = await fileToChart(store.get(id)!, AUTO);
      console.log(`[Intake] auto-filed ${id}${r.task_error ? ` (review task: ${r.task_error})` : ''}`);
    } catch (e: any) {
      const code = e instanceof IntakeFilingError ? e.error_code : 'FILING_UNCERTAIN';
      // Rejected/uncertain are already in the item history (file.ts); the rest is recorded here.
      if (!['FILING_REJECTED', 'FILING_UNCERTAIN'].includes(code)) store.update(id, {}, `auto-filing skipped (${code})`, AUTO);
      console.error(`[Intake] auto-filing ${id} not done: ${code}`);
    }
  }

  /** Local OCR of the original. Returns false when it failed (the item is then 'failed' with a code). */
  private async runOcr(store: IntakeStore, item: IntakeItem, ocr: OcrClient): Promise<boolean> {
    const file = store.filePath(item);
    if (!file) {
      store.update(item.id, { status: 'failed', error_code: 'FILE_MISSING' }, 'original file missing; cannot run OCR');
      return false;
    }
    try {
      const r = await ocr.read(fs.readFileSync(file));
      store.update(
        item.id,
        { ocr: { engine: 'local', pages: r.pages, mean_confidence: r.mean_confidence, used_text_layer: r.used_text_layer } },
        r.used_text_layer ? `text layer read (${r.pages} page(s))` : `OCR read ${r.pages} page(s), confidence ${Math.round(r.mean_confidence)}`
      );
      if (r.text.trim()) store.saveText(item.id, r.text);
      return true;
    } catch (e: any) {
      const code = e instanceof OcrError ? e.code : 'OCR_FAILED';
      store.update(item.id, { status: 'failed', error_code: code }, `OCR failed (${code})`);
      return false;
    }
  }

  /** Fetch OCR + original. Returns false when the item is waiting or failed. */
  private async fetchFax(store: IntakeStore, item: IntakeItem): Promise<boolean> {
    const client = this.opts.fax?.() ?? null;
    if (!client) {
      store.update(item.id, { status: 'failed', error_code: 'FAX_API_NOT_CONFIGURED' }, 'MOATiT Fax API not configured');
      return false;
    }
    try {
      if (!item.has_text) {
        const job = await client.getJob(item.job_id || '');
        if (job.sender_fax) store.update(item.id, { sender_fax: job.sender_fax });
        if (isOcrPending(job)) {
          const waits = (item.ocr_waits || 0) + 1;
          if (waits > OCR_MAX_WAITS) {
            store.update(item.id, { ocr_waits: waits }, 'OCR not finished; continuing without text');
          } else {
            store.update(item.id, { ocr_waits: waits }, 'waiting for OCR');
            this.later(() => this.enqueue(item.id), OCR_WAIT_MS);
            return false;
          }
        } else if (job.text.trim()) {
          store.saveText(item.id, job.text);
        }
      }
      if (!store.get(item.id)!.file) {
        const dl = await client.download(item.job_id || '');
        store.attachFile(item.id, dl.data, dl.name, dl.mime);
      }
      return true;
    } catch (e: any) {
      const code = e instanceof FaxApiError ? (e.httpStatus ? `${e.code}_${e.httpStatus}` : e.code) : e?.code || 'FAX_API_ERROR';
      store.update(item.id, { status: 'failed', error_code: code }, `MOATiT Fax fetch failed (${code})`);
      return false;
    }
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }
  private later(fn: () => void, ms: number): void {
    if (this.opts.later) this.opts.later(fn, ms);
    else setTimeout(fn, ms).unref?.();
  }
}

/** Why an auto-matched item must still wait for staff ('' = it may be auto-filed). */
export function autoFileBlocker(item: IntakeItem): string {
  if (filingMode() !== 'auto') return 'filing mode is not auto';
  if (!filingStatus().enabled) return 'filing disabled';
  if (item.match?.decision !== 'auto') return 'not auto-matched';
  if (!item.document_type || item.document_type.reason === 'fallback') return 'no specific document type';
  const sender = (item.extracted?.sender?.value || '').toLowerCase();
  const blocked = String(process.env.INTAKE_NO_AUTO_SENDERS || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (sender && blocked.some((b) => sender.includes(b))) return 'sender is set to staff review';
  return '';
}
