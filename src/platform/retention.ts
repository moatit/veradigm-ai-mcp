/**
 * Retention jobs: each store's prune runs once at startup and then every 24 hours.
 *
 *   CALL_RECORDS_RETENTION_DAYS   on-call call records (default 30), by last update
 *   OUTREACH_RETENTION_DAYS       outreach jobs (default 30), by last update; the opt-out list is kept
 *   INTAKE_RETENTION_DAYS         intake originals of filed / sent-to-indexing documents (default 30)
 *   INTAKE_RECORD_RETENTION_DAYS  patient details on those intake records (default 90; IDs, hash and history stay)
 *   AUDIT_RETENTION_DAYS          audit day files (default 2190 = 6 years; audit.ts, at the first write of each day)
 * Deletion is a file unlink on the encrypted data volume; the media itself is disposed of by destroying the volume
 * and its key (crypto-erase; docs/drawbridge/HIPAA_TECHNICAL_SAFEGUARDS.md).
 */
export function retentionDaysFrom(name: string, fallback = 30): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

const DAY_MS = 86_400_000;
const running = new Map<string, () => void>();

/**
 * Run `prune` now and every day. `prune` returns how many items it removed (logged when > 0).
 * Never throws; restarting the same job replaces the old timer. Returns a stop function.
 */
export function startDailyRetention(name: string, prune: () => number | Promise<number>): () => void {
  running.get(name)?.();
  const run = async () => {
    try {
      const removed = await prune();
      if (removed) console.log(`[Drawbridge] ${name} retention: removed ${removed}`);
    } catch (e: any) {
      console.error(`[Drawbridge] ${name} retention failed: ${e?.code || e?.name || 'error'}`);
    }
  };
  void run();
  const timer = setInterval(run, DAY_MS);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    running.delete(name);
  };
  running.set(name, stop);
  return stop;
}
