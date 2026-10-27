import * as fs from 'fs';
import * as path from 'path';
import { UnityActions } from '../../../unity/config/unity-endpoints';
import { pick, unityRows } from '../../../unity/utils/unity-rows';
import { maxFileBytes } from './folder';
import { inQueue, listQueueShared, MIN_POLL_MINUTES, parseDocRows, queueType, type DocRow } from './observe';
import { readOnlyUnity, shadowMode } from './shadow';
import { queueRef, type IntakeStore } from './store';

/**
 * Shadow-week document source: the clinic's own Veradigm® EHR "(ready for indexing)" queue, read-only.
 *
 * The clinic changes nothing for the shadow week. Faxes and lab files keep arriving in the queue and staff
 * keep indexing them as today. Drawbridge lists the waiting documents (GetDocumentsByDocumentType: the queue
 * type, PatientID blank, a date window), fetches each new one (GetDocumentImage, PDF; at most once when it
 * succeeds, retried with backoff when it fails) and runs it through the normal intake pipeline, which in shadow
 * mode only records what it WOULD have done. The staff filing observer (observe.ts) then follows the very same
 * DocumentID into the chart staff put it in: exact ground truth.
 *
 * Shadow mode only. In live mode the source never starts, and a document read from the queue can never be
 * filed (file.ts filingPreconditions): it is already in Veradigm® EHR, and saving a copy would leave the
 * original waiting in the queue as a duplicate. At go-live, documents reach Drawbridge before the queue
 * (MOATiT Fax, lab drop folder) instead.
 *
 * One source per document: the queue source refuses to start while another source of the same documents is
 * configured (INTAKE_WATCH_DIRS, the MOATiT Fax webhook), because a second copy of a queued document can't be
 * tied to it reliably and would muddle the shadow week's ground truth.
 *
 * The copies Drawbridge keeps of queued documents are PHI on Drawbridge's server: shadow-mode retention
 * (store.ts purgeShadow, INTAKE_SHADOW_RETENTION_DAYS) removes them, and `npm run intake:purge-shadow` removes
 * them at once at go-live or when the clinic decides not to go ahead.
 *
 *   INTAKE_QUEUE_SOURCE         on | off (default off). Needs INTAKE_MODE=shadow and live Veradigm® access.
 *   INTAKE_QUEUE_EVERY_MIN      run interval (default 10; Veradigm's 2-minute polling floor is enforced)
 *   INTAKE_QUEUE_WINDOW_DAYS    documents that arrived this many days back are taken in (default 3; the first run backfills it)
 *   INTAKE_QUEUE_PER_RUN        image fetches per run, failures included (default 25; the rest wait for the next run)
 *   INTAKE_OBSERVE_QUEUE_TYPE   the queue's type ID or name (shared with the observer; default -1000999)
 *
 * Every call goes through readOnlyUnity (only the shadow read actions run). The queue listing is shared with
 * the observer (observe.ts listQueueShared). Logs carry counts and codes only: never document names, authors
 * or patient details.
 */

const env = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const on = (k: string) => /^(on|true|1|yes)$/i.test(String(process.env[k] || '').trim());
const set = (k: string) => !!String(process.env[k] || '').trim();

export type QueueSourceState = 'off' | 'on' | 'refused_live' | 'refused_mixed';

/** Whether the queue source may run: asked for, only in shadow mode, and as the only source of these documents. */
export function queueSourceState(): QueueSourceState {
  if (!on('INTAKE_QUEUE_SOURCE')) return 'off';
  if (!shadowMode()) return 'refused_live';
  if (set('INTAKE_WATCH_DIRS') || set('MOATIT_FAX_WEBHOOK_SECRET')) return 'refused_mixed';
  return 'on';
}

let pollWarned = false;
export function queueEveryMinutes(): number {
  const want = env('INTAKE_QUEUE_EVERY_MIN', 10);
  if (want >= MIN_POLL_MINUTES) return want;
  if (!pollWarned) {
    pollWarned = true;
    console.warn(`[Intake] INTAKE_QUEUE_EVERY_MIN=${want} is below Veradigm's 2-minute polling floor; using ${MIN_POLL_MINUTES}`);
  }
  return MIN_POLL_MINUTES;
}

/** Image fetch attempts per document before it is passed over (logged as a count). */
export const MAX_FETCH_TRIES = 5;
const RETRY_BASE_MS = 10 * 60_000;

type UnityLike = { executeAction: (action: string, params?: any, patientId?: string, target?: any) => Promise<any> };

export interface QueueSourceOptions {
  store: () => IntakeStore;
  unity: UnityLike;
  /** Called with each new item ID (the pipeline's enqueue). */
  onAdded: (id: string) => void;
  now?: () => Date;
}

export interface QueueRunResult {
  /** Documents waiting in the queue in the window. */
  queue: number;
  /** New items created this run. */
  added: number;
  /** Waiting documents already taken in, passed over, or waiting for a retry. */
  known: number;
  /** New documents left for the next run (per-run cap). */
  deferred: number;
  /** Fetched but not taken in (empty, too large, same file as an earlier item), or given up after MAX_FETCH_TRIES. */
  skipped: number;
  errors: number;
  /** Set when the run was refused (live mode, mixed sources) or the listing failed. */
  error_code?: string;
}

/** What the source remembers between runs and restarts (<intake dir>/queue-source.json; DocumentIDs only). */
interface SourceState {
  /** DocumentID → why it was passed over (no PHI: a reason code). */
  passed: Record<string, string>;
  /** DocumentID → failed fetches and when the next try is due (ms). */
  failures: Record<string, { n: number; next: number }>;
}

class StateFile {
  constructor(readonly file: string) {}
  load(): SourceState {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { passed: v?.passed && typeof v.passed === 'object' ? v.passed : {}, failures: v?.failures && typeof v.failures === 'object' ? v.failures : {} };
    } catch {
      return { passed: {}, failures: {} };
    }
  }
  save(s: SourceState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.unlinkSync(tmp);
    } catch {
      // none
    }
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }
}

const DAY = 86_400_000;
const codeOf = (e: any, d: string) => String(e?.code || d).replace(/[^\w]/g, '').slice(0, 40);
const ehrZone = () => process.env.INTAKE_EHR_TIMEZONE || process.env.CLINIC_TIMEZONE || 'America/Boise';
const fmtDay = (t: number) => new Intl.DateTimeFormat('en-US', { timeZone: ehrZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

export class QueueSource {
  private unity: UnityLike;
  private running = false;

  constructor(private opts: QueueSourceOptions) {
    // Whatever is passed in, only the shadow read actions run.
    this.unity = readOnlyUnity(opts.unity);
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private async call(action: string, params: Record<string, string>, patientId: string): Promise<any> {
    const res = await this.unity.executeAction(action, params, patientId, 'EHR');
    if (!res || !res.success) throw Object.assign(new Error(`${action} failed`), { code: `${action.toUpperCase()}_FAILED` });
    return res.data;
  }

  /** Documents waiting in the queue that arrived in the window, oldest first (one listing shared with the observer). */
  async waiting(now: number): Promise<DocRow[]> {
    const list = async (from: number, to: number) =>
      parseDocRows(await this.call(UnityActions.Document.GET_DOCUMENTS_BY_DOCUMENT_TYPE, { Parameter1: queueType(), Parameter2: '', Parameter3: fmtDay(from), Parameter4: fmtDay(to) }, ''));
    const since = now - env('INTAKE_QUEUE_WINDOW_DAYS', 3) * DAY;
    return (await listQueueShared(this.opts.unity, list, now))
      .filter((d) => inQueue(d) && (!Number.isFinite(d.when) || d.when >= since))
      .sort((a, b) => (Number.isFinite(a.when) ? a.when : 0) - (Number.isFinite(b.when) ? b.when : 0));
  }

  /** The whole document as PDF (the format the sandbox serves reliably). */
  async image(doc: DocRow): Promise<Buffer> {
    const rows = unityRows(await this.call(UnityActions.Document.GET_DOCUMENT_IMAGE, { Parameter1: doc.id, Parameter2: 'Scan', Parameter3: 'PDF', Parameter4: 'N' }, doc.patientKey || ''));
    const b64 = pick(rows[0], 'base64image', 'Base64Image', 'image');
    if (!b64) throw Object.assign(new Error('no image'), { code: 'NO_IMAGE' });
    return Buffer.from(b64, 'base64');
  }

  async run(): Promise<QueueRunResult> {
    const out: QueueRunResult = { queue: 0, added: 0, known: 0, deferred: 0, skipped: 0, errors: 0 };
    const state = queueSourceState();
    if (state === 'refused_live') return { ...out, error_code: 'QUEUE_SOURCE_LIVE_MODE' };
    if (state === 'refused_mixed') return { ...out, error_code: 'QUEUE_SOURCE_MIXED_SOURCES' };
    if (this.running) return out;
    this.running = true;
    try {
      const store = this.opts.store();
      const now = this.now().getTime();
      let docs: DocRow[];
      try {
        docs = await this.waiting(now);
      } catch (e) {
        out.errors++;
        out.error_code = codeOf(e, 'QUEUE_FAILED');
        console.error(`[Intake] queue source: listing failed (${out.error_code})`);
        return out;
      }
      out.queue = docs.length;
      const file = new StateFile(path.join(store.dir, 'queue-source.json'));
      const mem = file.load();
      const cap = env('INTAKE_QUEUE_PER_RUN', 25);
      const max = maxFileBytes();
      let fetches = 0;
      let gaveUp = 0;
      for (const d of docs) {
        const failed = mem.failures[d.id];
        if (mem.passed[d.id] || store.findBySourceRef(queueRef(d.id)) || (failed && failed.next > now)) {
          out.known++;
          continue;
        }
        if (fetches >= cap) {
          out.deferred++;
          continue;
        }
        fetches++;
        let data: Buffer;
        try {
          data = await this.image(d);
        } catch (e) {
          out.errors++;
          const n = (failed?.n || 0) + 1;
          if (n >= MAX_FETCH_TRIES) {
            delete mem.failures[d.id];
            mem.passed[d.id] = `fetch_failed_${codeOf(e, 'error')}`.slice(0, 48);
            gaveUp++;
          } else {
            mem.failures[d.id] = { n, next: now + RETRY_BASE_MS * 2 ** (n - 1) };
          }
          continue;
        }
        delete mem.failures[d.id];
        if (!data.length || data.length > max) {
          mem.passed[d.id] = data.length ? 'too_large' : 'empty';
          out.skipped++;
          continue;
        }
        const r = store.addDocument({ source: 'veradigm_queue', source_ref: queueRef(d.id), name: `queue-${d.id}.pdf`, mime: 'application/pdf', data });
        if (r.duplicate) {
          mem.passed[d.id] = 'same_file_as_earlier_item';
          out.skipped++;
          continue;
        }
        if (Number.isFinite(d.when)) store.update(r.item.id, { queue_at: new Date(d.when).toISOString() });
        out.added++;
        this.opts.onAdded(r.item.id);
      }
      out.skipped += gaveUp;
      // Forget DocumentIDs no longer waiting in the window (indexed by staff, or older): they are never listed again.
      const listed = new Set(docs.map((d) => d.id));
      for (const id of Object.keys(mem.passed)) if (!listed.has(id)) delete mem.passed[id];
      for (const id of Object.keys(mem.failures)) if (!listed.has(id)) delete mem.failures[id];
      file.save(mem);
      if (out.added || out.deferred || out.errors) {
        console.log(`[Intake] queue source: ${out.queue} waiting, ${out.added} new, ${out.deferred} next run, ${out.skipped} skipped (${gaveUp} given up), ${out.errors} error(s)`);
      }
      return out;
    } finally {
      this.running = false;
    }
  }

  /** Run every INTAKE_QUEUE_EVERY_MIN minutes (first run after 20 s). Returns a stop function. */
  start(): () => void {
    const tick = () => {
      this.run().catch((e) => console.error(`[Intake] queue source failed: ${codeOf(e, 'error')}`));
    };
    const timer = setInterval(tick, queueEveryMinutes() * 60_000);
    timer.unref?.();
    const first = setTimeout(tick, 20_000);
    first.unref?.();
    return () => {
      clearInterval(timer);
      clearTimeout(first);
    };
  }
}
