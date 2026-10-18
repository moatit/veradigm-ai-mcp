/**
 * Delete the shadow week's copies now: at go-live, or when the clinic decides not to go ahead.
 *
 *   npm run intake:purge-shadow -- --yes
 *   (data-center container: node dist/scripts/intake-purge-shadow.js --yes)
 *
 * Refused while the intake server runs (server-lock.ts): it keeps items.json in memory and would write its
 * own copy back. Stop it first.
 *
 * For every item from shadow mode that was never filed (a shadow decision, or read from the Veradigm® EHR
 * indexing queue), the original and its text are deleted and the patient details removed (store.ts
 * purgeShadow). The staff filing observer's ledger (observer.json) keeps DocumentIDs, times and links only:
 * queue display names and authors, which can carry patient names, are cleared. The queue source's state
 * (queue-source.json) is deleted. What the shadow report needs stays, by ID only. Run `npm run eval:shadow`
 * before this if the report hasn't been saved yet. Prints counts only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { serverRunning } from '../platform/modules/intake/server-lock';
import { intakeDir, intakeStore } from '../platform/modules/intake/store';

function scrubLedger(dir: string): number {
  const file = path.join(dir, 'observer.json');
  let ledger: any;
  try {
    ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 0;
  }
  let n = 0;
  for (const d of Object.values<any>(ledger?.docs || {})) {
    if (d.display || d.author) n++;
    d.display = '';
    d.author = '';
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return n;
}

function main(): number {
  const dir = intakeDir();
  if (!process.argv.includes('--yes')) {
    console.error('Deletes every shadow-week copy now. Stop the intake server, save the shadow report, then run again with --yes.');
    return 2;
  }
  if (serverRunning(dir)) {
    console.error('The intake server is running (it keeps the store in memory and would write its copy back). Stop it, then run again.');
    return 3;
  }
  const store = intakeStore();
  const before = store.list().filter((i) => !i.purged_at && (i.shadow || i.source === 'veradigm_queue') && i.status !== 'filed' && i.status !== 'sent_to_indexing').length;
  const purged = store.purgeShadow(0);
  const scrubbed = scrubLedger(dir);
  try {
    fs.unlinkSync(path.join(dir, 'queue-source.json'));
  } catch {
    // none
  }
  console.log(`Shadow-week copies deleted: ${purged} of ${before}. Queue names cleared from the observer ledger: ${scrubbed}.`);
  return purged === before ? 0 : 1;
}

process.exitCode = main();
