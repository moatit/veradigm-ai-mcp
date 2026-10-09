import type { PlatformDeps } from '../../registry';
import { DocTypeCache } from './doctypes';
import { extractFields } from './extract';
import { matchPatient } from './match';
import { FaxApiError, isOcrPending, MoatitFaxClient } from './moatit-fax';
import { IntakeItem, IntakeStore } from './store';

/**
 * Intake processing: received → read → matched | needs_review | failed.
 *
 * 1. Fax items: fetch the job (OCR text, sender) and the original from MOATiT Fax. While OCR is
 *    still running the item waits (re-checked every OCR_WAIT_MS, at most OCR_MAX_WAITS times).
 * 2. Extract fields from the text (extract.ts).
 * 3. Match the patient through unity_search_patients (match.ts).
 * 4. Suggest a Veradigm® EHR document type (doctypes.ts).
 * Filing is a separate, staff-triggered step (file.ts) and is disabled on this branch.
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

    // 2. Read
    const text = store.readText(id);
    if (!text.trim()) {
      store.update(
        id,
        { status: 'needs_review', note: 'No readable text in this document. Review it and pick the patient by hand.' },
        'no readable text'
      );
      // TODO(OCR): dropped and uploaded files without a text layer need OCR (MOATiT Fax OCR service
      // or a local engine) before they can be matched automatically.
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
        documentType = await this.opts.docTypes.suggest(extracted.kind.value);
      } catch (e: any) {
        typeNote = ` (document types unavailable: ${e?.code || 'error'})`;
      }
    }

    const status = match.decision === 'auto' ? 'matched' : 'needs_review';
    store.update(
      id,
      { status, match, document_type: documentType, note: match.decision === 'auto' ? undefined : match.reason },
      `${match.decision === 'auto' ? 'matched' : `needs review: ${match.decision}`}${typeNote}`,
      AUTO
    );
    // Auto-filing (INTAKE_FILING=auto) is deliberately not wired here: see file.ts.
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
