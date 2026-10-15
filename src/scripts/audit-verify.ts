/**
 * Check the tamper-evidence hash chain of an audit day file (src/platform/audit.ts).
 *
 *   npm run audit:verify                        today's file in <AUDIT_DIR>/audit/
 *   npm run audit:verify -- 2026-10-15          one day
 *   npm run audit:verify -- /path/to/day.jsonl  a copied file (the day is read from the file name)
 *
 * Prints line counts and every break (line number and reason, never line contents). Exit 0 when
 * the chain is intact, 1 when it is broken or the file is missing/empty.
 */
import { dayKey, verifyAuditDay } from '../platform/audit';

async function main(): Promise<void> {
  const arg = process.argv[2] || dayKey();
  const r = await verifyAuditDay(arg);
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.file}: ${r.lines} line(s), ${r.chained} chained, ${r.unchained} written before the chain`);
  for (const e of r.errors.slice(0, 50)) console.log(`  line ${e.line}: ${e.reason}`);
  if (r.errors.length > 50) console.log(`  ... ${r.errors.length - 50} more`);
  process.exitCode = r.ok ? 0 : 1;
}

main().catch((e) => {
  console.error(`audit:verify failed: ${e?.code || e?.name || 'error'}`);
  process.exitCode = 2;
});
