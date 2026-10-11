import fs from 'fs';
import type { UnityService } from '../../../unity/services/unity.service';
import { UnityActions } from '../../../unity/config/unity-endpoints';
import { pick, unityRows } from '../../../unity/utils/unity-rows';
import type { IntakeItem, IntakeStore } from './store';

/**
 * Filing a document to the patient's Veradigm® EHR chart.
 *
 * Owner-approved exception to CLAUDE.md rule 4, under the rules in docs/drawbridge/FAX_INTAKE_ADDON.md.
 * Verified on the sandbox Oct 11, 2026 (synthetic patients only):
 *   SaveScanDocument  Parameter1 = document type NAME (SCAN_DOCUMENTTYPE, e.g. "Lab Results"),
 *                     Parameter2 = file name (no slashes or spaces), Parameter3 = <docattributes> XML,
 *                     Parameter4 = <chunkupload> XML for files over 2 MB, Data = file bytes (base64).
 *                     Returns documentID. PDFs are stored as multi-page TIFF.
 *                     indexsource must be None: "Laboratory" needs the ID of a lab order we don't have.
 *                     docstatus 2 (Submitted) waits in the EHR's scan approval queue; 4 (Approved) shows
 *                     in the chart at once. "/" is stripped from doctitle and only ~50 characters show.
 *                     Files over 2 MB go in 1 MB chunks (verified with a 2.6 MB file).
 *   SaveTask          Parameter1 "Review" + Parameter3 = the scanned document ID links a review task to
 *                     the document (shows as task type "Scanned Document"). One task per document.
 *
 * Switches (all must allow it):
 *   INTAKE_FILING                           off (default) | review (staff click) | auto (high-confidence)
 *   INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED   true once the format above is verified for this environment
 *   INTAKE_DOC_STATUS                       submitted (default: staff approve in Veradigm EHR) | approved
 *   INTAKE_REVIEW_USER                      Veradigm EHR user name that gets the review task (unset: no task)
 *
 * Duplicate guard: an attempt is recorded on the item before the write. If Veradigm never answered
 * (timeout, network), the item is left FILING_UNCERTAIN and is not retried automatically: staff check
 * the chart first. A document is never filed twice by Drawbridge.
 */
export type FilingMode = 'off' | 'review' | 'auto';

export function filingMode(): FilingMode {
  const v = String(process.env.INTAKE_FILING || '').trim().toLowerCase();
  return v === 'review' || v === 'auto' ? v : 'off';
}

export function saveFormatConfirmed(): boolean {
  return String(process.env.INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED || '').trim().toLowerCase() === 'true';
}

/** SCANSTATUS entry codes (sandbox Oct 11). */
export const SCAN_STATUS = { READY_FOR_INDEXING: '1', SUBMITTED: '2', APPROVED: '4' } as const;

export function filedDocStatus(): string {
  return String(process.env.INTAKE_DOC_STATUS || '').trim().toLowerCase() === 'approved' ? SCAN_STATUS.APPROVED : SCAN_STATUS.SUBMITTED;
}

export interface FilingStatus {
  enabled: boolean;
  mode: FilingMode;
  format_confirmed: boolean;
  /** Staff-readable reason when disabled. */
  reason: string;
}

export function filingStatus(): FilingStatus {
  const mode = filingMode();
  const confirmed = saveFormatConfirmed();
  if (mode === 'off') {
    return { enabled: false, mode, format_confirmed: confirmed, reason: 'Filing to the Veradigm® EHR chart is turned off. Documents are read, matched and queued for staff only.' };
  }
  if (!confirmed) {
    return { enabled: false, mode, format_confirmed: confirmed, reason: 'Filing is waiting for the Veradigm® EHR document upload to be verified on the test system.' };
  }
  return { enabled: true, mode, format_confirmed: confirmed, reason: '' };
}

export type FilingErrorCode = 'FILING_DISABLED' | 'NOT_READY' | 'ALREADY_FILED' | 'FILING_REJECTED' | 'FILING_UNCERTAIN';

/** Structured failure, same shape the platform uses for tools ({ success:false, error_code, retryable }). */
export class IntakeFilingError extends Error {
  readonly success = false as const;
  constructor(
    readonly error_code: FilingErrorCode,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'IntakeFilingError';
  }
  toJSON() {
    return { success: false, error_code: this.error_code, retryable: this.retryable, message: this.message };
  }
}

/** Throws FILING_DISABLED unless INTAKE_FILING is review/auto AND the save format is confirmed. */
export function assertFilingEnabled(): void {
  const s = filingStatus();
  if (!s.enabled) throw new IntakeFilingError('FILING_DISABLED', s.reason);
}

/** What must hold for one item before a filing call (two-identifier match, chart ID, file, type, not filed). */
export function filingPreconditions(item: IntakeItem, target: 'chart' | 'indexing'): string[] {
  const problems: string[] = [];
  if (item.status === 'filed' || item.status === 'sent_to_indexing' || item.filed?.document_id) problems.push('already filed');
  if (!item.file) problems.push('no original file');
  if (!item.match?.patient?.chartPatientId) problems.push('no matched patient chart');
  if (target === 'chart') {
    if (item.match?.decision !== 'auto' && !item.reviewed_by) problems.push('match not confirmed by two identifiers or by staff');
    if (!item.document_type?.name) problems.push('no document type');
  }
  return problems;
}

// ── Building the Veradigm request ────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const xmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Veradigm strips "/" from titles and file names; keep titles plain. */
const plain = (s: string) => s.replace(/[\\/]+/g, '-').replace(/[^\w .,'()&-]/g, ' ').replace(/\s+/g, ' ').trim();

/** MM/DD/YYYY → Date (UTC midnight), or null. */
function parseUsDate(s: string | undefined): Date | null {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Clinical date for the chart: the collection/service date on the document, else the day it was received. Never in the future. */
export function clinicalDate(item: IntakeItem, now: Date): string {
  const fromDoc = parseUsDate(item.extracted?.collection_date?.value);
  const received = new Date(item.received_at);
  const d = fromDoc && fromDoc.getTime() <= now.getTime() ? fromDoc : Number.isNaN(received.getTime()) ? now : received;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

/** Veradigm® EHR shows about 50 characters of a scanned document's title (sandbox Oct 11). */
export const TITLE_MAX = 50;
const SUBTYPE_SHORT: Record<string, string> = {
  ct: 'CT', mri: 'MRI', chest_xray: 'chest X-ray', xray: 'X-ray', mammogram: 'mammogram', ultrasound: 'ultrasound',
  nuclear: 'nuclear scan', pathology: 'pathology', ekg: 'EKG', stress_test: 'stress test', colonoscopy: 'colonoscopy',
  discharge_summary: 'discharge summary', history_physical: 'H&P', op_note: 'op note', progress_note: 'progress note',
  referral_letter: 'referral', insurance_card: 'insurance card',
};
const KIND_SHORT: Record<string, string> = { lab_result: 'lab', imaging: 'imaging', consult: 'consult', referral: 'referral', other: 'document' };

/** "Outside lab Oct 10 2026 - Summit Reference Laboratory", cut at a word to fit TITLE_MAX. */
export function documentTitle(item: IntakeItem, now: Date): string {
  const kind = SUBTYPE_SHORT[item.extracted?.subtype?.value || ''] || KIND_SHORT[item.extracted?.kind?.value || 'other'] || 'document';
  const sender = plain(item.extracted?.sender?.value || '');
  const [m, d, y] = clinicalDate(item, now).split('/');
  const full = `Outside ${kind} ${MONTHS[+m - 1]} ${d} ${y}` + (sender ? ` - ${sender}` : '');
  if (full.length <= TITLE_MAX) return full;
  const cut = full.slice(0, TITLE_MAX + 1);
  return cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : TITLE_MAX).replace(/[\s-]+$/, '');
}

export function vendorFileName(item: IntakeItem): string {
  const ext = (item.file?.stored_as.match(/\.(pdf|tif|tiff|png|jpg|jpeg)$/i)?.[0] || '.pdf').toLowerCase();
  return `drawbridge-${item.id.replace(/[^\w-]/g, '')}${ext}`;
}

export function docAttributesXml(item: IntakeItem, status: string, now: Date): string {
  return (
    '<docattributes><transID>0</transID>' +
    `<clinicaldate>${clinicalDate(item, now)}</clinicaldate>` +
    '<indexsource>None</indexsource>' +
    `<doctitle>${xmlText(documentTitle(item, now))}</doctitle>` +
    `<docstatus>${status}</docstatus></docattributes>`
  );
}

/** Files over 2 MB must be sent in chunks (SaveScanDocument Parameter4). */
export const CHUNK_LIMIT = 2 * 1024 * 1024;
export const CHUNK_SIZE = 1024 * 1024;

// ── Veradigm calls ───────────────────────────────────────────────────────────

type UnityLike = Pick<UnityService, 'executeAction'>;

export interface FilingDeps {
  unity: UnityLike;
  store: () => IntakeStore;
  now?: () => Date;
}

let configured: FilingDeps | null = null;
/** Called once at module start (index.ts). Tests pass their own deps. */
export function setFilingDeps(deps: FilingDeps | null): void {
  configured = deps;
}

/** Veradigm answered with an error: nothing was created. */
class Rejected extends Error {}

async function call(unity: UnityLike, action: string, params: Record<string, string>, patientId: string): Promise<Record<string, any>> {
  const res: any = await unity.executeAction<any>(action, params, patientId, 'EHR'); // transport errors throw: outcome unknown
  if (!res || !res.success) throw new Rejected(String(res?.error || `${action} failed`).slice(0, 300));
  return unityRows(res.data)[0] || {};
}

/** SaveScanDocument, in one call or in chunks. Returns the new document ID. */
async function saveScanDocument(unity: UnityLike, chartId: string, docType: string, fileName: string, attrs: string, data: Buffer): Promise<string> {
  const action = UnityActions.Document.SAVE_SCAN_DOCUMENT;
  const base = { Parameter1: docType, Parameter2: fileName, Parameter3: attrs };
  if (data.length <= CHUNK_LIMIT) {
    const id = pick(await call(unity, action, { ...base, Parameter4: '', Data: data.toString('base64') }, chartId), 'documentID', 'DocumentID');
    if (!id) throw new Rejected('SaveScanDocument returned no document ID');
    return id;
  }
  let documentVar = '';
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const chunk = data.subarray(offset, offset + CHUNK_SIZE);
    const done = offset + chunk.length >= data.length;
    const chunkXml =
      `<chunkupload><offset>${offset}</offset><bytesRead>${chunk.length}</bytesRead>` +
      `<bDoneUpload>${done}</bDoneUpload><documentVar>${xmlText(documentVar)}</documentVar></chunkupload>`;
    const row = await call(unity, action, { ...base, Parameter4: chunkXml, Data: chunk.toString('base64') }, chartId);
    if (done) {
      const id = pick(row, 'documentID', 'DocumentID');
      if (!id) throw new Rejected('SaveScanDocument returned no document ID after the last chunk');
      return id;
    }
    documentVar = pick(row, 'documentVar', 'DocumentVar') || documentVar;
    if (!documentVar) throw new Rejected('SaveScanDocument returned no upload ID for the first chunk');
  }
  throw new Rejected('empty file');
}

/** Review task for the provider, linked to the scanned document. Returns the task ID, or '' when no reviewer is set. */
async function saveReviewTask(unity: UnityLike, chartId: string, documentId: string, title: string): Promise<string> {
  const reviewer = String(process.env.INTAKE_REVIEW_USER || '').trim();
  if (!reviewer) return '';
  const subject = xmlText(`New outside document for review: ${title}`.slice(0, 200));
  const row = await call(
    unity,
    UnityActions.Task.SAVE_TASK,
    {
      Parameter1: 'Review',
      Parameter2: reviewer,
      Parameter3: documentId,
      Parameter4: 'New outside document for review',
      Parameter5: `<taskdata><taskpriority>Medium</taskpriority><subject>${subject}</subject><sourceprovider></sourceprovider></taskdata>`,
    },
    chartId
  );
  return pick(row, 'TaskId', 'TaskID');
}

export interface FilingResult {
  success: true;
  item_id: string;
  document_id: string;
  task_id?: string;
  /** Task problem after a successful filing (the document stays filed). */
  task_error?: string;
}

async function file(item: IntakeItem, target: 'chart' | 'indexing', by: string, deps: FilingDeps | null): Promise<FilingResult> {
  assertFilingEnabled();
  if (!deps) throw new IntakeFilingError('FILING_DISABLED', 'Filing is not configured on this server.');
  const store = deps.store();
  const current = store.get(item.id) || item;
  const problems = filingPreconditions(current, target);
  if (problems.includes('already filed')) throw new IntakeFilingError('ALREADY_FILED', 'This document was already filed.');
  if (current.filing?.started_at && !current.filing.finished_at) {
    throw new IntakeFilingError('FILING_UNCERTAIN', 'An earlier filing attempt got no answer from Veradigm® EHR. Check the patient chart before trying again.');
  }
  if (problems.length) throw new IntakeFilingError('NOT_READY', `Not ready to ${target === 'chart' ? 'file' : 'send to indexing'}: ${problems.join(', ')}.`);
  const p = store.filePath(current);
  if (!p) throw new IntakeFilingError('NOT_READY', 'Not ready to file: the original file is missing.');

  const now = deps.now ? deps.now() : new Date();
  const chartId = current.match!.patient!.chartPatientId;
  const docType = target === 'chart' ? current.document_type!.name : '(ready for indexing)';
  const status = target === 'chart' ? filedDocStatus() : SCAN_STATUS.READY_FOR_INDEXING;
  const title = documentTitle(current, now);
  const data = fs.readFileSync(p);

  store.update(current.id, { filing: { target, started_at: now.toISOString() } }, target === 'chart' ? 'filing to chart started' : 'sending to indexing started', by);
  let documentId: string;
  try {
    documentId = await saveScanDocument(deps.unity, chartId, docType, vendorFileName(current), docAttributesXml(current, status, now), data);
  } catch (e: any) {
    if (e instanceof Rejected) {
      // Veradigm refused: nothing was created, so the attempt marker is cleared and staff may retry.
      store.update(current.id, { filing: undefined, error_code: 'FILING_REJECTED' }, 'Veradigm® EHR refused the document', by);
      console.error(`[Intake] filing rejected for ${current.id}: ${e.message.slice(0, 160)}`);
      throw new IntakeFilingError('FILING_REJECTED', 'Veradigm® EHR did not accept the document. It was not filed.', false);
    }
    store.update(current.id, { error_code: 'FILING_UNCERTAIN' }, 'no answer from Veradigm® EHR while filing', by);
    console.error(`[Intake] filing outcome unknown for ${current.id}: ${e?.code || e?.name || 'error'}`);
    throw new IntakeFilingError('FILING_UNCERTAIN', 'Veradigm® EHR did not answer. Check the patient chart before trying again.');
  }

  const finished = (deps.now ? deps.now() : new Date()).toISOString();
  store.update(
    current.id,
    {
      status: target === 'chart' ? 'filed' : 'sent_to_indexing',
      error_code: undefined,
      filing: { target, started_at: now.toISOString(), finished_at: finished },
      filed: { document_id: documentId, document_type: docType, doc_status: status, at: finished, by },
    },
    target === 'chart' ? `filed to chart (document ${documentId}, ${docType})` : `sent to indexing (document ${documentId})`,
    by
  );

  const result: FilingResult = { success: true, item_id: current.id, document_id: documentId };
  if (target === 'chart') {
    try {
      const taskId = await saveReviewTask(deps.unity, chartId, documentId, title);
      if (taskId) {
        result.task_id = taskId;
        store.update(current.id, { filed: { ...store.get(current.id)!.filed!, task_id: taskId } }, `review task ${taskId} sent`, by);
      }
    } catch (e: any) {
      result.task_error = e instanceof Rejected ? 'TASK_REJECTED' : 'TASK_UNCERTAIN';
      store.update(current.id, {}, `review task not sent (${result.task_error})`, by);
      console.error(`[Intake] review task failed for ${current.id}: ${result.task_error}`);
    }
  }
  return result;
}

/** File the original document to the matched patient's Veradigm® EHR chart and send the review task. */
export function fileToChart(item: IntakeItem, by = 'drawbridge', deps: FilingDeps | null = configured): Promise<FilingResult> {
  return file(item, 'chart', by, deps);
}

/** File under "(ready for indexing)" for the matched patient (status Ready for Indexing). */
export function sendToIndexing(item: IntakeItem, by = 'drawbridge', deps: FilingDeps | null = configured): Promise<FilingResult> {
  return file(item, 'indexing', by, deps);
}
