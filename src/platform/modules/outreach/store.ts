import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DailyList, OutreachEvent, OutreachJob, OutreachStatus, Projection } from './types';

/**
 * Call & Confirm store (file-backed JSON, same pattern as the on-call call-record store).
 *
 * Jobs hold a patient's first name, phone number and appointment/recall details, so the file
 * must live on the MOATiT-controlled host only (CALL_RECORDS_DIR), never in the repo, logs or
 * a shared drive. Written with mode 0600 via temp file + rename (atomic on the same volume).
 * Replace with the production database once open question Q5/Q6 is decided.
 * Jobs not updated for OUTREACH_RETENTION_DAYS (default 30) are deleted by prune(), run at startup
 * and daily (src/platform/retention.ts). The opt-out list (patient IDs only) is kept.
 *
 * createJobStore({ memory: true }) gives an in-memory store with the same API: the simulator and
 * the test calls use one, so they never touch real jobs.
 */
interface StoreFile {
  jobs: OutreachJob[];
  /** Veradigm® PM patient IDs that asked not to be called again. */
  opted_out: string[];
  /** Daily call lists by date (YYYY-MM-DD). */
  lists?: Record<string, DailyList>;
  projection?: Projection;
}

export type NewJob = Omit<OutreachJob, 'id' | 'attempts' | 'events' | 'created_at' | 'updated_at' | 'status' | 'plan'> & {
  status?: OutreachStatus;
  plan?: OutreachJob['plan'];
};

interface Data {
  jobs: Map<string, OutreachJob>;
  optedOut: Set<string>;
  lists: Map<string, DailyList>;
  projection?: Projection;
}

/** Jobs written before Call & Confirm (Oct 24, 2026): "reminder" → "confirm", proposed/failed → scheduled. */
function migrate(j: any): OutreachJob {
  if (j.type === 'reminder') j.type = 'confirm';
  if (j.status === 'proposed' || j.status === 'failed') j.status = 'scheduled';
  if (!Array.isArray(j.plan)) j.plan = [];
  return j as OutreachJob;
}

export function createJobStore(opts: { memory: true } | { file: () => string }) {
  let cache: (Data & { file: string }) | null = null;
  const fileOf = () => ('file' in opts ? opts.file() : ':memory:');

  function load(): Data & { file: string } {
    // Re-load if the file path changed (tests point CALL_RECORDS_DIR at a temp folder).
    if (cache && cache.file === fileOf()) return cache;
    cache = { jobs: new Map(), optedOut: new Set(), lists: new Map(), file: fileOf() };
    if ('file' in opts) {
      try {
        const data: StoreFile = JSON.parse(fs.readFileSync(cache.file, 'utf8'));
        for (const j of data.jobs || []) cache.jobs.set(j.id, migrate(j));
        for (const p of data.opted_out || []) cache.optedOut.add(p);
        for (const [d, l] of Object.entries(data.lists || {})) cache.lists.set(d, l);
        cache.projection = data.projection;
      } catch {
        // No file yet: start empty.
      }
    }
    return cache;
  }

  function persist(): void {
    const c = load();
    if (!('file' in opts)) return;
    const data: StoreFile = {
      jobs: [...c.jobs.values()],
      opted_out: [...c.optedOut],
      lists: Object.fromEntries(c.lists),
      projection: c.projection,
    };
    fs.mkdirSync(path.dirname(c.file), { recursive: true });
    const tmp = `${c.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, c.file);
  }

  const now = () => new Date().toISOString();

  return {
    list(): OutreachJob[] {
      return [...load().jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    },

    get(id: string): OutreachJob | undefined {
      return load().jobs.get(id);
    },

    findByCallId(callId: string): OutreachJob | undefined {
      if (!callId) return undefined;
      return [...load().jobs.values()].find((j) => j.retell_call_id === callId);
    },

    findByDedupeKey(key: string): OutreachJob | undefined {
      return [...load().jobs.values()].find((j) => j.dedupe_key === key);
    },

    /** All jobs of one patient (the per-patient call limits span every call type). */
    byPatient(patientId: string): OutreachJob[] {
      return [...load().jobs.values()].filter((j) => j.patient_ref.id === patientId);
    },

    /** Add several jobs in one write (list builders). `at` = creation time (simulated clock). */
    addMany(items: NewJob[], by: string, at: Date = new Date()): OutreachJob[] {
      const c = load();
      const t = at.toISOString();
      const created = items.map((item) => {
        const job: OutreachJob = {
          ...item,
          id: randomUUID(),
          status: item.status || 'scheduled',
          plan: item.plan || [],
          attempts: 0,
          events: [{ at: t, by, action: 'created', detail: item.status === 'skipped' ? item.notes : undefined }],
          created_at: t,
          updated_at: t,
        };
        c.jobs.set(job.id, job);
        return job;
      });
      if (created.length) persist();
      return created;
    },

    /** Apply a change to one job and save. */
    update(id: string, by: string, action: string, mutate: (j: OutreachJob) => void, detail?: string, at: Date = new Date()): OutreachJob {
      const c = load();
      const job = c.jobs.get(id);
      if (!job) throw new Error(`Outreach job ${id} not found`);
      mutate(job);
      const ev: OutreachEvent = { at: at.toISOString(), by, action };
      if (detail) ev.detail = detail;
      job.events.push(ev);
      job.events = job.events.slice(-50);
      job.updated_at = ev.at;
      persist();
      return job;
    },

    /** Delete jobs whose last update is older than `days` days. Returns how many were removed. */
    prune(days: number, nowMs: number = Date.now()): number {
      const cutoff = nowMs - days * 86_400_000;
      const c = load();
      let removed = 0;
      for (const [id, j] of c.jobs) {
        const t = Date.parse(j.updated_at || j.created_at);
        if (Number.isFinite(t) && t < cutoff) {
          c.jobs.delete(id);
          removed++;
        }
      }
      const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
      for (const d of [...c.lists.keys()]) {
        if (d < cutoffDay) {
          c.lists.delete(d);
          removed++;
        }
      }
      if (removed) persist();
      return removed;
    },

    isOptedOut(patientId: string): boolean {
      return load().optedOut.has(patientId);
    },

    optOut(patientId: string): void {
      const c = load();
      if (c.optedOut.has(patientId)) return;
      c.optedOut.add(patientId);
      persist();
    },

    optedOutCount(): number {
      return load().optedOut.size;
    },

    getList(date: string): DailyList | undefined {
      return load().lists.get(date);
    },

    saveList(list: DailyList): void {
      load().lists.set(list.date, list);
      persist();
    },

    getProjection(): Projection | undefined {
      return load().projection;
    },

    saveProjection(p: Projection): void {
      load().projection = p;
      persist();
    },

    /** Appointment IDs on the Unconfirmed list (confirm jobs whose every attempt went unanswered). */
    unconfirmedAppointmentIds(): Set<string> {
      return new Set(
        [...load().jobs.values()].filter((j) => j.type === 'confirm' && j.status === 'unconfirmed' && j.appointment?.id).map((j) => j.appointment!.id)
      );
    },

    /** Store file path (shown to nobody; used by tests). */
    filePath(): string {
      return fileOf();
    },
  };
}

export type JobStore = ReturnType<typeof createJobStore>;

const dir = () => process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data');

/** The real store: $CALL_RECORDS_DIR/outreach-jobs.json. */
export const outreachJobs: JobStore = createJobStore({ file: () => path.join(dir(), 'outreach-jobs.json') });
