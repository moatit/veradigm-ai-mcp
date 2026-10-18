import { UnityActions } from '../../../unity/config/unity-endpoints';
import { pick, unityRows } from '../../../unity/utils/unity-rows';
import { maxFileBytes } from './folder';
import { inQueue, MIN_POLL_MINUTES, parseDocRows, queueType, type DocRow } from './observe';
import { readOnlyUnity, shadowMode } from './shadow';
import { queueRef, type IntakeStore } from './store';

/**
 * Shadow-week document source: the clinic's own Veradigm® EHR "(ready for indexing)" queue, read-only.
 *
 * The clinic changes nothing for the shadow week. Faxes and lab files keep arriving in the queue and staff
 * keep indexing them as today. Drawbridge lists the waiting documents (GetDocumentsByDocumentType: the queue
 * type, PatientID blank, a date window), fetches each new one once (GetDocumentImage, PDF) and runs it through
 * the normal intake pipeline, which in shadow mode only records what it WOULD have done. The staff filing
 * observer (observe.ts) then follows the very same DocumentID into the chart staff put it in: exact ground truth.
 *
 * Shadow mode only. In live mode the source never starts, and a document read from the queue can never be
 * filed (file.ts filingPreconditions): it is already in Veradigm® EHR, and saving a copy would leave the
 * original waiting in the queue as a duplicate. At go-live, documents reach Drawbridge before the queue
 * (MOATiT Fax, lab drop folder) instead.
 *
 *   INTAKE_QUEUE_SOURCE         on | off (default off). Needs INTAKE_MODE=shadow and live Veradigm® access.
 *   INTAKE_QUEUE_EVERY_MIN      run interval (default 10; Veradigm's 2-minute polling floor is enforced)
 *   INTAKE_QUEUE_WINDOW_DAYS    queue listing covers this many days back (default 3; the first run backfills it)
 *   INTAKE_QUEUE_PER_RUN        documents fetched per run (default 25; the rest wait for the next run)
 *   INTAKE_OBSERVE_QUEUE_TYPE   the queue's type ID or name (shared with the observer; default -1000999)
 *
 * Every call goes through readOnlyUnity (only the shadow read actions run). Logs carry counts and codes only:
 * never document names, authors or patient details.
 */

const env = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const on = (k: string) => /^(on|true|1|yes)$/i.test(String(process.env[k] || '').trim());

export type QueueSourceState = 'off' | 'on' | 'refused_live';

/** Whether the queue source may run: asked for, and only ever in shadow mode. */
export function queueSourceState(): QueueSourceState {
  if (!on('INTAKE_QUEUE_SOURCE')) return 'off';
  return shadowMode() ? 'on' : 'refused_live';
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
  /** Waiting documents already taken in on an earlier run. */
  known: number;
  /** New documents left for the next run (per-run cap). */
  deferred: number;
  /** Fetched but not taken in: empty, too large, or the same file as an earlier item. */
  skipped: number;
  errors: number;
  /** Set when the run was refused (live mode) or the listing failed. */
  error_code?: string;
}

const DAY = 86_400_000;
const codeOf = (e: any, d: string) => String(e?.code || d).replace(/[^\w]/g, '').slice(0, 40);
const ehrZone = () => process.env.INTAKE_EHR_TIMEZONE || process.env.CLINIC_TIMEZONE || 'America/Boise';
const fmtDay = (t: number) => new Intl.DateTimeFormat('en-US', { timeZone: ehrZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

export class QueueSource {
  private unity: UnityLike;
  private running = false;
  /** DocumentIDs fetched and not taken in (empty, too large, same file as an earlier item): not fetched again by this process. */
  private passed = new Set<string>();

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

  /** Documents waiting in the queue, oldest first. */
  async waiting(from: number, to: number): Promise<DocRow[]> {
    const rows = parseDocRows(await this.call(UnityActions.Document.GET_DOCUMENTS_BY_DOCUMENT_TYPE, { Parameter1: queueType(), Parameter2: '', Parameter3: fmtDay(from), Parameter4: fmtDay(to) }, ''));
    return rows.filter((d) => inQueue(d)).sort((a, b) => (Number.isFinite(a.when) ? a.when : 0) - (Number.isFinite(b.when) ? b.when : 0));
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
    if (!shadowMode()) return { ...out, error_code: 'QUEUE_SOURCE_LIVE_MODE' };
    if (this.running) return out;
    this.running = true;
    try {
      const store = this.opts.store();
      const now = this.now().getTime();
      let docs: DocRow[];
      try {
        docs = await this.waiting(now - env('INTAKE_QUEUE_WINDOW_DAYS', 3) * DAY, now);
      } catch (e) {
        out.errors++;
        out.error_code = codeOf(e, 'QUEUE_FAILED');
        console.error(`[Intake] queue source: listing failed (${out.error_code})`);
        return out;
      }
      out.queue = docs.length;
      const cap = env('INTAKE_QUEUE_PER_RUN', 25);
      const max = maxFileBytes();
      for (const d of docs) {
        if (this.passed.has(d.id) || store.findBySourceRef(queueRef(d.id))) {
          out.known++;
          continue;
        }
        if (out.added + out.skipped >= cap) {
          out.deferred++;
          continue;
        }
        let data: Buffer;
        try {
          data = await this.image(d);
        } catch (e) {
          out.errors++; // not recorded: tried again next run
          continue;
        }
        if (!data.length || data.length > max) {
          this.passed.add(d.id);
          out.skipped++;
          continue;
        }
        const r = store.addDocument({ source: 'veradigm_queue', source_ref: queueRef(d.id), name: `queue-${d.id}.pdf`, mime: 'application/pdf', data });
        if (r.duplicate) {
          this.passed.add(d.id);
          out.skipped++;
          continue;
        }
        out.added++;
        this.opts.onAdded(r.item.id);
      }
      if (out.added || out.deferred || out.errors) {
        console.log(`[Intake] queue source: ${out.queue} waiting, ${out.added} new, ${out.deferred} next run, ${out.skipped} skipped, ${out.errors} error(s)`);
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
    setTimeout(tick, 20_000).unref?.();
    return () => clearInterval(timer);
  }
}
