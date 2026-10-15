/**
 * Check the tamper-evidence hash chain of an audit day file (src/platform/audit.ts).
 *
 *   npm run audit:verify                        today's file in <AUDIT_DIR>/audit/
 *   npm run audit:verify -- 2026-10-15          one day
 *   npm run audit:verify -- /path/to/day.jsonl  a copied file (the day is read from the file name)
 *   npm run audit:verify -- --all               every day file on disk (after a restore from backup)
 *
 * Prints line counts and every break (line number and reason, never line contents). Exit 0 when
 * the chain is intact, 1 when it is broken or the file is missing/empty.
 */
import { auditDays, dayKey, verifyAuditDay } from '../platform/audit';

async function main(): Promise<void> {
  const arg = process.argv[2] || dayKey();
  const targets = arg === '--all' ? (await auditDays()).reverse() : [arg];
  if (!targets.length) {
    console.log('FAIL no audit day files found');
    process.exitCode = 1;
    return;
  }
  let failed = 0;
  for (const t of targets) {
    const r = await verifyAuditDay(t);
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.file}: ${r.lines} line(s), ${r.chained} chained, ${r.unchained} written before the chain`);
    for (const e of r.errors.slice(0, 50)) console.log(`  line ${e.line}: ${e.reason}`);
    if (r.errors.length > 50) console.log(`  ... ${r.errors.length - 50} more`);
  }
  if (targets.length > 1) console.log(`${targets.length - failed} of ${targets.length} day file(s) intact`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(`audit:verify failed: ${e?.code || e?.name || 'error'}`);
  process.exitCode = 2;
});
