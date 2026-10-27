/**
 * Regenerate the checklist table in docs/drawbridge/HIPAA_TECHNICAL_SAFEGUARDS.md and the admin dashboard's data file
 * docs/drawbridge/hipaa-safeguards.json from the SAFEGUARDS list (src/platform/modules/compliance/safeguards.ts).
 * Evidence line numbers are looked up from their anchors, so run this after moving code.
 *
 *   npm run docs:hipaa            rewrite the block between the BEGIN/END markers, and the JSON
 *   npm run docs:hipaa -- --check exit 1 when the document or the JSON is out of date (smoke:hipaa does the same)
 */
import * as fs from 'fs';
import * as path from 'path';
import { CHECKLIST_BEGIN, CHECKLIST_END, CHECKLIST_JSON, checklistInDoc, checklistJson, checklistMarkdown } from '../platform/modules/compliance/safeguards';

const DOC = path.join(process.cwd(), 'docs', 'drawbridge', 'HIPAA_TECHNICAL_SAFEGUARDS.md');
const JSON_FILE = path.join(process.cwd(), CHECKLIST_JSON);

function main(): void {
  const doc = fs.readFileSync(DOC, 'utf8');
  const want = checklistMarkdown();
  const have = checklistInDoc(doc);
  if (have === null) throw new Error(`markers missing in ${DOC}`);
  const json = checklistJson();
  if (process.argv.includes('--check')) {
    const jsonHave = fs.existsSync(JSON_FILE) ? fs.readFileSync(JSON_FILE, 'utf8').replace(/\r\n/g, '\n') : '';
    const ok = have === want && jsonHave === json;
    console.log(ok ? 'OK checklist and JSON are current' : 'FAIL checklist or JSON is out of date: run npm run docs:hipaa');
    process.exitCode = ok ? 0 : 1;
    return;
  }
  const a = doc.indexOf(CHECKLIST_BEGIN) + CHECKLIST_BEGIN.length;
  const b = doc.indexOf(CHECKLIST_END);
  const eol = doc.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(DOC, `${doc.slice(0, a)}${eol}${want.replace(/\n/g, eol)}${eol}${doc.slice(b)}`);
  fs.writeFileSync(JSON_FILE, json);
  console.log(`checklist written (${want.split('\n').length - 4} rows), and ${CHECKLIST_JSON}`);
}

main();
