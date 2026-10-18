/**
 * Delete the shadow week's copies now: at go-live, or when the clinic decides not to go ahead.
 *
 *   npm run intake:purge-shadow -- --yes
 *   (data-center container: node dist/scripts/intake-purge-shadow.js --yes)
 *
 * Stop the intake server first: it keeps items.json in memory and would write its own copy back.
 *
 * For every item from shadow mode that was never filed (a shadow decision, or read from the Veradigm® EHR
 * indexing queue), the original and its text are deleted and the patient details removed (store.ts
 * purgeShadow). What the shadow report needs stays, by ID only. Run `npm run eval:shadow` before this if the
 * report hasn't been saved yet. Prints counts only.
 */
import { intakeStore } from '../platform/modules/intake/store';

function main(): number {
  if (!process.argv.includes('--yes')) {
    console.error('Deletes every shadow-week copy now. Stop the intake server, save the shadow report, then run again with --yes.');
    return 2;
  }
  const store = intakeStore();
  const before = store.list().filter((i) => !i.purged_at && (i.shadow || i.source === 'veradigm_queue') && i.status !== 'filed' && i.status !== 'sent_to_indexing').length;
  const purged = store.purgeShadow(0);
  console.log(`Shadow-week copies deleted: ${purged} of ${before}.`);
  return purged === before ? 0 : 1;
}

process.exitCode = main();
