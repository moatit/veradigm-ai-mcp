import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { UnityActions } from '../../../unity/config/unity-endpoints';
import { pick, unityRows } from '../../../unity/utils/unity-rows';
import { READY_FOR_INDEXING_CODE } from './doctypes';
import { normalizeDate } from './extract';
import { toCandidates } from './match';
import type { OcrClient } from './ocr';
import { readOnlyRunTool, readOnlyUnity, type StaffObservation, type TruthPatient } from './shadow';
import { queueDocumentId, type IntakeItem, type IntakeStore } from './store';

/**
 * Staff filing observer (shadow mode, live Veradigm® only): ground truth from what the clinic's staff
 * already do. During shadow mode, faxes keep arriving in Veradigm® EHR's "(ready for indexing)"
 * queue and staff keep indexing them as today; Drawbridge receives the same faxes and reads back,
 * read-only, where staff put each one.
 *
 * 1. Track the queue. GetDocumentsByDocumentType with PatientID blank, Parameter1 = the
 *    "(ready for indexing)" type (INTAKE_OBSERVE_QUEUE_TYPE, default -1000999), Parameter2 = ''
 *    (LOINC, never with Parameter1), Parameter3/4 = start/end MM/DD/YYYY: every waiting document,
 *    all patients (DocumentID, Status, SortDate, DisplayName, DocumentType, DocumentSubType, PageCnt,
 *    PhysicalManifestation, AuthorName; PatientID only once indexed). Each DocumentID is remembered
 *    in <intake dir>/observer.json.
 * 2. Link each queue document to the intake item for the same fax: arrival time (SortDate vs
 *    received_at, within INTAKE_OBSERVE_LINK_HOURS), equal page count (a different count is never
 *    the same fax), the sender on DisplayName/AuthorName or the sending fax number. When two
 *    documents fit equally, their images are fetched (GetDocumentImage: PatientID, Parameter1 =
 *    DocumentID, 'Scan', 'PDF', 'N' → base64image) and compared with the original: same bytes, or
 *    the same text after local OCR (INTAKE_OBSERVE_FETCH, default on). Still a tie: no link.
 * 3. Re-check linked documents until they are indexed: the same DocumentID showing a PatientID and
 *    another type is exactly where staff filed it. It is looked for in the charts of Drawbridge's
 *    patient and the name + DOB candidates (GetDocuments), then in the listings of the likely
 *    categories (GetDocumentsByDocumentType per category over the window).
 * 4. Faxes that never pass through the queue: after INTAKE_OBSERVE_DELAY_HOURS, the candidates'
 *    charts are searched for a document added around the receipt date with the same page count and
 *    clinical date (at most medium confidence: there is no DocumentID trail).
 * Documents read from the queue itself (INTAKE_QUEUE_SOURCE, queue-source.ts) skip step 2: the item IS the queue
 * document, linked by its DocumentID, so where staff index it is high-confidence ground truth.
 * Unlinked or unindexed after INTAKE_OBSERVE_MAX_DAYS: not_observed. Never counted as correct; the
 * Confirm panel is the fallback. A file Drawbridge split by patient is observed but its parts are
 * not given that truth (staff index a batch fax as one document).
 *
 *   INTAKE_OBSERVE              on (default in shadow mode with Veradigm) | off
 *   INTAKE_OBSERVE_EVERY_MIN    run interval (default 30; Veradigm's polling floor of 2 minutes is enforced)
 *   INTAKE_OBSERVE_WINDOW_DAYS  queue and category listings cover this many days back (default 14)
 *   INTAKE_OBSERVE_LINK_HOURS   max time between the queue's SortDate and Drawbridge's receipt (default 36)
 *   INTAKE_OBSERVE_DELAY_HOURS  chart search for unlinked items after this (default 24)
 *   INTAKE_OBSERVE_MAX_DAYS     give up after this many days (default 7)
 *   INTAKE_OBSERVE_TYPES        categories to list when re-checking (default: the categories Drawbridge suggested)
 *   INTAKE_OBSERVE_PER_RUN      items searched by chart per run (default 40)
 *   INTAKE_OBSERVE_FETCH        on (default) | off: fetch images to break ties
 *
 * Every call goes through readOnlyUnity / readOnlyRunTool (shadow.ts). Logs carry counts and codes only.
 */
export interface DocRow {
  id: string;
  /** EHR patient ID; '' while the document waits in the queue. */
  patientKey: string;
  status: string;
  /** SortDate (or another date/time on the row) in ms; NaN when none. */
  when: number;
  /** True when `when` carries a time of day. */
  timed: boolean;
  /** MM/DD/YYYY of the row's date, or ''. */
  day: string;
  displayName: string;
  /** Category name (DocumentType). */
  type: string;
  /** Category code (DocumentSubType). */
  subtype: string;
  pages: number;
  author: string;
}

const env = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const off = (k: string) => /^(off|false|0|no)$/i.test(String(process.env[k] || '').trim());
export const observeEnabled = () => !off('INTAKE_OBSERVE');
/** Veradigm: an app must not poll Unity more often than every 2 minutes. */
export const MIN_POLL_MINUTES = 2;
let pollWarned = false;
/** INTAKE_OBSERVE_EVERY_MIN clamped to the 2-minute floor (warns once when clamped). */
export function observeEveryMinutes(): number {
  const want = env('INTAKE_OBSERVE_EVERY_MIN', 30);
  if (want >= MIN_POLL_MINUTES) return want;
  if (!pollWarned) {
    pollWarned = true;
    console.warn(`[Intake] INTAKE_OBSERVE_EVERY_MIN=${want} is below Veradigm's 2-minute polling floor; using ${MIN_POLL_MINUTES}`);
  }
  return MIN_POLL_MINUTES;
}
export const queueType = () => String(process.env.INTAKE_OBSERVE_QUEUE_TYPE || '').trim() || READY_FOR_INDEXING_CODE;
const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * One listing of the "(ready for indexing)" queue, shared by the staff filing observer and the queue source
 * (queue-source.ts) for each Veradigm® connection: within Veradigm's 2-minute polling floor the last listing is
 * reused, so the two never list the queue back to back. The window covers both (the wider of
 * INTAKE_OBSERVE_WINDOW_DAYS and INTAKE_QUEUE_WINDOW_DAYS); each caller narrows it for itself.
 */
const queueListings = new WeakMap<object, { at: number; rows: DocRow[] }>();
export const queueListingDays = (): number => Math.max(env('INTAKE_OBSERVE_WINDOW_DAYS', 14), env('INTAKE_QUEUE_WINDOW_DAYS', 3));
export async function listQueueShared(connection: object, list: (from: number, to: number) => Promise<DocRow[]>, now: number): Promise<DocRow[]> {
  const last = queueListings.get(connection);
  if (last && now >= last.at && now - last.at < MIN_POLL_MINUTES * 60_000) return last.rows;
  const rows = await list(now - queueListingDays() * DAY, now); // a failure throws: never "the queue is empty"
  queueListings.set(connection, { at: now, rows });
  return rows;
}

/** Veradigm® EHR shows times in the clinic's zone (INTAKE_EHR_TIMEZONE, else CLINIC_TIMEZONE, else America/Boise). */
const ehrZone = () => process.env.INTAKE_EHR_TIMEZONE || process.env.CLINIC_TIMEZONE || 'America/Boise';

/** Wall-clock time in `tz` → epoch ms. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz = ehrZone()): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return guess - (asLocal - guess);
}

/** The clinic-local calendar day of an instant, as a day number (for "same day" checks). */
export function localDay(t: number, tz = ehrZone()): number {
  const [m, d, y] = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)).split('/').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
}

/** A date/time from a Unity row: ISO (with or without a zone), "10/08/2026 08:15:00 AM", "10/08/2026". Clinic-local unless the text has a zone. */
export function parseWhen(s: string): { t: number; timed: boolean } {
  if (!s) return { t: NaN, timed: false };
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(s) && Number.isFinite(Date.parse(s))) return { t: Date.parse(s), timed: true };
    return { t: zonedToUtc(+iso[1], +iso[2], +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0)), timed: !!iso[4] };
  }
  const d = normalizeDate(s);
  if (!d) return { t: NaN, timed: false };
  const [m, day, y] = d.split('/').map(Number);
  const tm = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i);
  let h = tm ? +tm[1] : 0;
  if (tm?.[4]) h = (h % 12) + (/p/i.test(tm[4]) ? 12 : 0);
  return { t: zonedToUtc(y, m, day, h, tm ? +tm[2] : 0, tm?.[3] ? +tm[3] : 0), timed: !!tm };
}

/** GetDocumentsByDocumentType / GetDocuments rows → documents (verified field names first, aliases after). */
export function parseDocRows(data: unknown, patientKey = ''): DocRow[] {
  return unityRows(data)
    .map((r) => {
      const whenRaw = pick(r, 'SortDate', 'CreatedDTTM', 'CreateDate', 'EntryDate', 'DocumentDate', 'ClinicalDate');
      const w = parseWhen(whenRaw);
      return {
        id: pick(r, 'DocumentID', 'DocumentId', 'DocID', 'ID'),
        patientKey: pick(r, 'PatientID', 'PatientId') || patientKey,
        status: pick(r, 'Status', 'DocStatus'),
        when: w.t,
        timed: w.timed,
        day: normalizeDate(pick(r, 'ClinicalDate', 'DocumentDate', 'SortDate')),
        displayName: pick(r, 'DisplayName', 'DocTitle', 'Title', 'Description'),
        type: pick(r, 'DocumentType', 'DocumentTypeName', 'DocType'),
        subtype: pick(r, 'DocumentSubType', 'DocumentTypeCode', 'EntryCode'),
        pages: Number(pick(r, 'PageCnt', 'PageCount', 'Pages')) || 0,
        author: pick(r, 'AuthorName', 'Author', 'CreatedBy'),
      };
    })
    .filter((d) => d.id);
}

/** Still waiting for staff: no patient yet, or still typed "(ready for indexing)". */
export const inQueue = (d: Pick<DocRow, 'patientKey' | 'type' | 'subtype'>, code = queueType()) =>
  !d.patientKey || d.subtype === code || /ready for indexing/i.test(d.type) || d.type === code;

/** Link score of a document read from the queue itself: the same DocumentID, so the observation is high confidence. */
export const EXACT_LINK_SCORE = 10;
/** Observation note on a copy of a document that was also read from the queue (that queue item carries the truth). */
export const SAME_AS_QUEUE = 'same document also read from the indexing queue';

const words = (s: string) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
const itemPages = (i: IntakeItem) => i.part?.pages.length || i.page_count || i.ocr?.pages || 0;

/** How well a queue document fits an intake item; null when it can't be the same fax. */
export function linkScore(item: IntakeItem, doc: DocRow, linkHours = env('INTAKE_OBSERVE_LINK_HOURS', 36)): { score: number; signals: string[] } | null {
  const received = Date.parse(item.received_at);
  const signals: string[] = [];
  let score = 0;
  if (!Number.isFinite(doc.when)) return null;
  if (doc.timed) {
    const min = Math.abs(doc.when - received) / 60_000;
    if (min > linkHours * 60) return null;
    score += min <= 5 ? 4 : min <= 30 ? 3 : min <= 120 ? 2 : 1;
    signals.push(`arrived ${Math.round(min)} min apart`);
  } else {
    const days = localDay(doc.when) - localDay(received);
    if (days < -1 || days > 1) return null;
    score += days === 0 ? 1 : 0;
    signals.push(days === 0 ? 'same day' : 'a day apart');
  }
  const pages = itemPages(item);
  if (doc.pages && pages) {
    if (doc.pages !== pages) return null; // a different page count is a different fax
    score += 2;
    signals.push(`pages ${pages} = ${doc.pages}`);
  }
  const sender = words(item.extracted?.sender?.value || '');
  const label = `${doc.displayName} ${doc.author}`;
  const fax = String(item.sender_fax || '').replace(/\D/g, '').slice(-10);
  if ([...words(label)].some((w) => sender.has(w)) || (fax.length === 10 && label.replace(/\D/g, '').includes(fax))) {
    score += 1;
    signals.push('same sender');
  }
  return { score, signals };
}

/** A staff document in a candidate's chart, for faxes with no queue trail. */
export function chartScore(item: IntakeItem, doc: DocRow, maxDays: number): { score: number; signals: string[] } | null {
  const received = Date.parse(item.received_at);
  if (!Number.isFinite(doc.when)) return null;
  const delta = localDay(doc.when) - localDay(received);
  if (delta < -1 || delta > maxDays) return null;
  const signals = [`added ${delta <= 0 ? 'the same day' : `${delta} day(s) after receipt`}`];
  let score = delta <= 1 ? 1 : 0;
  const docDates = [item.extracted?.collection_date?.value].filter(Boolean);
  if (doc.day && docDates.includes(doc.day)) {
    score += 2;
    signals.push('clinical date matches');
  }
  const pages = itemPages(item);
  if (doc.pages && pages) {
    if (doc.pages !== pages) return null;
    score += 2;
    signals.push(`pages ${pages} = ${doc.pages}`);
  }
  return { score, signals };
}

/** Word overlap of two texts (Jaccard over words of 3+ letters/digits). */
export function textSimilarity(a: string, b: string): number {
  const x = new Set(String(a).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  const y = new Set(String(b).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

// ── The ledger of queue documents ────────────────────────────────────────────

export interface TrackedDoc {
  id: string;
  first_seen: string;
  last_seen: string;
  when: number;
  timed: boolean;
  pages: number;
  display: string;
  author: string;
  /** Intake item (top-level) for the same fax. */
  item?: string;
  link_score?: number;
  link_signals?: string[];
  /** Where staff filed it. */
  indexed?: { at: string; patient: string; type: string; subtype: string };
}

interface Ledger {
  docs: Record<string, TrackedDoc>;
}

class LedgerFile {
  constructor(readonly file: string) {}
  load(): Ledger {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return v && typeof v.docs === 'object' ? v : { docs: {} };
    } catch {
      return { docs: {} };
    }
  }
  save(l: Ledger): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(l), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

// ── The observer ─────────────────────────────────────────────────────────────

type UnityLike = { executeAction: (action: string, params?: any, patientId?: string, target?: any) => Promise<any> };
type RunTool = (name: string, args: any) => Promise<any>;

export interface ObserverOptions {
  store: () => IntakeStore;
  unity: UnityLike;
  runTool: RunTool;
  /** Local OCR for the text comparison (null: compare bytes only). */
  ocr?: () => OcrClient | null;
  now?: () => Date;
}

export interface ObserveRunResult {
  queue: number;
  linked: number;
  indexed: number;
  found: number;
  pending: number;
  not_observed: number;
  errors: number;
}

/** MM/DD/YYYY in the clinic's zone (the listing's Parameter3/4). */
const fmtDay = (t: number) => new Intl.DateTimeFormat('en-US', { timeZone: ehrZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const codeOf = (e: any, d: string) => String(e?.code || d).replace(/[^\w]/g, '').slice(0, 40);

export class StaffFilingObserver {
  private unity: UnityLike;
  private runTool: RunTool;
  private running = false;

  constructor(private opts: ObserverOptions) {
    // Whatever is passed in, only the read actions run.
    this.unity = readOnlyUnity(opts.unity);
    this.runTool = readOnlyRunTool(opts.runTool);
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private async call(action: string, params: Record<string, string>, patientId: string): Promise<any> {
    const res = await this.unity.executeAction(action, params, patientId, 'EHR');
    if (!res || !res.success) throw Object.assign(new Error(`${action} failed`), { code: `${action.toUpperCase()}_FAILED` });
    return res.data;
  }

  /** Documents of one type (ID or name) between two days, all patients. */
  async listByType(type: string, from: number, to: number): Promise<DocRow[]> {
    return parseDocRows(await this.call(UnityActions.Document.GET_DOCUMENTS_BY_DOCUMENT_TYPE, { Parameter1: type, Parameter2: '', Parameter3: fmtDay(from), Parameter4: fmtDay(to) }, ''));
  }

  async chartDocuments(chartId: string): Promise<DocRow[]> {
    return parseDocRows(await this.call(UnityActions.Document.GET_DOCUMENTS, {}, chartId), chartId);
  }

  /** The whole document as PDF (sandbox: TIFF_MULTIPAGE fails, PDF works). */
  async image(doc: { id: string; patientKey?: string }): Promise<Buffer> {
    const rows = unityRows(await this.call(UnityActions.Document.GET_DOCUMENT_IMAGE, { Parameter1: doc.id, Parameter2: 'Scan', Parameter3: 'PDF', Parameter4: 'N' }, doc.patientKey || ''));
    const b64 = pick(rows[0], 'base64image', 'Base64Image', 'image');
    if (!b64) throw Object.assign(new Error('no image'), { code: 'NO_IMAGE' });
    return Buffer.from(b64, 'base64');
  }

  /** Drawbridge's patient and everyone with the document's name + DOB (read-only search). */
  private async candidates(item: IntakeItem): Promise<Map<string, TruthPatient>> {
    const out = new Map<string, TruthPatient>();
    const p = item.match?.patient;
    if (p?.chartPatientId) out.set(p.chartPatientId, { key: p.chartPatientId, name: p.name, dateOfBirth: p.dateOfBirth, mrn: p.mrn });
    const name = item.extracted?.patient_name;
    const dob = item.extracted?.dob;
    if (name && dob && (item.extracted?.patient_count ?? 1) <= 1) {
      const r = await this.runTool('unity_search_patients', { lastName: name.value.last, firstName: name.value.first, dateOfBirth: dob.value });
      if (r?.success === false) throw Object.assign(new Error('search failed'), { code: String(r.error_code || 'SEARCH_FAILED') });
      for (const c of toCandidates(r)) {
        if (c.chartPatientId && !out.has(c.chartPatientId)) out.set(c.chartPatientId, { key: c.chartPatientId, name: `${c.firstName} ${c.lastName}`.trim(), dateOfBirth: c.dateOfBirth, mrn: c.mrn });
      }
    }
    return out;
  }

  /** Same fax? Bytes first, then OCR text. */
  private async sameContent(store: IntakeStore, item: IntakeItem, doc: TrackedDoc & { patientKey?: string }): Promise<'same_file' | 'same_text' | 'different' | 'unknown'> {
    let data: Buffer;
    try {
      data = await this.image(doc);
    } catch {
      return 'unknown';
    }
    if (item.file && createHash('sha256').update(data).digest('hex') === item.file.sha256) return 'same_file';
    const ocr = this.opts.ocr?.() ?? null;
    const mine = store.readText(item.id);
    if (!ocr || !mine.trim()) return 'unknown';
    try {
      const sim = textSimilarity((await ocr.read(data)).text, mine);
      return sim >= 0.5 ? 'same_text' : sim < 0.2 ? 'different' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async run(): Promise<ObserveRunResult> {
    const out: ObserveRunResult = { queue: 0, linked: 0, indexed: 0, found: 0, pending: 0, not_observed: 0, errors: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      const store = this.opts.store();
      const now = this.now();
      const ledgerFile = new LedgerFile(path.join(store.dir, 'observer.json'));
      const ledger = ledgerFile.load();
      const windowDays = env('INTAKE_OBSERVE_WINDOW_DAYS', 14);
      const maxDays = env('INTAKE_OBSERVE_MAX_DAYS', 7);
      const from = now.getTime() - windowDays * DAY;
      const at = now.toISOString();

      // 1. The queue.
      let queueOk = true;
      try {
        const rows = (await listQueueShared(this.opts.unity, (f, t) => this.listByType(queueType(), f, t), now.getTime())).filter((d) => inQueue(d));
        out.queue = rows.length;
        for (const d of rows) {
          const t = ledger.docs[d.id];
          ledger.docs[d.id] = t
            ? { ...t, last_seen: at, pages: d.pages || t.pages }
            : { id: d.id, first_seen: at, last_seen: at, when: d.when, timed: d.timed, pages: d.pages, display: d.displayName, author: d.author };
        }
      } catch (e) {
        queueOk = false;
        out.errors++;
        console.error(`[Intake] staff filing observer: queue listing failed (${codeOf(e, 'QUEUE_FAILED')})`);
      }

      // 2. Link queue documents to intake items (top level, decided, received within the window).
      const items = store.list().filter((i) => !i.parent_id && i.shadow && Date.parse(i.received_at) >= from);
      // Best pairs first; a pair that ties with another free pair on the same item or document (or
      // is weak) is decided by comparing the documents themselves, or not linked at all.
      const linkedItems = new Set(Object.values(ledger.docs).map((d) => d.item).filter(Boolean) as string[]);
      // Documents read from the queue itself (queue-source.ts) ARE the queue document: linked by DocumentID only,
      // never by guesswork. If another source brought a copy of the same document and it was linked first, the
      // queue item takes the link and the copy is set aside (ambiguous): neither is paired by time and pages.
      for (const item of items) {
        if (item.source !== 'veradigm_queue') continue;
        const docId = queueDocumentId(item.source_ref);
        if (!docId) continue;
        const received = Date.parse(item.queue_at || item.received_at);
        const d = (ledger.docs[docId] ||= { id: docId, first_seen: item.received_at, last_seen: item.received_at, when: received, timed: true, pages: itemPages(item), display: '', author: '' });
        if (d.item === item.id) continue;
        if (d.item) {
          const copy = store.get(d.item);
          linkedItems.delete(d.item);
          if (copy && copy.observed?.status !== 'found') {
            const obs: StaffObservation = { at, attempts: (copy.observed?.attempts || 0) + 1, status: 'ambiguous', looked_in: 0, signals: [SAME_AS_QUEUE] };
            store.update(copy.id, { observed: obs }, SAME_AS_QUEUE);
          }
        }
        d.item = item.id;
        d.link_score = EXACT_LINK_SCORE;
        d.link_signals = ['same document, read from the indexing queue'];
        delete d.indexed; // re-checked for this item below
        linkedItems.add(item.id);
        out.linked++;
      }
      type Pair = { item: IntakeItem; d: TrackedDoc; s: { score: number; signals: string[] } };
      const pairs: Pair[] = [];
      // Never guessed: queue items (linked by DocumentID above) and items already set aside as ambiguous.
      for (const item of items.filter((i) => !linkedItems.has(i.id) && i.source !== 'veradigm_queue' && i.observed?.status !== 'ambiguous')) {
        for (const d of Object.values(ledger.docs).filter((x) => !x.item)) {
          const s = linkScore(item, { id: d.id, patientKey: '', status: '', when: d.when, timed: d.timed, day: '', displayName: d.display, type: '', subtype: '', pages: d.pages, author: d.author });
          if (s && s.score >= 2) pairs.push({ item, d, s });
        }
      }
      pairs.sort((a, b) => b.s.score - a.s.score);
      const tried = new Set<string>();
      const free = (p: Pair) => !p.d.item && !linkedItems.has(p.item.id);
      for (const p of pairs) {
        if (!free(p) || tried.has(p.item.id)) continue;
        const rivals = pairs.filter((q) => q !== p && free(q) && q.s.score === p.s.score && (q.item === p.item || q.d === p.d));
        let link: { d: TrackedDoc; score: number; signals: string[] } | null = !rivals.length && p.s.score >= 3 ? { d: p.d, score: p.s.score, signals: p.s.signals } : null;
        if (!link && !off('INTAKE_OBSERVE_FETCH')) {
          const docs = [p, ...rivals.filter((q) => q.item === p.item)].slice(0, 4);
          for (const q of docs) {
            const c = await this.sameContent(store, p.item, q.d);
            if (c === 'same_file' || c === 'same_text') {
              link = { d: q.d, score: q.s.score + (c === 'same_file' ? 5 : 4), signals: [...q.s.signals, c === 'same_file' ? 'same file' : 'same text'] };
              break;
            }
          }
        }
        if (!link) {
          tried.add(p.item.id);
          continue;
        }
        link.d.item = p.item.id;
        link.d.link_score = link.score;
        link.d.link_signals = link.signals;
        linkedItems.add(p.item.id);
        out.linked++;
      }

      // 3. Re-check linked documents that are no longer in the queue: where did staff put them?
      const missing = Object.values(ledger.docs).filter((d) => d.item && !d.indexed && queueOk && d.last_seen !== at);
      const people = new Map<string, Map<string, TruthPatient>>();
      const charts = new Map<string, DocRow[]>();
      const found = (d: TrackedDoc, r: DocRow) => {
        d.indexed = { at, patient: r.patientKey, type: r.type, subtype: r.subtype };
        out.indexed++;
      };
      for (const d of missing) {
        const item = store.get(d.item!);
        if (!item) continue;
        try {
          const ps = await this.candidates(item);
          people.set(item.id, ps);
          for (const key of ps.keys()) {
            if (!charts.has(key)) charts.set(key, await this.chartDocuments(key));
            const r = charts.get(key)!.find((x) => x.id === d.id && !inQueue(x));
            if (r) {
              found(d, r);
              break;
            }
          }
        } catch (e) {
          out.errors++;
        }
      }
      const stillMissing = missing.filter((d) => !d.indexed);
      if (stillMissing.length) {
        const configured = String(process.env.INTAKE_OBSERVE_TYPES || '').split(',').map((s) => s.trim()).filter(Boolean);
        const types = configured.length ? configured : [...new Set(stillMissing.map((d) => store.get(d.item!)?.shadow?.category).filter(Boolean) as string[])].slice(0, 10);
        const since = Math.min(...stillMissing.map((d) => (Number.isFinite(d.when) ? d.when : Date.parse(d.first_seen)))) - DAY;
        for (const type of types) {
          try {
            const rows = await this.listByType(type, since, now.getTime());
            for (const d of stillMissing.filter((x) => !x.indexed)) {
              const r = rows.find((x) => x.id === d.id && !inQueue(x));
              if (r) found(d, r);
            }
          } catch (e) {
            out.errors++;
          }
        }
      }

      // 4. Record on the items.
      const byItem = new Map(Object.values(ledger.docs).filter((d) => d.item).map((d) => [d.item!, d]));
      const delayH = env('INTAKE_OBSERVE_DELAY_HOURS', 24);
      let chartSearches = 0;
      for (const item of items) {
        if (item.observed?.status === 'found' || item.observed?.status === 'not_observed' || item.observed?.status === 'ambiguous') continue;
        const age = now.getTime() - Date.parse(item.received_at);
        const expired = age > maxDays * DAY;
        const prev = item.observed;
        const attempts = (prev?.attempts || 0) + 1;
        const d = byItem.get(item.id);
        let obs: StaffObservation | null = null;
        if (d?.indexed) {
          const ps = people.get(item.id) || new Map<string, TruthPatient>();
          const who = ps.get(d.indexed.patient) || (item.match?.patient?.chartPatientId === d.indexed.patient ? { key: d.indexed.patient, name: item.match.patient.name, dateOfBirth: item.match.patient.dateOfBirth, mrn: item.match.patient.mrn } : { key: d.indexed.patient, name: '', dateOfBirth: '', mrn: '' });
          obs = {
            at,
            attempts,
            status: 'found',
            via: 'queue',
            looked_in: ps.size,
            patient: who,
            ...(d.indexed.type ? { category: d.indexed.type } : {}),
            document_id: d.id,
            confidence: (d.link_score || 0) >= 5 ? 'high' : 'medium',
            score: d.link_score,
            signals: [...(d.link_signals || []), `indexed from the queue (DocumentID ${d.id})`],
          };
        } else if (d) {
          obs = { at, attempts, status: expired ? 'not_observed' : 'pending', via: 'queue', in_queue: true, looked_in: people.get(item.id)?.size || 0, document_id: d.id, score: d.link_score, signals: d.link_signals };
        } else if (age >= delayH * HOUR && chartSearches < env('INTAKE_OBSERVE_PER_RUN', 40) && item.shadow?.would !== 'split') {
          // No queue trail: look in the candidates' charts.
          chartSearches++;
          try {
            const ps = await this.candidates(item);
            const claimed = new Set(store.list().map((i) => i.observed?.status === 'found' && `${i.observed.patient?.key}|${i.observed.document_id}`).filter(Boolean) as string[]);
            const fits: { r: DocRow; s: { score: number; signals: string[] } }[] = [];
            for (const key of ps.keys()) {
              if (!charts.has(key)) charts.set(key, await this.chartDocuments(key));
              for (const r of charts.get(key)!) {
                if (inQueue(r) || claimed.has(`${r.patientKey}|${r.id}`) || ledger.docs[r.id]?.item) continue;
                const s = chartScore(item, r, maxDays);
                if (s && s.score >= 3) fits.push({ r, s });
              }
            }
            fits.sort((a, b) => b.s.score - a.s.score);
            const best = fits[0];
            const tie = best && fits.some((f) => f !== best && f.s.score === best.s.score && f.r.patientKey !== best.r.patientKey);
            if (best && !tie) {
              obs = { at, attempts, status: 'found', via: 'chart', looked_in: ps.size, patient: ps.get(best.r.patientKey), ...(best.r.type ? { category: best.r.type } : {}), document_id: best.r.id, confidence: 'medium', score: best.s.score, signals: best.s.signals };
            } else {
              obs = { at, attempts, status: expired ? (tie ? 'ambiguous' : 'not_observed') : 'pending', via: 'chart', looked_in: ps.size, ...(tie ? { signals: ['two documents in different charts fit equally well'] } : {}) };
            }
          } catch (e) {
            out.errors++;
            obs = { at, attempts, status: expired ? 'not_observed' : 'error', looked_in: 0, error_code: codeOf(e, 'OBSERVE_FAILED') };
          }
        } else if (expired) {
          obs = { at, attempts, status: 'not_observed', looked_in: 0 };
        }
        if (!obs) continue;
        if (obs.status === 'found') out.found++;
        else if (obs.status === 'not_observed') out.not_observed++;
        else if (obs.status === 'pending') out.pending++;
        if (prev && prev.status === obs.status && prev.document_id === obs.document_id && obs.status === 'pending') {
          store.update(item.id, { observed: obs }); // no new history line while it waits
        } else {
          store.update(item.id, { observed: obs }, obs.status === 'found' ? `staff filing observed (${obs.via}, ${obs.confidence})` : obs.in_queue ? 'linked to the indexing queue' : `staff filing ${obs.status.replace('_', ' ')}`);
        }
      }

      // Forget documents older than the window plus the waiting time.
      const forget = now.getTime() - (windowDays + maxDays) * DAY;
      for (const [id, d] of Object.entries(ledger.docs)) if (Date.parse(d.last_seen) < forget) delete ledger.docs[id];
      ledgerFile.save(ledger);
      console.log(
        `[Intake] staff filing observer: queue ${out.queue}, linked ${out.linked}, indexed ${out.indexed}, found ${out.found}, waiting ${out.pending}, not observed ${out.not_observed}, errors ${out.errors}`
      );
      return out;
    } finally {
      this.running = false;
    }
  }

  /** Run every INTAKE_OBSERVE_EVERY_MIN minutes. Returns a stop function. */
  start(): () => void {
    const tick = () => {
      this.run().catch((e) => console.error(`[Intake] staff filing observer failed: ${codeOf(e, 'error')}`));
    };
    const timer = setInterval(tick, observeEveryMinutes() * 60_000);
    timer.unref?.();
    setTimeout(tick, 60_000).unref?.();
    return () => clearInterval(timer);
  }
}
