import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { OutreachEvent, OutreachJob, OutreachStatus } from './types';

/**
 * Outreach job store (file-backed JSON, same pattern as the on-call call-record store).
 *
 * Jobs hold a patient's first name, phone number and appointment/recall details, so the file
 * must live on the MOATiT-controlled host only (CALL_RECORDS_DIR), never in the repo, logs or
 * a shared drive. Written with mode 0600 via temp file + rename (atomic on the same volume).
 * Replace with the production database once open question Q5/Q6 is decided.
 */
interface StoreFile {
  jobs: OutreachJob[];
  /** Veradigm® PM patient IDs that asked not to be called again. */
  opted_out: string[];
}

const dir = () => process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data');
const file = () => path.join(dir(), 'outreach-jobs.json');

let cache: { jobs: Map<string, OutreachJob>; optedOut: Set<string>; file: string } | null = null;

function load(): NonNullable<typeof cache> {
  // Re-load if CALL_RECORDS_DIR changed (tests point it at a temp folder).
  if (cache && cache.file === file()) return cache;
  cache = { jobs: new Map(), optedOut: new Set(), file: file() };
  try {
    const data: StoreFile = JSON.parse(fs.readFileSync(cache.file, 'utf8'));
    for (const j of data.jobs || []) cache.jobs.set(j.id, j);
    for (const p of data.opted_out || []) cache.optedOut.add(p);
  } catch {
    // No file yet: start empty.
  }
  return cache;
}

function persist(): void {
  const c = load();
  const data: StoreFile = { jobs: [...c.jobs.values()], opted_out: [...c.optedOut] };
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${c.file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, c.file);
}

const now = () => new Date().toISOString();

export type NewJob = Omit<OutreachJob, 'id' | 'attempts' | 'events' | 'created_at' | 'updated_at' | 'status'> & {
  status?: OutreachStatus;
};

export const outreachJobs = {
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

  /** Add several jobs in one write (generators). */
  addMany(items: NewJob[], by: string): OutreachJob[] {
    const c = load();
    const t = now();
    const created = items.map((item) => {
      const job: OutreachJob = {
        ...item,
        id: randomUUID(),
        status: item.status || 'proposed',
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

  /** Apply a change to one job and save. The mutator may return false to skip saving. */
  update(id: string, by: string, action: string, mutate: (j: OutreachJob) => void, detail?: string): OutreachJob {
    const c = load();
    const job = c.jobs.get(id);
    if (!job) throw new Error(`Outreach job ${id} not found`);
    mutate(job);
    const ev: OutreachEvent = { at: now(), by, action };
    if (detail) ev.detail = detail;
    job.events.push(ev);
    job.events = job.events.slice(-50);
    job.updated_at = ev.at;
    persist();
    return job;
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

  /** Store file path (shown to nobody; used by tests). */
  filePath(): string {
    return file();
  },
};
