import * as fs from 'fs';
import type { PlatformDeps } from '../../registry';
import type { DocTypeSource } from './doctypes';
import { fileToChart, filingMode, filingStatus, IntakeFilingError } from './file';
import { extractFields } from './extract';
import { matchPatient } from './match';
import { FaxApiError, isOcrPending, MoatitFaxClient } from './moatit-fax';
import { OcrClient, OcrError, ocrReviewReason } from './ocr';
import { isListedSender, partOcr, segmentItem, splitPages, type PageSegmentation } from './pages';
import { shadowDecision, shadowMode, shadowSummary } from './shadow';
import { IntakeItem, IntakeStore } from './store';

export { partOcr, segmentItem, splitEnabled } from './pages';

/**
 * Intake processing: received → read → split | matched | needs_review | failed.
 *
 * 1. Fax items: fetch the job (OCR text, sender) and the original from MOATiT Fax. While OCR is
 *    still running the item waits (re-checked every OCR_WAIT_MS, at most OCR_MAX_WAITS times).
 * 2. Read: the text layer / MOATiT Fax OCR; when there is none, Drawbridge's own OCR container
 *    (ocr.ts, INTAKE_OCR_URL). An OCR failure leaves the item 'failed' with an OCR_* code (staff
 *    can retry); OCR text below INTAKE_OCR_MIN_CONFIDENCE is never auto-matched. With
 *    INTAKE_OCR_FAX=local, faxes that came with MOATiT Fax text are read by the container too and its
 *    text is used (MOATiT Fax's text is kept when that read fails).
 *    Then extract fields from the text (extract.ts).
 * 3. Pages (pages.ts): for a batch sender (INTAKE_BATCH_SENDERS) or a document naming more than one
 *    patient, every page is read on its own. Several patients, cleanly separated: the file is split
 *    into one part per patient (the OCR container's /pages cuts the original; each part keeps its
 *    pages' text) and the parent becomes 'split'. Each part then goes through steps 2-6 like any
 *    document; parts are never split again. Any doubt about the pages: the whole file goes to review.
 * 4. Match the patient through unity_search_patients (match.ts).
 * 5. Suggest a Veradigm® EHR document type (doctypes.ts).
 * 6. Auto-file (file.ts) only when INTAKE_FILING=auto, filing is enabled, the match is 'auto', the
 *    chart category is not the "(ready for indexing)" fallback, the page check passed (always
 *    required for batch senders), the file is not a duplicate, and the sender is not in
 *    INTAKE_NO_AUTO_SENDERS. Everything else waits for staff.
 *    Shadow mode (INTAKE_MODE=shadow, shadow.ts): this step never runs. The decision it would have
 *    made is recorded on the item instead (`shadow`), for every finished item and split parent.
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
  docTypes?: DocTypeSource | null;
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

  setDeps(deps: Pick<PlatformDeps, 'runTool'>, docTypes: DocTypeSource | null): void {
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

  /** Resolves when the queue is empty, including parts queued by a split while it ran (tests, shutdown). */
  async idle(): Promise<void> {
    let q: Promise<void>;
    do {
      q = this.queue;
      await q;
    } while (q !== this.queue);
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
    if (text.trim() && item.file && item.source === 'moatit_fax' && !item.ocr && !item.parent_id && localOcrForFaxes()) {
      // INTAKE_OCR_FAX=local: read the fax image with Drawbridge's OCR container too; its text
      // replaces MOATiT Fax's when the read succeeds, else MOATiT Fax's text is kept.
      const ocr = this.opts.ocr ? this.opts.ocr() : OcrClient.fromEnv();
      if (ocr) {
        await this.runOcr(store, item, ocr, true);
        item = store.get(id)!;
        text = store.readText(id);
      }
    }
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
      if (shadowMode()) this.recordShadow(store, id);
      return;
    }
    const extracted = extractFields(text, this.now());
    const parent = item.parent_id ? store.get(item.parent_id) : undefined;
    // A part keeps its parent's sender when its own pages don't name one (display, sender lists).
    if (!extracted.sender && parent?.extracted?.sender) extracted.sender = parent.extracted.sender;
    item = store.update(id, { status: 'read', extracted, error_code: undefined }, 'read');

    const deps = this.opts.deps;
    if (!deps) return; // resumed once the module starts

    // 3. Pages: one patient per filed document. Parts were checked as part of their parent.
    let pagesCheck = item.pages_check;
    if (!item.parent_id) {
      const seg = segmentItem(item, text, extracted, this.now());
      if (seg.decision === 'split') {
        await this.splitFile(store, item, text, seg);
        return;
      }
      pagesCheck = { ok: seg.decision === 'single', batch_sender: seg.batch_sender, pages: seg.page_count, cover_pages: seg.cover_pages, reason: seg.reason };
      item = store.update(id, { pages_check: pagesCheck }, seg.checked ? `pages checked: ${seg.decision === 'single' ? 'one patient' : 'needs review'}` : undefined);
    }
    const pageGate = pagesCheck && !pagesCheck.ok ? pagesCheck.reason : null;

    // 4. Match
    const match = await matchPatient(extracted, deps.runTool, () => this.now());
    if (match.decision === 'error') {
      store.update(id, { status: 'failed', match, error_code: match.error_code }, `patient search failed (${match.error_code})`);
      return;
    }

    // 5. Document type (a failure here leaves the suggestion empty; it never blocks the match)
    let documentType = item.document_type ?? null;
    let typeNote = '';
    if (this.opts.docTypes) {
      try {
        documentType = await this.opts.docTypes.suggest(extracted.kind.value, extracted.subtype?.value);
      } catch (e: any) {
        typeNote = ` (document types unavailable: ${e?.code || 'error'})`;
      }
    }

    // Low-confidence OCR text is never auto-matched (the candidate is still shown to staff), and
    // neither is a file whose pages could not be checked (the page check's reason is shown).
    const ocrGate = match.decision === 'auto' && item.ocr ? ocrReviewReason(item.ocr) : null;
    const auto = match.decision === 'auto' && !ocrGate && !pageGate;
    const why = pageGate ? 'page check' : ocrGate ? 'low OCR confidence' : match.decision;
    store.update(
      id,
      { status: auto ? 'matched' : 'needs_review', match, document_type: documentType, note: auto ? undefined : pageGate || ocrGate || match.reason },
      `${auto ? 'matched' : `needs review: ${why}`}${typeNote}`,
      AUTO
    );
    // Shadow mode: record what would happen next; never file.
    if (shadowMode()) {
      this.recordShadow(store, id);
      return;
    }

    // 6. Auto-file
    const blocker = auto ? autoFileBlocker(store.get(id)!) : 'not auto-matched';
    if (blocker) {
      // In auto mode, say why a matched document still waits (e.g. a sender set to staff review).
      if (auto && filingMode() === 'auto') store.update(id, { note: `Matched, waiting for staff: ${blocker}.` }, `not auto-filed: ${blocker}`, AUTO);
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

  /** Shadow mode: the decision the filing step would have made, on the item (shadow.ts). */
  private recordShadow(store: IntakeStore, id: string): void {
    const item = store.get(id)!;
    const d = shadowDecision(item, itemAutoFileBlocker(item), this.now());
    store.update(id, { shadow: d }, shadowSummary(d), AUTO);
  }

  /**
   * Local OCR of the original. Returns false when it failed (the item is then 'failed' with a code).
   * `soft`: the item already has text (MOATiT Fax); a failure is noted and that text is kept.
   */
  private async runOcr(store: IntakeStore, item: IntakeItem, ocr: OcrClient, soft = false): Promise<boolean> {
    const file = store.filePath(item);
    if (!file) {
      store.update(item.id, { status: 'failed', error_code: 'FILE_MISSING' }, 'original file missing; cannot run OCR');
      return false;
    }
    try {
      const r = await ocr.read(fs.readFileSync(file));
      store.update(
        item.id,
        {
          ocr: {
            engine: 'local',
            pages: r.pages,
            mean_confidence: r.mean_confidence,
            used_text_layer: r.used_text_layer,
            ...(r.page_confidences.length === r.pages ? { page_confidences: r.page_confidences } : {}),
          },
          page_count: r.pages,
        },
        r.used_text_layer ? `text layer read (${r.pages} page(s))` : `OCR read ${r.pages} page(s), confidence ${Math.round(r.mean_confidence)}`
      );
      if (r.text.trim()) store.saveText(item.id, r.text);
      return true;
    } catch (e: any) {
      const code = e instanceof OcrError ? e.code : 'OCR_FAILED';
      if (soft) {
        store.update(item.id, {}, `local OCR failed (${code}); MOATiT Fax text kept`);
        return true;
      }
      store.update(item.id, { status: 'failed', error_code: code }, `OCR failed (${code})`);
      return false;
    }
  }

  /**
   * One part per patient (seg.decision === 'split'). The original is cut by the OCR container
   * (/pages); each part keeps only its pages and their text. Nothing is created until every part is
   * cut and the file's page count equals the text's. Parts made by an earlier attempt are reused
   * (same parent + pages), so re-processing never duplicates them; an earlier attempt with other
   * parts sends the file to staff. The parent becomes 'split' only once every part exists.
   */
  private async splitFile(store: IntakeStore, item: IntakeItem, text: string, seg: PageSegmentation): Promise<void> {
    const n = seg.patients.length;
    const review = (note: string, action: string) =>
      store.update(
        item.id,
        { status: 'needs_review', note, pages_check: { ok: false, batch_sender: seg.batch_sender, pages: seg.page_count, cover_pages: seg.cover_pages, reason: note } },
        action
      );
    const file = store.filePath(item);
    if (!file) {
      store.update(item.id, { status: 'failed', error_code: 'FILE_MISSING' }, 'original file missing; cannot split');
      return;
    }
    const ocr = this.opts.ocr ? this.opts.ocr() : OcrClient.fromEnv();
    if (!ocr) {
      review(`The document shows ${n} patients. Splitting needs the OCR service, which is turned off: split it by hand.`, 'not split: OCR service off');
      return;
    }
    const refs = seg.patients.map((g) => IntakeStore.partRef(item.id, g.pages));
    if (store.list().some((c) => c.parent_id === item.id && !refs.includes(c.source_ref))) {
      review('An earlier split of this document made different parts. Check by hand.', 'not split: differs from an earlier split');
      return;
    }

    const data = fs.readFileSync(file);
    const cut: ({ data: Buffer; mime: string } | null)[] = [];
    try {
      for (const [k, g] of seg.patients.entries()) {
        if (store.findBySourceRef(refs[k])) {
          cut.push(null);
          continue;
        }
        const r = await ocr.extractPages(data, g.pages);
        if (r.source_pages !== seg.page_count) {
          review(`The file has ${r.source_pages} page(s) but its text has ${seg.page_count}, so it was not split. Split it by hand.`, 'not split: page count mismatch');
          return;
        }
        cut.push(r);
      }
    } catch (e: any) {
      const code = e instanceof OcrError ? e.code : 'OCR_FAILED';
      store.update(item.id, { status: 'failed', error_code: code }, `split failed (${code})`);
      return;
    }

    const pageTexts = splitPages(text, seg.page_count);
    const ids: string[] = [];
    const fresh: string[] = [];
    for (const [k, g] of seg.patients.entries()) {
      const c = cut[k];
      const existing = store.findBySourceRef(refs[k]);
      if (existing || !c) {
        ids.push(existing!.id);
        continue;
      }
      const part = store.addPart(item, {
        index: k,
        of: n,
        pages: g.pages,
        data: c.data,
        mime: c.mime,
        text: g.pages.map((p) => pageTexts[p - 1]).join('\f'),
        ocr: partOcr(item.ocr, g.pages),
      }).item;
      store.update(part.id, {
        pages_check: { ok: true, batch_sender: seg.batch_sender, pages: g.pages.length, reason: `Pages checked with the original (part ${k + 1} of ${n}).` },
      });
      ids.push(part.id);
      fresh.push(part.id);
    }
    store.update(
      item.id,
      {
        status: 'split',
        note: `Split into ${n} documents, one per patient. Each is matched and filed on its own.`,
        split: { at: this.now().toISOString(), children: ids, pages: seg.patients.map((g) => g.pages), cover_pages: seg.cover_pages },
        pages_check: { ok: true, batch_sender: seg.batch_sender, pages: seg.page_count, cover_pages: seg.cover_pages, reason: seg.reason },
      },
      `split into ${n} documents, one per patient (${seg.reason})`
    );
    console.log(`[Intake] split ${item.id} into ${n} part(s)`);
    if (shadowMode()) this.recordShadow(store, item.id);
    for (const id of ids) {
      const s = store.get(id)?.status;
      if (s === 'received' || s === 'read') this.enqueue(id);
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
        if (job.sender_fax || job.page_count) {
          store.update(item.id, { ...(job.sender_fax ? { sender_fax: job.sender_fax } : {}), ...(job.page_count ? { page_count: job.page_count } : {}) });
        }
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

/**
 * INTAKE_OCR_FAX=local: faxes from MOATiT Fax are also read by Drawbridge's OCR container (header
 * second pass, sender templates), and that text is used. Default: MOATiT Fax's own OCR text.
 */
export function localOcrForFaxes(): boolean {
  return String(process.env.INTAKE_OCR_FAX || '').trim().toLowerCase() === 'local';
}

/** Why an auto-matched item must still wait for staff ('' = it may be auto-filed). */
export function autoFileBlocker(item: IntakeItem): string {
  if (filingMode() !== 'auto') return 'filing mode is not auto';
  if (!filingStatus().enabled) return 'filing disabled';
  return itemAutoFileBlocker(item);
}

/** The item's own reasons to wait for staff, whatever the filing switches say (also shadow mode's "would it auto-file"). */
export function itemAutoFileBlocker(item: IntakeItem): string {
  if (item.status === 'split') return 'split into one document per patient';
  if (item.match?.decision !== 'auto') return 'not auto-matched';
  if (!item.document_type || item.document_type.reason === 'fallback') return 'no specific document type';
  if (item.duplicate_of) return 'same file as an earlier document';
  if (item.pages_check && !item.pages_check.ok) return 'pages not checked';
  const who = { sender: item.extracted?.sender?.value, senderFax: item.sender_fax };
  if ((item.pages_check?.batch_sender || isListedSender('INTAKE_BATCH_SENDERS', who)) && !item.pages_check?.ok) {
    return 'batch sender: every page must be checked first';
  }
  if (isListedSender('INTAKE_NO_AUTO_SENDERS', who)) return 'sender is set to staff review';
  return '';
}
