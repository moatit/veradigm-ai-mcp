/**
 * Regenerate the checklist table in docs/drawbridge/HIPAA_TECHNICAL_SAFEGUARDS.md from the SAFEGUARDS list
 * (src/platform/modules/compliance/safeguards.ts), the same list the "HIPAA & Compliance" staff page shows.
 * Evidence line numbers are looked up from their anchors, so run this after moving code.
 *
 *   npm run docs:hipaa            rewrite the block between the BEGIN/END markers
 *   npm run docs:hipaa -- --check exit 1 when the document is out of date (smoke:hipaa does the same)
 */
import * as fs from 'fs';
import * as path from 'path';
import { CHECKLIST_BEGIN, CHECKLIST_END, checklistInDoc, checklistMarkdown } from '../platform/modules/compliance/safeguards';

const DOC = path.join(process.cwd(), 'docs', 'drawbridge', 'HIPAA_TECHNICAL_SAFEGUARDS.md');

function main(): void {
  const doc = fs.readFileSync(DOC, 'utf8');
  const want = checklistMarkdown();
  const have = checklistInDoc(doc);
  if (have === null) throw new Error(`markers missing in ${DOC}`);
  if (process.argv.includes('--check')) {
    console.log(have === want ? 'OK checklist is current' : 'FAIL checklist is out of date: run npm run docs:hipaa');
    process.exitCode = have === want ? 0 : 1;
    return;
  }
  const a = doc.indexOf(CHECKLIST_BEGIN) + CHECKLIST_BEGIN.length;
  const b = doc.indexOf(CHECKLIST_END);
  const eol = doc.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(DOC, `${doc.slice(0, a)}${eol}${want.replace(/\n/g, eol)}${eol}${doc.slice(b)}`);
  console.log(`checklist written (${want.split('\n').length - 4} rows)`);
}

main();
