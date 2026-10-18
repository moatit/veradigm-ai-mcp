/**
 * Offline checks for intake shadow mode (no network beyond 127.0.0.1, no credentials, made-up
 * patients and a fake roster only): the roster CSV (header variants, merge, skip, failures), roster
 * matching with the same decision table, categories from a list and the live-first fallback, the
 * read-only Veradigm guards, the shadow pipeline (live search and roster; filing impossible whatever
 * INTAKE_FILING says; batch split), the Confirm panel and queue filters, the report (counts only,
 * wrong-patient detection, leak check, per-document file), the bulk importer, read-in-place watched
 * folders, named staff logins and the shadow server.
 *
 *   npm run smoke:intake-shadow   (also part of npm run smoke:intake)
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-shadow-'));
process.env.CALL_RECORDS_DIR = TMP;
process.env.INTAKE_DROP_DIR = path.join(TMP, 'inbox-server');
process.env.CLINIC_TIMEZONE = 'America/Boise';
for (const k of [
  'MOATIT_FAX_WEBHOOK_SECRET', 'MOATIT_FAX_BASE_URL', 'MOATIT_FAX_API_KEY', 'INTAKE_FILING', 'INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED', 'INTAKE_OCR_MIN_CONFIDENCE',
  'INTAKE_MODE', 'INTAKE_ROSTER_CSV', 'INTAKE_CATEGORIES_CSV', 'INTAKE_WATCH_DIRS', 'INTAKE_WATCH_SINCE', 'INTAKE_BATCH_SENDERS', 'INTAKE_NO_AUTO_SENDERS',
  'INTAKE_SPLIT', 'INTAKE_CATEGORY_MAP', 'DRAWBRIDGE_USERS_FILE', 'DRAWBRIDGE_USERNAME', 'DRAWBRIDGE_PASSWORD', 'ONCALL_USERNAME', 'ONCALL_PASSWORD',
]) {
  delete process.env[k];
}
process.env.INTAKE_OCR_URL = 'off';

import assert from 'assert';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import type { AddressInfo } from 'net';

const NOW = new Date('2026-10-11T15:00:00Z');

// ── Synthetic data (made-up people, 555 numbers) ─────────────────────────────
const ROSTER = `"Last Name","First Name","Middle","DOB","MRN","Patient Number","Chart ID","Home Phone","Cell Phone"
Testpatient,Marigold,J,03/14/1961,00482913,E-48291,7001,(208) 555-0142,
Zephyr,Quillon,,1958-07-02,771234,,7002,208-555-0177,
Lightfoot,Orrin,B,9/5/1949,330017,,7003,,2085550199
Twinly,Dana,,01/02/1990,500001,,7004,,
Twinly,Dana,,01/02/1990,500002,,7005,,
"Testpatient","Marigold","J","03/14/1961","00482913","","7001","","(208) 555-0143"
,,,,,,,,
Nodate,Nora,,,600001,,7006,,
`;
const LAB = `QUEST DIAGNOSTICS   Fax: (208) 555-0190
LABORATORY REPORT
Patient Name: TESTPATIENT, MARIGOLD J        DOB: 03/14/1961
MRN: 00482913    Sex: F   Patient Phone: (208) 555-0142
Ordering Physician: Dr. Example
Date Collected: 10/08/2026 08:15   Reported: 10/08/2026 16:40

TEST                 RESULT   FLAG   REFERENCE RANGE   UNITS
Creatinine           2.4      H      0.6-1.1           mg/dL
Sodium               139             135-145           mmol/L
`;
const CONSULT = `Practice: Boise Valley Cardiology Associates
Consultation Note
Patient: Orrin B. Lightfoot    DOB: 9/5/49
Date of Service: 10-06-2026

Dear Dr. Example,
Assessment and Plan: Continue current regimen. Follow up in 3 months.
`;
const TWINS = `LABORATORY REPORT\nPatient Name: TWINLY, DANA     DOB: 01/02/1990\nDate Collected: 10/08/2026\nCreatinine 1.0 0.6-1.1 mg/dL\n`;
const NOBODY = `LABORATORY REPORT\nPatient Name: NOBODY, NADIA     DOB: 02/02/1972\nMRN: 999111\nDate Collected: 10/08/2026\nCreatinine 1.0 0.6-1.1 mg/dL\n`;
const HEAD = 'SAWTOOTH RAPID LAB - DAILY BATCH RESULTS\nBATCH: 20261009-03   RUN DATE: 10/09/2026\n';
const pt = (name: string, dob: string, mrn: string) =>
  `${HEAD}PT: ${name.padEnd(26)} DOB: ${dob}   SEX: F\nMRN: ${mrn}                ACC#: SR1001   COLL: 10/08/2026 06:45\n  CREAT      2.41H (0.60-1.30) mg/dL\n  K           4.1  (3.5-5.1) mmol/L\n`;
const PAGE_A = pt('TESTPATIENT,MARIGOLD', '1961-03-14', '482913');
const PAGE_B = pt('ZEPHYR,QUILLON', '1958-07-02', '771234');
const CATEGORIES = `Category\n# from the clinic's Veradigm EHR\nLabs/Procedures\n"Consultant Letter"\n(ready for indexing)\nLabs/Procedures\nRadiology Report,extra column\n\n`;
const PEOPLE: Record<string, any> = {
  testpatient: { patientId: '9001', chartPatientId: '7001', firstName: 'Marigold', lastName: 'Testpatient', dateOfBirth: '03/14/1961', mrn: '482913' },
  zephyr: { patientId: '9002', chartPatientId: '7002', firstName: 'Quillon', lastName: 'Zephyr', dateOfBirth: '07/02/1958', mrn: '771234' },
  lightfoot: { patientId: '9003', chartPatientId: '7003', firstName: 'Orrin', lastName: 'Lightfoot', dateOfBirth: '09/05/1949', mrn: '330017' },
};
const TYPE_ROWS = [
  {
    getdocumenttypeinfo: [
      { DisplayName: '(ready for indexing)', EntryCode: '-1000999', ID: '1', DocumentFormat: 'Image', Archived: 'N' },
      { DisplayName: 'Labs/Procedures', EntryCode: 'LAB', ID: '12', DocumentFormat: 'Image', Archived: 'N' },
      { DisplayName: 'Consultant Letter', EntryCode: 'CONS', ID: '15', DocumentFormat: 'Image', Archived: 'N' },
    ],
  },
];

async function main(): Promise<void> {
  const roster = await import('../platform/modules/intake/roster');
  const shadow = await import('../platform/modules/intake/shadow');
  const report = await import('../platform/modules/intake/shadow-report');
  const ui = await import('../platform/modules/intake/shadow-ui');
  const { IntakeStore, intakeStore } = await import('../platform/modules/intake/store');
  const { extractFields } = await import('../platform/modules/intake/extract');
  const { matchPatient, toCandidates } = await import('../platform/modules/intake/match');
  const { CsvDocTypes, DocTypeCache, FallbackDocTypes } = await import('../platform/modules/intake/doctypes');
  const filing = await import('../platform/modules/intake/file');
  const { IntakePipeline, autoFileBlocker } = await import('../platform/modules/intake/pipeline');
  const folder = await import('../platform/modules/intake/folder');
  const { OcrClient } = await import('../platform/modules/intake/ocr');
  const intake = await import('../platform/modules/intake');
  const { runImport } = await import('./intake-import');
  const { insideDir } = await import('./eval-shadow');
  const shell = await import('../platform/shell');
  const express = (await import('express')).default;

  let passed = 0;
  const logged: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...a: any[]) => logged.push(a.map(String).join(' '));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  const ok = (label: string) => {
    passed++;
    orig.log(`PASS ${label}`);
  };
  const listen = async (app: any) => {
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    return { srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
  };
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

  // 1. Roster CSV
  const r1 = roster.Roster.fromText(ROSTER, NOW);
  assert.deepStrictEqual([r1.stats.rows, r1.stats.patients, r1.stats.merged, r1.stats.skipped, r1.stats.key_conflicts], [7, 5, 1, 1, 0]);
  const mp = r1.byPatientKey('7001')[0];
  assert.deepStrictEqual([mp.first, mp.middle, mp.last, mp.dob, mp.mrns, mp.phones], ['Marigold', 'J', 'Testpatient', '03/14/1961', ['00482913', 'E-48291'], ['2085550142', '2085550143']], 'duplicate row merged (phones)');
  assert.deepStrictEqual(r1.byPatientKey('7003')[0].dob, '09/05/1949', 'M/D/YYYY');
  assert.deepStrictEqual(r1.byPatientKey('7002')[0].dob, '07/02/1958', 'YYYY-MM-DD');
  const r2 = roster.Roster.fromText('﻿PATIENT NAME;D.O.B.;Med Rec #;Phone\r\n"ZEPHYR, QUILLON A";19580702;771234;2085550177\r\nLIGHTFOOT, ORRIN;09/05/1949;330017;\r\n', NOW);
  assert.deepStrictEqual(r2.patients.map((p) => [p.last, p.first, p.middle, p.dob, p.key]), [['Zephyr', 'Quillon', 'A', '07/02/1958', '771234'], ['Lightfoot', 'Orrin', '', '09/05/1949', '330017']], 'BOM, ";", "Patient Name" LAST, FIRST, YYYYMMDD, MRN as key');
  assert.strictEqual(roster.Roster.fromText('lname\tfname\tbirthdate\tmrn\nDoe\tJane\t1/2/1980\t42\n', NOW).patients.length, 1, 'tab separated, short headers');
  assert.throws(() => roster.Roster.fromText('Last,First,DOB\nDoe,Jane,1/2/1980\n'), (e: any) => e.code === 'ROSTER_BAD_HEADER' && /MRN/.test(e.message));
  assert.throws(() => roster.Roster.fromText(''), (e: any) => e.code === 'ROSTER_EMPTY');
  assert.throws(() => roster.Roster.fromText('Last,First,DOB,MRN\n,,,\nX,,,1\n'), (e: any) => e.code === 'ROSTER_EMPTY');
  const s1 = r1.search({ lastName: 'Testpatient', firstName: 'Marigold', dateOfBirth: '3/14/1961' });
  assert.strictEqual(s1.total, 1);
  const c1 = toCandidates(s1)[0];
  assert.deepStrictEqual([c1.chartPatientId, c1.mrns, c1.phones], ['7001', ['00482913', 'E-48291'], ['2085550142', '2085550143']], 'same shape as unity_search_patients');
  assert.strictEqual(r1.search({ lastName: 'Te', firstName: 'Ma', dateOfBirth: '03/15/1961' }).total, 0, 'DOB exact');
  assert.deepStrictEqual(
    [r1.find('testp').length, r1.find('03/14/1961').length, r1.find('482913').length, r1.find('twinly dana').length, r1.find('0142').length, r1.find('zephyr 1961').length],
    [1, 1, 1, 2, 1, 0],
    'staff search: name prefix, DOB, MRN (leading zeros), phone end, all words'
  );
  assert.deepStrictEqual([r1.resolve('482913')?.key, r1.resolve('7002')?.key, r1.resolve('E48291')?.key, r1.resolve('999')], ['7001', '7002', '7001', null], 'resolve by MRN or key');
  const exampleDir = path.join(__dirname, '..', '..', 'deploy', 'datacenter', 'examples');
  assert.strictEqual(roster.Roster.fromText(fs.readFileSync(path.join(exampleDir, 'roster.example.csv'), 'utf8'), NOW).stats.patients, 3, 'the shipped example list parses');
  ok('roster: header variants (BOM, ; tab, "Patient Name"), DOB formats, merge, skip, required columns, same search shape, staff search, example file');

  // 1b. Optional third-identifier columns: SSN (last 4 kept only) and address. Made-up people; the full
  // SSN uses a 9xx area number, which is never issued.
  const r3 = roster.Roster.fromText(
    [
      'Last Name,First Name,DOB,MRN,Chart ID,SSN,Address,Address 2,City,State,Zip Code',
      'Testpatient,Marigold,03/14/1961,482913,7001,912-34-5678,1234 W Juniper St,Apt 4,Boise,ID,83704-1234',
      'Testpatient,Marigold,03/14/1961,482913,7001,912-34-5678,88 S Camas Rd,,Meridian,ID,83642',
      'Zephyr,Quillon,1958-07-02,771234,7002,5678,,,,,',
      'Twinly,Dana,01/02/1980,555001,7003,***-**-1111,,,,,',
      'Twinly,Dana,01/02/1980,555001,7003,***-**-2222,,,,,',
    ].join('\n'),
    NOW
  );
  const t1 = r3.byPatientKey('7001')[0];
  assert.deepStrictEqual([t1.ssnLast4, t1.addresses.map((a) => [a.line1, a.zip])], ['5678', [['1234 W Juniper St Apt 4', '83704'], ['88 S Camas Rd', '83642']]], 'SSN kept as its last 4; one row per address merged');
  assert.deepStrictEqual([r3.byPatientKey('7002')[0].ssnLast4, r3.byPatientKey('7002')[0].addresses], ['5678', []], 'an "SSN" column holding the last 4 only');
  assert.strictEqual(r3.byPatientKey('7003')[0].ssnLast4, '', 'two different SSNs for one patient: nothing to compare');
  assert.ok(!JSON.stringify(r3.patients).includes('912'), 'no full SSN anywhere in the parsed list');
  const s3 = r3.search({ lastName: 'Testpatient', firstName: 'Marigold', dateOfBirth: '03/14/1961' });
  assert.ok(!JSON.stringify(s3).includes('912'), 'no full SSN in the search answer');
  const c3 = toCandidates(s3)[0];
  assert.deepStrictEqual([c3.ssnLast4, c3.addresses?.map((a) => a.zip)], ['5678', ['83704', '83642']], 'search rows carry SSN-4 and every address, same shape as unity_search_patients');
  const one = roster.Roster.fromText('Last,First,DOB,MRN,Patient Address\nDoe,Jane,1/2/1980,42,"1234 W Juniper St, Apt 4, Boise, ID 83704"\n', NOW).patients[0];
  assert.deepStrictEqual(one.addresses, [{ line1: '1234 W Juniper St, Apt 4', city: 'Boise', state: 'ID', zip: '83704' }], 'one Address column with the whole address is split');
  assert.deepStrictEqual(roster.Roster.fromText(fs.readFileSync(path.join(exampleDir, 'roster.example.csv'), 'utf8'), NOW).byPatientKey('7001')[0].ssnLast4, '1234', 'example file: optional SSN Last 4 and address columns');
  ok('roster third-identifier columns: SSN (only the last 4 kept, conflicts dropped), address (split columns, one column, several rows), carried to the search rows');

  // 2. matchPatient on the roster: same decision table, failures are errors
  const rosterFile = path.join(TMP, 'roster.csv');
  fs.writeFileSync(rosterFile, ROSTER);
  process.env.INTAKE_ROSTER_CSV = rosterFile;
  let liveCalls = 0;
  const noLive = async () => {
    liveCalls++;
    throw new Error('live search must not run');
  };
  const m = async (text: string) => matchPatient(extractFields(text, NOW), noLive, () => NOW);
  const mLab = await m(LAB);
  assert.deepStrictEqual([mLab.decision, mLab.patient?.chartPatientId, mLab.second_identifier], ['auto', '7001', 'mrn']);
  assert.deepStrictEqual([(await m(CONSULT)).decision, (await m(TWINS)).decision, (await m(NOBODY)).decision], ['review', 'ambiguous', 'none']);
  process.env.INTAKE_ROSTER_CSV = path.join(TMP, 'missing.csv');
  const gone = await m(LAB);
  assert.deepStrictEqual([gone.decision, gone.error_code], ['error', 'ROSTER_UNAVAILABLE'], 'missing roster: an error, never "no match"');
  const badFile = path.join(TMP, 'bad.csv');
  fs.writeFileSync(badFile, 'Last,First\nDoe,Jane\n');
  process.env.INTAKE_ROSTER_CSV = badFile;
  assert.deepStrictEqual([(await m(LAB)).decision, (await m(LAB)).error_code], ['error', 'ROSTER_BAD_HEADER']);
  process.env.INTAKE_ROSTER_CSV = rosterFile;
  fs.writeFileSync(rosterFile, ROSTER.replace(/^Lightfoot.*\n/m, ''));
  assert.strictEqual((await m(CONSULT)).decision, 'none', 'a changed list is read again');
  fs.writeFileSync(rosterFile, ROSTER);
  assert.strictEqual(liveCalls, 0, 'the live search never ran');
  delete process.env.INTAKE_ROSTER_CSV;
  const liveFail = await matchPatient(extractFields(LAB, NOW), async () => ({ success: false, error_code: 'AUTH_ERROR', retryable: false, tool: 'x', message: '' }), () => NOW);
  assert.deepStrictEqual([liveFail.decision, liveFail.error_code], ['error', 'AUTH_ERROR'], 'without a roster: the live search, as before');
  ok('roster matching: auto/review/ambiguous/none by the same decideMatch; missing or bad list = error; reloads on change; live search untouched');

  // 3. Categories: a list, and live first with the list as fallback
  const catFile = path.join(TMP, 'categories.csv');
  fs.writeFileSync(catFile, CATEGORIES);
  const csv = new CsvDocTypes(catFile);
  assert.deepStrictEqual((await csv.list()).map((t) => t.name), ['Labs/Procedures', 'Consultant Letter', '(ready for indexing)', 'Radiology Report'], 'header, comment, quotes, duplicate, extra column');
  assert.deepStrictEqual(await csv.suggest('lab_result'), { id: 'Labs/Procedures', name: 'Labs/Procedures', reason: 'keyword' });
  assert.deepStrictEqual((await csv.suggest('other'))?.reason, 'fallback');
  await assert.rejects(() => new CsvDocTypes(path.join(TMP, 'nope.csv')).list());
  assert.strictEqual((await new CsvDocTypes(path.join(__dirname, '..', '..', 'deploy', 'datacenter', 'examples', 'categories.example.csv')).list()).length, 7, 'the shipped example list parses');
  const liveTypes = { async executeAction() { return { success: true, data: TYPE_ROWS }; } } as any;
  const downTypes = { async executeAction() { return { success: false, error: 'down' }; } } as any;
  assert.strictEqual((await new FallbackDocTypes(new DocTypeCache(liveTypes), csv).suggest('lab_result'))?.id, '12', 'live GetDocumentType first');
  assert.strictEqual((await new FallbackDocTypes(new DocTypeCache(downTypes), csv).suggest('lab_result'))?.id, 'Labs/Procedures', 'the list when Veradigm is not reachable');
  await assert.rejects(() => new FallbackDocTypes(new DocTypeCache(downTypes), null).list(), 'both missing: an error, never an empty list');
  ok('categories: INTAKE_CATEGORIES_CSV parsed and mapped like GetDocumentType; live first, list as fallback');

  // 4. Read-only Veradigm in shadow mode
  const actions: string[] = [];
  const recUnity = { async executeAction(a: string) { actions.push(a); return { success: true, data: a === 'GetDocumentType' ? TYPE_ROWS : [] }; } };
  const ro = shadow.readOnlyUnity(recUnity);
  for (const a of ['SearchPatients', 'GetDocumentType', 'SaveScanDocument', 'SaveTask', 'SaveAppointment', 'SavePatient', 'SetAppointmentStatus']) await ro.executeAction(a);
  assert.deepStrictEqual(actions.splice(0), ['SearchPatients', 'GetDocumentType'], 'only the search and the category list pass');
  assert.strictEqual((await ro.executeAction('SaveScanDocument')).success, false);
  const locked = { async executeAction(a: string) { actions.push(a); return { success: true }; } };
  shadow.lockUnityReadOnly(locked);
  await locked.executeAction('SaveTask');
  await locked.executeAction('SearchPatients');
  assert.deepStrictEqual(actions.splice(0), ['SearchPatients'], 'a locked service refuses writes');
  const tools: string[] = [];
  const roTool = shadow.readOnlyRunTool(async (n) => (tools.push(n), { patients: [] }));
  assert.strictEqual((await roTool('unity_save_patient', {})).error_code, 'SHADOW_READ_ONLY');
  await roTool('unity_search_patients', {});
  assert.deepStrictEqual(tools, ['unity_search_patients']);
  ok('read-only guards: SearchPatients and GetDocumentType only; SaveScanDocument, SaveTask and every other write refused; one tool');

  // 5. Shadow pipeline, live (fake) search: nothing is filed, whatever INTAKE_FILING says
  Object.assign(process.env, { INTAKE_MODE: 'shadow', INTAKE_FILING: 'auto', INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED: 'true', INTAKE_REVIEW_USER: 'smoke-reviewer', INTAKE_CATEGORIES_CSV: catFile });
  const searched: string[] = [];
  const liveSearch = async (name: string, a: any) => {
    if (name !== 'unity_search_patients') throw new Error('unexpected tool');
    searched.push(name);
    const rows = a.mrn ? Object.values(PEOPLE).filter((p) => p.mrn === String(a.mrn).replace(/^0+/, '')) : PEOPLE[String(a.lastName || '').toLowerCase()] ? [PEOPLE[String(a.lastName).toLowerCase()]] : [];
    return { patients: rows, total: rows.length, message: '' };
  };
  const vCalls: string[] = [];
  const fakeUnity = { async executeAction(a: string) { vCalls.push(a); return { success: true, data: a === 'GetDocumentType' ? TYPE_ROWS : [{ savescandocumentinfo: [{ documentID: '1' }] }] }; } } as any;
  const pStore = new IntakeStore(path.join(TMP, 'pipe'), () => NOW);
  const pipe = new IntakePipeline({ store: () => pStore, now: () => NOW, ocr: () => null });
  pipe.setDeps({ runTool: shadow.readOnlyRunTool(liveSearch) }, new FallbackDocTypes(new DocTypeCache(shadow.readOnlyUnity(fakeUnity) as any), new CsvDocTypes(catFile)));
  filing.setFilingDeps({ unity: fakeUnity, store: () => pStore, now: () => NOW }); // deliberately wired: it must still refuse
  const add = (s: any, name: string, text: string) => s.addDocument({ source: 'upload', source_ref: '', name, mime: 'application/pdf', data: Buffer.from(`%PDF-1.4 ${name} ${text.length}`), text }).item.id as string;
  const pLab = add(pStore, 'lab.pdf', LAB);
  const pCons = add(pStore, 'consult.pdf', CONSULT);
  const pNone = add(pStore, 'nobody.pdf', NOBODY);
  const pLow = add(pStore, 'low.pdf', LAB.replace('Sodium', 'Sodium '));
  pStore.update(pLow, { ocr: { engine: 'local', pages: 1, mean_confidence: 40, used_text_layer: false } });
  const pBlank = pStore.addDocument({ source: 'upload', source_ref: '', name: 'blank.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 blank') }).item.id;
  const pSender = add(pStore, 'lab2.pdf', LAB.replace('Creatinine           2.4', 'Creatinine           2.5'));
  for (const id of [pLab, pCons, pNone, pLow, pBlank]) pipe.enqueue(id);
  await pipe.idle();
  process.env.INTAKE_NO_AUTO_SENDERS = 'Quest Diagnostics';
  pipe.enqueue(pSender);
  await pipe.idle();
  delete process.env.INTAKE_NO_AUTO_SENDERS;
  const got = (id: string) => {
    const i = pStore.get(id)!;
    return [i.status, i.shadow?.would, i.shadow?.code, i.shadow?.patient_key || '', i.shadow?.category || ''];
  };
  assert.deepStrictEqual(got(pLab), ['matched', 'auto_file', 'auto', '7001', 'Labs/Procedures'], 'would auto-file: patient and category recorded');
  assert.deepStrictEqual(got(pCons), ['needs_review', 'staff', 'no_second_id', '7003', 'Consultant Letter'], 'candidate kept for staff');
  assert.deepStrictEqual(got(pNone), ['needs_review', 'staff', 'no_match', '', 'Labs/Procedures']);
  assert.deepStrictEqual(got(pLow).slice(0, 3), ['needs_review', 'staff', 'ocr_low_confidence']);
  assert.deepStrictEqual(got(pBlank).slice(0, 3), ['needs_review', 'staff', 'no_text']);
  assert.deepStrictEqual(got(pSender).slice(0, 3), ['matched', 'staff', 'sender_staff_only'], 'an auto match the live rules would hold');
  assert.ok(pStore.list().every((i) => !i.filed && i.status !== 'filed'), 'nothing filed');
  assert.deepStrictEqual([...new Set(vCalls)], ['GetDocumentType'], 'no SaveScanDocument, no SaveTask: only the category list was read');
  assert.ok(searched.length >= 4, 'the live search (read-only) found the patients');
  await assert.rejects(() => filing.fileToChart(pStore.get(pLab)!, 'smoke'), (e: any) => e.error_code === 'FILING_DISABLED');
  await assert.rejects(() => filing.sendToIndexing(pStore.get(pLab)!, 'smoke'), (e: any) => e.error_code === 'FILING_DISABLED');
  assert.deepStrictEqual([filing.filingMode(), filing.filingStatus().enabled, /Shadow mode/.test(filing.filingStatus().reason), autoFileBlocker(pStore.get(pLab)!)], ['off', false, true, 'filing mode is not auto']);
  assert.ok(pStore.get(pLab)!.history.some((h) => h.action === 'shadow: would auto-file (Labs/Procedures)'));
  assert.deepStrictEqual([...new Set(vCalls)], ['GetDocumentType'], 'still no write after the refused filing calls');
  ok('shadow pipeline (live search): decisions recorded (auto, candidate, no match, OCR gate, no text, sender hold); INTAKE_FILING=auto ignored; no write reached Veradigm');

  // 6. Shadow pipeline on the roster; a roster gone missing fails the item
  process.env.INTAKE_ROSTER_CSV = rosterFile;
  const qStore = new IntakeStore(path.join(TMP, 'pipe-roster'), () => NOW);
  const qPipe = new IntakePipeline({ store: () => qStore, now: () => NOW, ocr: () => null });
  qPipe.setDeps({ runTool: shadow.readOnlyRunTool(noLive) }, new FallbackDocTypes(null, new CsvDocTypes(catFile)));
  const qLab = add(qStore, 'lab.pdf', LAB);
  qPipe.enqueue(qLab);
  await qPipe.idle();
  assert.deepStrictEqual([qStore.get(qLab)!.shadow?.would, qStore.get(qLab)!.shadow?.patient_key], ['auto_file', '7001']);
  process.env.INTAKE_ROSTER_CSV = path.join(TMP, 'missing.csv');
  const qGone = add(qStore, 'lab-b.pdf', LAB.replace('Sodium               139', 'Sodium               140'));
  qPipe.enqueue(qGone);
  await qPipe.idle();
  assert.deepStrictEqual([qStore.get(qGone)!.status, qStore.get(qGone)!.error_code, qStore.get(qGone)!.shadow], ['failed', 'ROSTER_UNAVAILABLE', undefined]);
  assert.strictEqual(liveCalls, 0);
  delete process.env.INTAKE_ROSTER_CSV;
  ok('shadow pipeline (roster): same decision; a missing roster leaves the item failed with ROSTER_UNAVAILABLE');

  // 7. The module in shadow mode: batch split, Confirm panel, queue filters (live fake search)
  const ocrApp = express();
  ocrApp.post(['/ocr', '/pages'], express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
    const mark = (req.body.toString('latin1').match(/CASE:(\w+)/) || [])[1] || '';
    const texts = mark === 'batch' ? [PAGE_A, PAGE_B] : mark === 'blank' ? [''] : null;
    if (!texts) return res.status(404).end();
    if (req.path === '/ocr') return res.json({ text: texts.join('\f'), pages: texts.length, mean_confidence: 88, used_text_layer: false, page_texts: texts, page_confidences: texts.map(() => 88) });
    res.setHeader('X-Source-Pages', String(texts.length));
    return res.type('application/pdf').send(Buffer.from(`%PDF-1.4\n% CASE:${mark}-part ${req.query.select}\n`));
  });
  const ocrSrv = await listen(ocrApp);
  process.env.INTAKE_OCR_URL = ocrSrv.url;
  intake.intakeModule.start!({ unity: fakeUnity, runTool: liveSearch } as any);
  const gStore = intakeStore();
  const gAdd = (name: string, text: string) => add(gStore, name, text);
  const gLab = gAdd('lab.pdf', LAB);
  const gCons = gAdd('consult.pdf', CONSULT);
  const gNone = gAdd('nobody.pdf', NOBODY);
  const gBlank = gStore.addDocument({ source: 'upload', source_ref: '', name: 'blank.tif', mime: 'image/tiff', data: Buffer.from('II*\u0000 CASE:blank') }).item.id;
  const gBatch = gStore.addDocument({ source: 'folder', source_ref: '', name: 'batch.tif', mime: 'image/tiff', data: Buffer.from('II*\u0000 CASE:batch') }).item.id;
  for (const id of [gLab, gCons, gNone, gBlank, gBatch]) intake.intakePipeline.enqueue(id);
  await intake.intakePipeline.idle();
  const parent = gStore.get(gBatch)!;
  assert.deepStrictEqual([parent.status, parent.shadow?.would, parent.split?.pages], ['split', 'split', [[1], [2]]]);
  const [part1, part2] = parent.split!.children;
  assert.deepStrictEqual([gStore.get(part1)!.shadow?.would, gStore.get(part1)!.shadow?.patient_key, gStore.get(part2)!.shadow?.would, gStore.get(part2)!.shadow?.patient_key], ['auto_file', '7001', 'auto_file', '7002'], 'each part decided on its own');
  assert.ok(gStore.list().every((i) => !i.filed));

  const staffApp = express();
  staffApp.use('/app/intake', (req: any, _res, next) => ((req.drawbridgeUser = 'smoke.staff'), next()), express.urlencoded({ extended: false }), intake.intakeModule.appRouter!({} as any));
  const st = await listen(staffApp);
  const base = `${st.url}/app/intake`;
  const post = (p: string, body: Record<string, string>) =>
    fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
  const msg = async (p: string, body: Record<string, string>) => new URL((await post(p, body)).headers.get('location') || '', st.url).searchParams.get('m');
  try {
    const queue = await fetch(`${base}/`).then((r) => r.text());
    assert.ok(/Shadow mode\./.test(queue) && /Would auto-file/.test(queue) && /Needs confirmation/.test(queue) && !/\b(mcp|fhir|unity)\b/i.test(queue));
    const itemHtml = await fetch(`${base}/item/${gLab}`).then((r) => r.text());
    assert.ok(/<h2>Confirm<\/h2>/.test(itemHtml) && /Correct: Marigold Testpatient, Labs\/Procedures/.test(itemHtml) && !/Change category/.test(itemHtml), 'Confirm panel, no category picker');
    assert.strictEqual(await msg(`/item/${gLab}/confirm`, { action: 'accept' }), 'confirmed');
    assert.deepStrictEqual([gStore.get(gLab)!.truth?.outcome, gStore.get(gLab)!.truth?.patient?.key, gStore.get(gLab)!.truth?.category, gStore.get(gLab)!.truth?.by], ['patient', '7001', 'Labs/Procedures', 'smoke.staff']);
    const found = await post(`/item/${gCons}/find`, { q: 'Zephyr Quillon' }).then((r) => r.text());
    assert.ok(/Zephyr, Quillon/.test(found) && /name="patient_key" value="7002"/.test(found), 'patient search on the panel (POST)');
    assert.ok(/Type a last name/.test(await post(`/item/${gCons}/find`, { q: '01/01/1990' }).then((r) => r.text())));
    assert.strictEqual(await msg(`/item/${gCons}/confirm`, { action: 'patient', patient_key: '7999', q: 'Zephyr Quillon' }), 'truth_patient_unknown', 'a key not in the search');
    assert.strictEqual(await msg(`/item/${gCons}/confirm`, { action: 'patient', patient_key: '7002', q: 'Zephyr Quillon', category: 'Made Up' }), 'truth_category_unknown');
    assert.strictEqual(await msg(`/item/${gCons}/confirm`, { action: 'patient', patient_key: '7002', q: 'Zephyr Quillon', category: 'consultant letter' }), 'confirmed');
    assert.deepStrictEqual([gStore.get(gCons)!.truth?.patient?.key, gStore.get(gCons)!.truth?.category], ['7002', 'Consultant Letter']);
    assert.strictEqual(await msg(`/item/${gNone}/confirm`, { action: 'not_iki' }), 'confirmed');
    assert.strictEqual(await msg(`/item/${gBlank}/confirm`, { action: 'unreadable' }), 'confirmed');
    assert.strictEqual(await msg(`/item/${gBatch}/confirm`, { action: 'several', pages_0: '1-3', patient_0: '482913' }), 'truth_pages_bad', 'page out of range');
    assert.strictEqual(await msg(`/item/${gBatch}/confirm`, { action: 'several', pages_0: '1', patient_0: '482913', pages_1: '1', patient_1: '771234' }), 'truth_pages_bad', 'a page twice');
    assert.strictEqual(await msg(`/item/${gBatch}/confirm`, { action: 'several', pages_0: '1', patient_0: '000000' }), 'truth_patient_unknown');
    assert.strictEqual(await msg(`/item/${gBatch}/confirm`, { action: 'several', pages_0: '1', patient_0: '00482913', pages_1: '2', patient_1: '771234', category_1: 'Labs/Procedures' }), 'confirmed');
    assert.deepStrictEqual(gStore.get(gBatch)!.truth?.parts?.map((p) => [p.pages, p.patient?.key]), [[[1], '7001'], [[2], '7002']]);
    const byId = (id: string) => gStore.get(id);
    assert.deepStrictEqual(
      [gLab, gCons, gNone, gBlank, gBatch, part1, part2].map((id) => shadow.agreement(gStore.get(id)!, byId)),
      ['agrees', 'disagrees', 'agrees', 'agrees', 'agrees', 'agrees', 'agrees'],
      'agreement: accepted, other patient than the candidate, not IKI, unreadable, split as confirmed, parts from the parent'
    );
    const ids = (html: string) => [...html.matchAll(/item\/(in_[a-z0-9]+)"/g)].map((x) => x[1]);
    assert.deepStrictEqual(ids(await fetch(`${base}/?confirm=disagrees`).then((r) => r.text())), [gCons], 'filter: disagrees');
    assert.deepStrictEqual(ids(await fetch(`${base}/?confirm=needs`).then((r) => r.text())), [], 'filter: needs confirmation (none left)');
    assert.strictEqual(ids(await fetch(`${base}/?confirm=confirmed`).then((r) => r.text())).length, 7, 'filter: confirmed');
    assert.strictEqual(await msg(`/item/${gNone}/confirm`, { action: 'clear' }), 'truth_cleared');
    assert.deepStrictEqual(ids(await fetch(`${base}/?confirm=needs`).then((r) => r.text())), [gNone]);
    assert.strictEqual(await msg(`/item/${gNone}/confirm`, { action: 'not_iki' }), 'confirmed');
    assert.strictEqual(await msg(`/item/${gLab}/category`, { type_id: '15' }), 'category_shadow', 'the prediction is not edited in shadow mode');
    assert.strictEqual(await msg(`/item/${gLab}/file-to-chart`, {}), 'FILING_DISABLED');
    assert.deepStrictEqual([...new Set(vCalls)], ['GetDocumentType'], 'still nothing written to Veradigm');
    assert.ok(gStore.get(gCons)!.history.some((h) => h.action === 'confirmed: patient picked by staff' && h.by === 'smoke.staff'), 'audited on the item');
  } finally {
    st.srv.close();
  }
  ok('module in shadow mode: batch split with parts decided; Confirm panel (accept, search by POST, pick, not IKI, unreadable, several with pages, clear); queue filters; no category edit; filing refused');

  // 8. Report: counts only, wrong-patient detection, leak check, per-document file
  const items = () => gStore.list();
  let rep = report.buildShadowReport(items(), { now: NOW, text: (id) => gStore.readText(id), minSender: 1 });
  assert.deepStrictEqual(
    [rep.documents, rep.units, rep.split_parents, rep.would_auto_file, rep.would_staff, rep.confirmed_units, rep.precision.right, rep.precision.of, rep.wrong_patient.total, rep.category.right, rep.category.of, rep.disagreements],
    [5, 6, 1, 3, 3, 6, 3, 3, 0, 3, 3, 1]
  );
  assert.deepStrictEqual([rep.documents_fully_auto, rep.splits.groups_exact, rep.auto_rate_on_confirmed_patient_docs.auto, rep.auto_rate_on_confirmed_patient_docs.of], [2, 1, 3, 4]);
  assert.deepStrictEqual(rep.staff_reasons.map((r) => [r.code, r.units, r.candidate_right]), [['no_match', 1, 0], ['no_second_id', 1, 0], ['no_text', 1, 0]]);
  assert.ok(rep.by_sender.some((s) => /quest/i.test(s.sender)), 'sender shown at or above the threshold');
  // Staff now say page 2 is a third patient: that part would have gone to the wrong chart.
  assert.strictEqual(await (async () => {
    const app2 = express();
    app2.use('/app/intake', (req: any, _res, next) => ((req.drawbridgeUser = 'smoke.staff'), next()), intake.intakeModule.appRouter!({} as any));
    const s2 = await listen(app2);
    try {
      const r = await fetch(`${s2.url}/app/intake/item/${gBatch}/confirm`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ action: 'several', pages_0: '1', patient_0: '482913', pages_1: '2', patient_1: '330017' }) });
      return new URL(r.headers.get('location') || '', s2.url).searchParams.get('m');
    } finally {
      s2.srv.close();
    }
  })(), 'confirmed');
  rep = report.buildShadowReport(items(), { now: NOW, text: (id) => gStore.readText(id) });
  assert.deepStrictEqual([rep.wrong_patient.total, rep.wrong_patient.different_patient, rep.precision.right, rep.precision.of], [1, 1, 2, 3], 'a split part confirmed to someone else is a wrong-patient auto-file');
  assert.ok(rep.by_sender.every((s) => !/quest/i.test(s.sender)), 'pooled under the default threshold');
  const md = report.shadowReportMarkdown(rep);
  const json = JSON.stringify(rep);
  const idents = report.identifiersOf(items());
  assert.strictEqual(report.findLeaks(md, idents) + report.findLeaks(json, idents), 0);
  for (const bad of ['Testpatient', 'TESTPATIENT', 'Marigold', 'Zephyr', 'Lightfoot', 'Nadia', '1961', '482913', '771234', '330017', '555-01', gLab, 'lab.pdf', 'Creatinine']) {
    assert.ok(!md.includes(bad) && !json.includes(bad), `report holds "${bad}"`);
  }
  assert.ok(/\*\*Wrong-patient auto-files\*\* \(must be 0\) \| \*\*1\*\*/.test(md) && /Top sender layouts/.test(md));
  assert.ok(report.findLeaks(`${md}\n| Marigold Testpatient |`, idents) > 0 && report.findLeaks(`${md} 482913`, idents) > 0, 'the leak check catches a name or an MRN');
  assert.strictEqual(report.senderLabel('Marigold Testpatient MD', new Set(['marigoldtestpatient'])), '', 'a sender label naming a patient is never shown');
  assert.deepStrictEqual(report.layoutLabels(LAB).slice(0, 4), ['patient name', 'dob', 'mrn', 'phone']);
  const csvText = report.documentCsv(items());
  assert.ok(csvText.startsWith(report.PHI_CSV_WARNING) && csvText.includes('Marigold Testpatient') && csvText.split('\n').length === 10);
  assert.ok(insideDir(path.join(TMP, 'intake', 'reports', 'x.csv'), path.join(TMP, 'intake')) && !insideDir(path.join(TMP, 'x.csv'), path.join(TMP, 'intake')));
  // The CLI end to end: exit 1 (a wrong-patient file), report and PHI file written inside the data directory.
  const cli = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', path.join(__dirname, 'eval-shadow.ts'), '--dir', path.join(TMP, 'intake'), '--csv'], {
    // No Veradigm credentials at all (patient-list mode): the report must still run.
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', UNITY_APP_NAME: '', UNITY_SVC_USERNAME: '', UNITY_SVC_PASSWORD: '', UNITY_EHR_USERNAME: '', UNITY_EHR_PASSWORD: '' },
    encoding: 'utf8',
  });
  assert.strictEqual(cli.status, 1, cli.stderr);
  assert.ok(/WRONG-PATIENT 1/.test(cli.stdout) && !/Testpatient|482913/.test(cli.stdout + cli.stderr));
  const written = fs.readdirSync(path.join(TMP, 'intake', 'reports'));
  assert.ok(written.some((f) => /^shadow-report-.*\.md$/.test(f)) && written.some((f) => /^shadow-report-.*\.json$/.test(f)) && written.some((f) => /^shadow-documents-.*\.csv$/.test(f)));
  const reportFile = written.find((f) => f.endsWith('.md'))!;
  assert.ok(!fs.readFileSync(path.join(TMP, 'intake', 'reports', reportFile), 'utf8').includes('Testpatient'));
  ok('report: auto-file rate, precision, wrong-patient (incl. a split part), category accuracy, ranked reasons, senders pooled, layouts; no identifiers (leak check); PHI file only inside the data directory; CLI exit 1 on a wrong-patient file');

  // 9. Bulk import: nested folder, read only, deduped, paced, backpressure
  const src = path.join(TMP, 'old-faxes');
  fs.mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
  const pdf1 = Buffer.from('%PDF-1.4 old fax one');
  const tif2 = Buffer.from('II*\u0000 old fax two');
  fs.writeFileSync(path.join(src, 'a', 'b', 'Smith John 2019.pdf'), pdf1);
  fs.writeFileSync(path.join(src, 'a', 'two.TIF'), tif2);
  fs.writeFileSync(path.join(src, 'copy-of-one.pdf'), pdf1);
  fs.writeFileSync(path.join(src, 'fake.pdf'), 'not a pdf');
  fs.writeFileSync(path.join(src, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(src, '.hidden.pdf'), pdf1);
  const snap = () => folder.listFiles(src, 12).map((f) => `${f}:${createHash('sha256').update(fs.readFileSync(path.join(src, f))).digest('hex')}:${fs.statSync(path.join(src, f)).mtimeMs}`);
  const before = snap();
  const imStore = path.join(TMP, 'import-store');
  const inbox = path.join(TMP, 'import-inbox');
  const opts = { dir: src, inbox, storeDir: imStore, rate: 0, maxPending: 50, limit: 0, dryRun: false, log: () => undefined };
  assert.deepStrictEqual(await runImport({ ...opts, dryRun: true }), { seen: 4, copied: 2, duplicates: 1, unsupported: 1, too_big: 0, unreadable: 0, bytes: pdf1.length + tif2.length });
  assert.ok(!fs.existsSync(inbox), 'dry run copies nothing');
  const first = await runImport(opts);
  assert.deepStrictEqual([first.copied, first.duplicates, first.unsupported], [2, 1, 1]);
  const names = fs.readdirSync(inbox).sort();
  assert.ok(names.length === 2 && names.every((n) => /^imp-[0-9a-f]{24}\.(pdf|tif)$/.test(n)), 'no original names in the inbox');
  assert.deepStrictEqual((await runImport(opts)).copied, 0, 'a second run copies nothing (ledger)');
  assert.deepStrictEqual(snap(), before, 'originals unchanged');
  const ledger = fs.readFileSync(path.join(imStore, 'import', 'ledger.jsonl'), 'utf8');
  assert.ok(!/Smith|old-faxes|\.pdf/.test(ledger), 'ledger: hashes only');
  const iStore = new IntakeStore(imStore, () => NOW);
  const later = Date.now() + 60_000;
  const picked = folder.scanDropFolder(iStore, inbox, later);
  assert.strictEqual(picked.added.length, 2);
  assert.deepStrictEqual(iStore.list().map((i) => report.originOf(i)), ['Bulk import (old faxes)', 'Bulk import (old faxes)']);
  // Backpressure: one file waiting is the limit, so the importer waits until the server took it.
  fs.writeFileSync(path.join(src, 'three.pdf'), Buffer.from('%PDF-1.4 old fax three'));
  fs.writeFileSync(path.join(src, 'four.pdf'), Buffer.from('%PDF-1.4 old fax four'));
  let waits = 0;
  const paced: number[] = [];
  const third = await runImport({
    ...opts,
    maxPending: 1,
    rate: 30,
    sleep: async (ms) => {
      if (ms === 5000) {
        waits++;
        // The server picks up the waiting file and reads what it has.
        folder.scanDropFolder(iStore, inbox, Date.now() + 60_000);
        for (const i of iStore.list('received')) iStore.update(i.id, { status: 'needs_review' });
      } else paced.push(ms);
    },
  });
  assert.deepStrictEqual([third.copied, waits >= 1, paced], [2, true, [2000, 2000]], 'waits for the backlog; 30/min = one file every 2 s');
  ok('bulk import: nested PDF/TIFF by content, hash dedupe (store + ledger), originals untouched, no names, dry run, pacing, backpressure');

  // 10. Watched folders: read in place, never changed, each file once
  const watch = path.join(TMP, 'express-lab');
  fs.mkdirSync(path.join(watch, '2026-10'), { recursive: true });
  const wFile = path.join(watch, '2026-10', 'batch-1009.pdf');
  fs.writeFileSync(wFile, '%PDF-1.4 express lab 1009');
  fs.writeFileSync(path.join(watch, 'old.pdf'), '%PDF-1.4 express lab old');
  fs.utimesSync(path.join(watch, 'old.pdf'), new Date('2020-01-01'), new Date('2020-01-01'));
  fs.writeFileSync(path.join(watch, 'skip.txt'), 'x');
  const wStore = new IntakeStore(path.join(TMP, 'watch-store'), () => NOW);
  const t = Date.now() + 60_000;
  const since = Date.parse('2026-01-01T00:00:00Z');
  const w1 = folder.scanWatchFolder(wStore, watch, t, { since });
  assert.deepStrictEqual([w1.added.length, w1.skipped], [1, 1], 'new file taken in; one older than INTAKE_WATCH_SINCE skipped');
  assert.ok(fs.existsSync(wFile) && fs.readFileSync(wFile, 'utf8') === '%PDF-1.4 express lab 1009', 'original left in place');
  const w2 = folder.scanWatchFolder(wStore, watch, t, { since });
  assert.deepStrictEqual([w2.added.length, w2.duplicates], [0, 0], 'known files are not read again');
  fs.writeFileSync(path.join(watch, 'fresh.pdf'), '%PDF-1.4 express lab fresh');
  const w3 = folder.scanWatchFolder(wStore, watch, Date.now(), { since });
  assert.deepStrictEqual([w3.added.length, w3.skipped], [0, 2], 'a file younger than 10 s waits (and the old one stays skipped)');
  assert.strictEqual(report.originOf(wStore.list()[0]), 'Watched folder (e.g. Express Lab)');
  ok('watched folders: nested, read in place (never moved or deleted), each file once, INTAKE_WATCH_SINCE, settle time');

  // 11. Named staff logins (DRAWBRIDGE_USERS_FILE), password + TOTP code (mandatory)
  const auth = await import('../platform/staff-auth');
  const usersFile = path.join(TMP, 'users');
  const secret = auth.newTotpSecret();
  const line = `${shell.hashStaffPassword('pat.reviewer', 'correct horse battery')}:totp=${secret}`;
  assert.ok(/^pat\.reviewer:scrypt\$16384\$8\$1\$/.test(line) && !line.includes('correct horse'));
  assert.throws(() => shell.hashStaffPassword('pat', 'short'));
  fs.writeFileSync(usersFile, `${line}\n${shell.hashStaffPassword('lee.staff', 'another long password')}:totp=${auth.newTotpSecret()}\n`);
  process.env.DRAWBRIDGE_USERS_FILE = usersFile;
  process.env.DRAWBRIDGE_USERNAME = 'shared';
  process.env.DRAWBRIDGE_PASSWORD = 'shared-password-123';
  const loginApp = express();
  loginApp.use('/app', shell.shellRouter());
  loginApp.get('/app/x', shell.requireLogin, (req: any, res) => res.send(`hello ${req.drawbridgeUser}`));
  const ls = await listen(loginApp);
  try {
    const otp = auth.totpCode(secret, Math.floor(Date.now() / 30_000));
    const login = (u: string, p: string) => fetch(`${ls.url}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ u, p, otp, next: '/app/x' }) });
    const good = await login('Pat.Reviewer', 'correct horse battery');
    assert.strictEqual(good.headers.get('location'), '/app/x');
    const cookie = (good.headers.get('set-cookie') || '').split(';')[0];
    assert.strictEqual(await fetch(`${ls.url}/app/x`, { headers: { cookie } }).then((r) => r.text()), 'hello pat.reviewer');
    assert.ok(/e=1/.test((await login('pat.reviewer', 'wrong password!!')).headers.get('location') || ''));
    assert.ok(/e=1/.test((await login('shared', 'shared-password-123')).headers.get('location') || ''), 'the shared login is off when named logins are set');
    fs.writeFileSync(usersFile, `${shell.hashStaffPassword('lee.staff', 'another long password')}\n`);
    const out = await fetch(`${ls.url}/app/x`, { headers: { cookie }, redirect: 'manual' });
    assert.ok(out.status === 302 && /login/.test(out.headers.get('location') || ''), 'removed from the file: signed out at once');
  } finally {
    ls.srv.close();
    delete process.env.DRAWBRIDGE_USERS_FILE;
    delete process.env.DRAWBRIDGE_USERNAME;
    delete process.env.DRAWBRIDGE_PASSWORD;
  }
  ok('named staff logins: scrypt lines, case-insensitive user, wrong password refused, shared login off, removal signs out');

  // 12. The shadow server: intake only, read-only, never files
  const server = await import('../platform/shadow-server');
  const env1: NodeJS.ProcessEnv = { INTAKE_ROSTER_CSV: rosterFile };
  assert.deepStrictEqual(server.prepareShadowEnv(env1), { veradigm: false, roster: true });
  assert.ok(/\.invalid\//.test(env1.UNITY_UBIQUITY_ENDPOINT || '') && env1.UNITY_APP_NAME === 'shadow-no-veradigm', 'no credentials: every Veradigm call is impossible');
  const env2: NodeJS.ProcessEnv = { UNITY_APP_NAME: 'a', UNITY_SVC_USERNAME: 'b', UNITY_SVC_PASSWORD: 'c', UNITY_EHR_USERNAME: 'd', UNITY_EHR_PASSWORD: 'e' };
  assert.deepStrictEqual([server.prepareShadowEnv(env2), env2.UNITY_UBIQUITY_ENDPOINT], [{ veradigm: true, roster: false }, undefined]);
  const app = await server.createShadowApp({ veradigm: true, roster: false });
  assert.strictEqual((await app.unity.executeAction('SaveScanDocument', {}, '1', 'EHR')).success, false, 'the server\'s Unity service is locked to reads');
  assert.strictEqual((await app.unity.executeAction('SaveTask', {}, '1', 'EHR')).success, false);
  assert.strictEqual((await app.runTool('unity_save_appointment', {})).error_code, 'SHADOW_READ_ONLY');
  const sv = await listen(app.app);
  try {
    assert.deepStrictEqual(await fetch(`${sv.url}/health`).then((r) => r.json()), { status: 'healthy', server: 'intake-shadow', mode: 'shadow', filing: 'impossible', patient_search: 'veradigm read-only', indexing_queue_source: 'off' });
    const gate = await fetch(`${sv.url}/app/intake`, { redirect: 'manual' });
    assert.ok(gate.status === 302 && /\/app\/login/.test(gate.headers.get('location') || ''), 'staff screens need a login');
    assert.strictEqual((await fetch(`${sv.url}/unity/api/retell`, { method: 'POST' })).status, 404, 'no phone-agent endpoints');
    assert.strictEqual((await fetch(`${sv.url}/webhooks/moatit-fax`, { method: 'POST', body: '{}' })).status, 503, 'MOATiT Fax webhook closed until its secret is set');
  } finally {
    sv.srv.close();
  }
  ok('shadow server: intake only, health says filing impossible, login required, no agent endpoints, Unity locked to reads, fax webhook closed until configured');

  // 12b. Staff filing observer: the "(ready for indexing)" queue tracked by DocumentID (sandbox shapes, offline fakes)
  const observe = await import('../platform/modules/intake/observe');
  assert.strictEqual(observe.parseWhen('10/12/2026 10:04:00 AM').t, Date.parse('2026-10-12T16:04:00Z'), 'SortDate is Boise time (MDT)');
  assert.strictEqual(observe.parseWhen('2026-10-12T16:04:00Z').t, Date.parse('2026-10-12T16:04:00Z'));
  const T0 = Date.parse('2026-10-12T16:00:00Z'); // 10:00 in Boise
  let clock = T0;
  const oStore = new IntakeStore(path.join(TMP, 'observe'), () => new Date(clock));
  const fileOf: Record<string, Buffer> = {};
  const mk = (key: string, text: string, minutes: number, pages: number, would: 'auto_file' | 'staff', who?: any, category = 'Labs/Procedures') => {
    clock = T0 + minutes * 60_000;
    const data = Buffer.from(`%PDF-1.4 observe ${key}`);
    fileOf[key] = data;
    const id = oStore.addDocument({ source: 'moatit_fax' as any, source_ref: `fax:${key}`, name: `${key}.pdf`, mime: 'application/pdf', data, text }).item.id;
    oStore.update(id, {
      status: would === 'auto_file' ? 'matched' : 'needs_review',
      extracted: extractFields(text, NOW),
      page_count: pages,
      ...(who ? { match: { decision: would === 'auto_file' ? 'auto' : 'review', reason: '', candidates: 1, patient: { patientId: '', chartPatientId: who.chartPatientId, name: `${who.firstName} ${who.lastName}`, dateOfBirth: who.dateOfBirth, mrn: who.mrn }, checked_at: new Date(clock).toISOString() } } : {}),
      shadow: { at: new Date(clock).toISOString(), would, code: would === 'auto_file' ? 'auto' : 'no_second_id', reason: '', ...(who ? { patient_key: who.chartPatientId } : {}), category },
    });
    return id;
  };
  const oA = mk('A', LAB, 0, 2, 'auto_file', PEOPLE.testpatient);
  const oB = mk('B', CONSULT, 30, 1, 'staff', PEOPLE.lightfoot, 'Consultant Letter');
  const oC = mk('C', 'LABORATORY REPORT\nno identifiers\n', 61, 3, 'auto_file', PEOPLE.testpatient);
  const oD = mk('D', 'LABORATORY REPORT\nother text\n', 62, 3, 'staff');
  const oE = mk('E', LAB.replace('TESTPATIENT, MARIGOLD J', 'ZEPHYR, QUILLON').replace('03/14/1961', '07/02/1958').replace('00482913', '771234').replace('QUEST DIAGNOSTICS', 'SNAKE RIVER LAB'), 0, 1, 'staff', PEOPLE.zephyr);
  const oF = mk('F', NOBODY, 5, 1, 'staff');
  // The EHR, as GetDocumentsByDocumentType / GetDocuments / GetDocumentImage answer it.
  const q = (id: string, sort: string, pages: number, display = 'Fax', extra: Record<string, string> = {}) => ({
    DocumentID: id, Status: 'Active', SortDate: sort, DisplayName: display, DocumentType: '(ready for indexing)', DocumentSubType: '-1000999', PageCnt: String(pages), PhysicalManifestation: 'Scan', AuthorName: 'Fax Server', ...extra,
  });
  const ehr: Record<string, any> = {
    Q1: q('Q1', '10/12/2026 10:04:00 AM', 2, 'Fax from QUEST DIAGNOSTICS'),
    Q2: q('Q2', '10/12/2026 10:31:00 AM', 1),
    Q3: q('Q3', '10/12/2026 11:01:00 AM', 3),
    Q4: q('Q4', '10/12/2026 11:03:00 AM', 3),
    Q9: q('Q9', '10/12/2026 10:05:00 AM', 7),
    C9: { DocumentID: 'C9', Status: 'Active', SortDate: '10/12/2026 02:10:00 PM', DisplayName: 'Outside lab', DocumentType: 'Labs/Procedures', DocumentSubType: 'LAB', PageCnt: '1', PatientID: '7002', ClinicalDate: '10/08/2026' },
  };
  const images: Record<string, Buffer> = { Q3: fileOf.C, Q4: fileOf.D };
  const oCalls: { action: string; params: any; pid: string }[] = [];
  const ehrUnity = {
    async executeAction(action: string, params: any = {}, pid = '') {
      oCalls.push({ action, params, pid });
      const rows = Object.values(ehr);
      if (action === 'GetDocumentsByDocumentType') {
        const want = params.Parameter1 === '-1000999' ? rows.filter((r) => r.DocumentSubType === '-1000999') : rows.filter((r) => r.DocumentType === params.Parameter1 && r.PatientID);
        return { success: true, data: [{ getdocumentsbydocumenttypeinfo: want }] };
      }
      if (action === 'GetDocuments') return { success: true, data: [{ getdocumentsinfo: rows.filter((r) => r.PatientID === pid).map(({ PatientID, ...r }) => r) }] };
      if (action === 'GetDocumentImage') return images[params.Parameter1] ? { success: true, data: [{ getdocumentimageinfo: [{ base64image: images[params.Parameter1].toString('base64') }] }] } : { success: false, error: 'not found' };
      return { success: true, data: [] }; // a write would "succeed" here: the guard must stop it first
    },
  };
  const obs = new observe.StaffFilingObserver({ store: () => oStore, unity: ehrUnity, runTool: liveSearch, now: () => new Date(clock) });
  // Run 1, two hours later: the queue is read and the same faxes linked.
  clock = T0 + 2 * 3_600_000;
  const run1 = await obs.run();
  assert.deepStrictEqual([run1.queue, run1.linked, run1.found], [5, 4, 0]);
  const qCall = oCalls.find((c) => c.action === 'GetDocumentsByDocumentType')!;
  assert.deepStrictEqual([qCall.params, qCall.pid], [{ Parameter1: '-1000999', Parameter2: '', Parameter3: '09/28/2026', Parameter4: '10/12/2026' }, ''], 'queue listing: type, no LOINC, MM/DD/YYYY window, PatientID blank');
  const imgCall = oCalls.find((c) => c.action === 'GetDocumentImage')!;
  assert.deepStrictEqual([imgCall.params.Parameter2, imgCall.params.Parameter3, imgCall.params.Parameter4], ['Scan', 'PDF', 'N'], 'image fetched as PDF to break the tie');
  const ledgerDocs = JSON.parse(fs.readFileSync(path.join(oStore.dir, 'observer.json'), 'utf8')).docs;
  assert.deepStrictEqual([ledgerDocs.Q1.item, ledgerDocs.Q2.item, ledgerDocs.Q3.item, ledgerDocs.Q4.item, ledgerDocs.Q9.item], [oA, oB, oC, oD, undefined], 'linked by time, pages, sender; the 3-page tie by the file itself; a 7-page fax never');
  assert.deepStrictEqual([oStore.get(oA)!.observed?.status, oStore.get(oA)!.observed?.in_queue], ['pending', true]);
  // Staff index Q1 to the predicted patient and Q2 to another patient than the candidate.
  Object.assign(ehr.Q1, { PatientID: '7001', DocumentType: 'Labs/Procedures', DocumentSubType: 'LAB' });
  Object.assign(ehr.Q2, { PatientID: '7002', DocumentType: 'Consultant Letter', DocumentSubType: 'CONS' });
  clock = T0 + 26 * 3_600_000;
  const run2 = await obs.run();
  assert.deepStrictEqual([run2.queue, run2.indexed], [3, 2]);
  const oa = oStore.get(oA)!.observed!;
  assert.deepStrictEqual([oa.status, oa.via, oa.patient?.key, oa.category, oa.document_id, oa.confidence], ['found', 'queue', '7001', 'Labs/Procedures', 'Q1', 'high'], 'indexed from the queue: patient and category');
  const ob = oStore.get(oB)!.observed!;
  assert.deepStrictEqual([ob.status, ob.patient?.key, ob.category], ['found', '7002', 'Consultant Letter'], 'found through the category listing (not in the candidate\'s chart)');
  const oe = oStore.get(oE)!.observed!;
  assert.deepStrictEqual([oe.status, oe.via, oe.patient?.key, oe.document_id, oe.confidence], ['found', 'chart', '7002', 'C9', 'medium'], 'no queue trail: found in the candidate\'s chart by date and pages (medium at most)');
  assert.deepStrictEqual([oStore.get(oC)!.observed?.status, oStore.get(oF)!.observed?.status], ['pending', 'pending']);
  const oById = (id: string) => oStore.get(id);
  assert.deepStrictEqual([shadow.agreement(oStore.get(oA)!, oById), shadow.agreement(oStore.get(oB)!, oById), shadow.unitTruth(oStore.get(oA)!, oById)?.source], ['agrees', 'disagrees', 'observed']);
  // Run 3, eight days on: still in the queue or never found = not observed, and never counted as correct.
  clock = T0 + 8 * 86_400_000;
  await obs.run();
  assert.deepStrictEqual([oC, oD, oF].map((id) => oStore.get(id)!.observed?.status), ['not_observed', 'not_observed', 'not_observed']);
  assert.deepStrictEqual([shadow.unitTruth(oStore.get(oC)!, oById), shadow.agreement(oStore.get(oC)!, oById)], [null, 'unconfirmed']);
  const oRep = report.buildShadowReport(oStore.list(), { now: new Date(clock) });
  assert.deepStrictEqual(
    [oRep.staff_agreement.observed, oRep.staff_agreement.same_patient, oRep.staff_agreement.patient_of, oRep.staff_agreement.candidate_other_patient, oRep.staff_agreement.same_category, oRep.auto_not_found, oRep.precision.right, oRep.precision.of, oRep.wrong_patient.total, oRep.truth_sources.observed, oRep.truth_sources.none],
    [3, 2, 3, 1, 3, 1, 1, 1, 0, 3, 3],
    'agreement with staff; the unobserved auto-file is listed to look at, not counted'
  );
  assert.ok(/Agreement with staff filing/.test(report.shadowReportMarkdown(oRep)));
  assert.ok(oCalls.every((c) => ['GetDocumentsByDocumentType', 'GetDocuments', 'GetDocumentImage'].includes(c.action)), 'reads only');
  const panel = ui.shadowPanel(oStore.get(oA)!, { byId: oById, categories: [] });
  assert.ok(/Filed by staff to Marigold Testpatient/.test(panel) && /From staff filing/.test(panel));
  // The guard holds even if the observer were asked to write.
  const guardCalls: string[] = [];
  const guarded = new observe.StaffFilingObserver({ store: () => oStore, unity: { async executeAction(a: string) { guardCalls.push(a); return { success: true, data: [] }; } }, runTool: liveSearch });
  await (guarded as any).unity.executeAction('SaveScanDocument', {}, '7001');
  await (guarded as any).unity.executeAction('SaveTask', {}, '7001');
  assert.deepStrictEqual(guardCalls, []);
  ok('staff filing observer: queue listed by DocumentID (verified shapes), faxes linked by time/pages/sender and the file itself on ties, indexing seen in the chart or the category listing, chart fallback, not observed after the deadline; report agreement; reads only');

  // 12c. The indexing queue as the shadow-week source: read-only, one item per DocumentID, exact truth, never filed
  const qsrc = await import('../platform/modules/intake/queue-source');
  const { queueRef } = await import('../platform/modules/intake/store');
  let qClock = Date.parse('2026-10-14T16:00:00Z'); // 10:00 in Boise
  const vqStore = new IntakeStore(path.join(TMP, 'queue-source'), () => new Date(qClock));
  const qEhr: Record<string, any> = {
    V1: q('V1', '10/14/2026 09:10:00 AM', 2),
    V2: q('V2', '10/14/2026 09:20:00 AM', 1),
    V3: q('V3', '10/14/2026 09:30:00 AM', 2),
  };
  const qImages: Record<string, Buffer> = { V1: Buffer.from('%PDF-1.4 queue V1'), V2: Buffer.from('%PDF-1.4 queue V2'), V3: Buffer.from('%PDF-1.4 queue V1') };
  const qCalls: { action: string; params: any; pid: string }[] = [];
  const qUnity = {
    async executeAction(action: string, params: any = {}, pid = '') {
      qCalls.push({ action, params, pid });
      const rows = Object.values(qEhr);
      if (action === 'GetDocumentsByDocumentType') {
        const want = params.Parameter1 === '-1000999' ? rows.filter((r) => r.DocumentSubType === '-1000999') : rows.filter((r) => r.DocumentType === params.Parameter1 && r.PatientID);
        return { success: true, data: [{ getdocumentsbydocumenttypeinfo: want }] };
      }
      if (action === 'GetDocuments') return { success: true, data: [{ getdocumentsinfo: rows.filter((r) => r.PatientID === pid).map(({ PatientID, ...r }) => r) }] };
      if (action === 'GetDocumentImage') return qImages[params.Parameter1] ? { success: true, data: [{ getdocumentimageinfo: [{ base64image: qImages[params.Parameter1].toString('base64') }] }] } : { success: false, error: 'not found' };
      return { success: true, data: [] }; // a write would "succeed" here: the guard must stop it first
    },
  };
  const added: string[] = [];
  // Off unless asked; never in live mode.
  delete process.env.INTAKE_QUEUE_SOURCE;
  assert.strictEqual(qsrc.queueSourceState(), 'off');
  process.env.INTAKE_QUEUE_SOURCE = 'on';
  assert.strictEqual(qsrc.queueSourceState(), 'on');
  process.env.INTAKE_MODE = 'live';
  assert.strictEqual(qsrc.queueSourceState(), 'refused_live');
  const liveRun = await new qsrc.QueueSource({ store: () => vqStore, unity: qUnity, onAdded: (id) => added.push(id), now: () => new Date(qClock) }).run();
  assert.deepStrictEqual([liveRun.error_code, qCalls.length, vqStore.list().length], ['QUEUE_SOURCE_LIVE_MODE', 0, 0], 'live mode: no call, no item');
  process.env.INTAKE_MODE = 'shadow';
  process.env.INTAKE_QUEUE_PER_RUN = '2';
  const vqSrc = new qsrc.QueueSource({ store: () => vqStore, unity: qUnity, onAdded: (id) => added.push(id), now: () => new Date(qClock) });
  // Run 1: three documents waiting, two taken in (per-run cap), oldest first.
  const vr1 = await vqSrc.run();
  assert.deepStrictEqual([vr1.queue, vr1.added, vr1.deferred, vr1.known, vr1.errors], [3, 2, 1, 0, 0]);
  const lst = qCalls.find((c) => c.action === 'GetDocumentsByDocumentType')!;
  assert.deepStrictEqual([lst.params, lst.pid], [{ Parameter1: '-1000999', Parameter2: '', Parameter3: '09/30/2026', Parameter4: '10/14/2026' }, ''], 'queue listing: the queue type, the shared (observer) 14-day window, PatientID blank');
  assert.strictEqual(qCalls.filter((c) => c.action === 'GetDocumentsByDocumentType').length, 1);
  const img = qCalls.find((c) => c.action === 'GetDocumentImage')!;
  assert.deepStrictEqual([img.params.Parameter1, img.params.Parameter2, img.params.Parameter3, img.params.Parameter4], ['V1', 'Scan', 'PDF', 'N']);
  const v1 = vqStore.findBySourceRef(queueRef('V1'))!;
  const v2 = vqStore.findBySourceRef(queueRef('V2'))!;
  assert.deepStrictEqual([v1.source, v1.file?.mime, v1.history[0].action, added], ['veradigm_queue', 'application/pdf', 'read from the Veradigm® EHR indexing queue', [v1.id, v2.id]]);
  // Run 2: the two known documents are not fetched again; V3 (same bytes as V1) is passed over, and remembered.
  const imagesBefore = qCalls.filter((c) => c.action === 'GetDocumentImage').length;
  const vr2 = await vqSrc.run();
  assert.deepStrictEqual([vr2.added, vr2.known, vr2.skipped, qCalls.filter((c) => c.action === 'GetDocumentImage').length - imagesBefore], [0, 2, 1, 1]);
  const vr3 = await vqSrc.run();
  assert.deepStrictEqual([vr3.known, vr3.skipped, vqStore.list().length], [3, 0, 2], 'nothing fetched twice; one item per DocumentID');
  // A failed listing is an error, never "the queue is empty".
  const failing = new qsrc.QueueSource({ store: () => vqStore, unity: { async executeAction() { return { success: false, error: 'down' }; } }, onAdded: () => undefined });
  const rf = await failing.run();
  assert.deepStrictEqual([rf.errors, rf.queue, rf.error_code], [1, 0, 'GETDOCUMENTSBYDOCUMENTTYPE_FAILED']);
  // What the pipeline would record in shadow mode (decision and suggested patient), set directly here.
  for (const [it, key] of [[v1, '7001'], [v2, '7002']] as const) {
    vqStore.update(it.id, {
      status: 'matched',
      page_count: it === v1 ? 2 : 1,
      match: { decision: 'auto', reason: '', candidates: 1, patient: { patientId: '', chartPatientId: key, name: 'Synthetic Patient', dateOfBirth: '01/01/1970', mrn: '' }, checked_at: new Date(qClock).toISOString() },
      shadow: { at: new Date(qClock).toISOString(), would: 'auto_file', code: 'auto', reason: '', patient_key: key, category: 'Labs/Procedures' },
    });
  }
  // Staff index V1 to patient 7001 as Labs/Procedures; V2 still waits.
  Object.assign(qEhr.V1, { PatientID: '7001', DocumentType: 'Labs/Procedures', DocumentSubType: 'LAB' });
  qClock += 3_600_000;
  const qObs = new observe.StaffFilingObserver({ store: () => vqStore, unity: qUnity, runTool: liveSearch, now: () => new Date(qClock) });
  const or1 = await qObs.run();
  assert.strictEqual(or1.linked, 2, 'both queue items linked by DocumentID');
  const o1 = vqStore.get(v1.id)!.observed!;
  assert.deepStrictEqual([o1.status, o1.via, o1.patient?.key, o1.category, o1.document_id, o1.confidence], ['found', 'queue', '7001', 'Labs/Procedures', 'V1', 'high'], 'exact truth: the same DocumentID, indexed by staff');
  assert.ok(o1.signals?.includes('same document, read from the indexing queue'));
  const o2 = vqStore.get(v2.id)!.observed!;
  assert.deepStrictEqual([o2.status, o2.in_queue, o2.document_id], ['pending', true, 'V2']);
  assert.deepStrictEqual([shadow.agreement(vqStore.get(v1.id)!, (id) => vqStore.get(id)), report.originOf(vqStore.get(v1.id)!)], ['agrees', 'Veradigm EHR indexing queue']);
  // Never filed: the original is already in Veradigm EHR, and a copy would leave a duplicate in the queue.
  const pre = filing.filingPreconditions({ ...vqStore.get(v1.id)!, document_type: { id: '1', name: 'Labs/Procedures', reason: 'kind' } as any }, 'chart');
  assert.ok(pre.some((p) => /already in the Veradigm® EHR indexing queue/.test(p)), 'chart filing refused');
  assert.ok(filing.filingPreconditions(vqStore.get(v1.id)!, 'indexing').some((p) => /indexing queue/.test(p)), 'send-to-indexing refused');
  assert.ok(qCalls.every((c) => ['GetDocumentsByDocumentType', 'GetDocuments', 'GetDocumentImage'].includes(c.action)), 'reads only');
  // The source's own guard: a write never reaches Veradigm, whatever it is asked.
  const gCalls: string[] = [];
  const gSrc = new qsrc.QueueSource({ store: () => vqStore, unity: { async executeAction(a: string) { gCalls.push(a); return { success: true, data: [] }; } }, onAdded: () => undefined });
  await (gSrc as any).unity.executeAction('SaveScanDocument', {}, '7001');
  await (gSrc as any).unity.executeAction('SaveTask', {}, '7001');
  assert.deepStrictEqual(gCalls, []);
  // The queue time is kept (not just when Drawbridge read it), and the shadow runs shared one queue listing.
  assert.strictEqual(vqStore.get(v1.id)!.queue_at, '2026-10-14T15:10:00.000Z', 'queue_at = SortDate (09:10 Boise)');
  assert.strictEqual(qCalls.filter((c) => c.action === 'GetDocumentsByDocumentType' && c.params.Parameter1 === '-1000999').length, 2, 'source runs 1-3 reuse one listing; the observer an hour later lists again');

  // One source per document: refused while a lab folder or the fax webhook also brings documents.
  process.env.INTAKE_WATCH_DIRS = path.join(TMP, 'lab');
  assert.strictEqual(qsrc.queueSourceState(), 'refused_mixed');
  assert.strictEqual((await vqSrc.run()).error_code, 'QUEUE_SOURCE_MIXED_SOURCES');
  delete process.env.INTAKE_WATCH_DIRS;
  process.env.MOATIT_FAX_WEBHOOK_SECRET = 'smoke-secret';
  assert.strictEqual(qsrc.queueSourceState(), 'refused_mixed');
  delete process.env.MOATIT_FAX_WEBHOOK_SECRET;

  // M1: a copy of the same document from another source never hands the queue item someone else's filing.
  let mClock = Date.parse('2026-10-15T16:00:00Z');
  const mStore = new IntakeStore(path.join(TMP, 'queue-copy'), () => new Date(mClock));
  const copyBytes = Buffer.from('%PDF-1.4 fax copy of D');
  const mEhr: Record<string, any> = { D: q('D', '10/15/2026 10:00:00 AM', 1), D2: q('D2', '10/15/2026 10:01:00 AM', 1) };
  const mImages: Record<string, Buffer> = { D: copyBytes, D2: Buffer.from('%PDF-1.4 another fax') };
  const mUnity = {
    async executeAction(action: string, params: any = {}, pid = '') {
      const rows = Object.values(mEhr);
      if (action === 'GetDocumentsByDocumentType') {
        const want = params.Parameter1 === '-1000999' ? rows.filter((r) => r.DocumentSubType === '-1000999') : rows.filter((r) => r.DocumentType === params.Parameter1 && r.PatientID);
        return { success: true, data: [{ getdocumentsbydocumenttypeinfo: want }] };
      }
      if (action === 'GetDocuments') return { success: true, data: [{ getdocumentsinfo: rows.filter((r) => r.PatientID === pid).map(({ PatientID, ...r }) => r) }] };
      if (action === 'GetDocumentImage') return { success: true, data: [{ getdocumentimageinfo: [{ base64image: mImages[params.Parameter1].toString('base64') }] }] };
      return { success: false, error: 'not expected' };
    },
  };
  const decided = (id: string, key: string) =>
    mStore.update(id, {
      status: 'matched',
      page_count: 1,
      match: { decision: 'auto', reason: '', candidates: 1, patient: { patientId: '', chartPatientId: key, name: 'Synthetic Patient', dateOfBirth: '01/01/1970', mrn: '' }, checked_at: new Date(mClock).toISOString() },
      shadow: { at: new Date(mClock).toISOString(), would: 'auto_file', code: 'auto', reason: '', patient_key: key, category: 'Labs/Procedures' },
    });
  const fId = mStore.addDocument({ source: 'folder', source_ref: 'watch:/lab:D.pdf', name: 'D.pdf', mime: 'application/pdf', data: copyBytes }).item.id;
  decided(fId, '7001');
  const mObs = new observe.StaffFilingObserver({ store: () => mStore, unity: mUnity, runTool: liveSearch, now: () => new Date(mClock) });
  mClock += 2 * 3_600_000;
  await mObs.run();
  assert.strictEqual(mStore.get(fId)!.observed?.document_id, 'D', 'the copy is first linked to D (same file)');
  mClock += 600_000;
  const qId = mStore.addDocument({ source: 'veradigm_queue', source_ref: queueRef('D'), name: 'queue-D.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 queue rendering of D') }).item.id;
  decided(qId, '7001');
  mClock += 3_600_000;
  await mObs.run();
  const mLedger = JSON.parse(fs.readFileSync(path.join(mStore.dir, 'observer.json'), 'utf8')).docs;
  assert.deepStrictEqual([mLedger.D.item, mLedger.D2.item], [qId, undefined], 'the queue item takes its own DocumentID; nobody is guessed onto D2');
  assert.deepStrictEqual([mStore.get(fId)!.observed?.status, mStore.get(fId)!.observed?.signals], ['ambiguous', [observe.SAME_AS_QUEUE]], 'the copy is set aside, not re-paired');
  Object.assign(mEhr.D, { PatientID: '7001', DocumentType: 'Labs/Procedures', DocumentSubType: 'LAB' });
  Object.assign(mEhr.D2, { PatientID: '9999', DocumentType: 'Labs/Procedures', DocumentSubType: 'LAB' });
  mClock += 3_600_000;
  await mObs.run();
  const mo = mStore.get(qId)!.observed!;
  assert.deepStrictEqual([mo.status, mo.document_id, mo.patient?.key, mo.confidence], ['found', 'D', '7001', 'high'], 'the queue item gets D\'s filing, never D2\'s');
  assert.deepStrictEqual([mStore.get(fId)!.observed?.status, Object.values(JSON.parse(fs.readFileSync(path.join(mStore.dir, 'observer.json'), 'utf8')).docs).filter((d: any) => d.item).length], ['ambiguous', 1]);

  // L1: a document whose image keeps failing is retried with backoff, then passed over (remembered across restarts).
  let fClock = Date.parse('2026-10-16T16:00:00Z');
  const fStore = new IntakeStore(path.join(TMP, 'queue-fail'), () => new Date(fClock));
  let fImageCalls = 0;
  const fUnity = {
    async executeAction(action: string) {
      if (action === 'GetDocumentsByDocumentType') return { success: true, data: [{ getdocumentsbydocumenttypeinfo: [q('E1', '10/16/2026 09:00:00 AM', 1)] }] };
      if (action === 'GetDocumentImage') {
        fImageCalls++;
        return { success: false, error: 'conversion failed' };
      }
      return { success: false, error: 'not expected' };
    },
  };
  const fSrc = () => new qsrc.QueueSource({ store: () => fStore, unity: fUnity, onAdded: () => undefined, now: () => new Date(fClock) });
  const f1 = await fSrc().run();
  assert.deepStrictEqual([f1.errors, f1.added, fImageCalls], [1, 0, 1]);
  fClock += 5 * 60_000;
  assert.deepStrictEqual([(await fSrc().run()).known, fImageCalls], [1, 1], 'waiting for the retry: not fetched (a new process remembers it)');
  for (let i = 0; i < 4; i++) {
    fClock += 3 * 3_600_000;
    await fSrc().run();
  }
  assert.strictEqual(fImageCalls, qsrc.MAX_FETCH_TRIES, `${qsrc.MAX_FETCH_TRIES} tries, then passed over`);
  fClock += 3 * 3_600_000;
  await fSrc().run();
  assert.strictEqual(fImageCalls, qsrc.MAX_FETCH_TRIES, 'never fetched again');
  const fState = JSON.parse(fs.readFileSync(path.join(fStore.dir, 'queue-source.json'), 'utf8'));
  assert.deepStrictEqual([Object.keys(fState.passed), Object.keys(fState.failures)], [['E1'], []], 'the state file holds DocumentIDs and reason codes only');
  assert.ok(/^fetch_failed_/.test(fState.passed.E1));
  assert.strictEqual(fs.statSync(path.join(fStore.dir, 'queue-source.json')).mode & 0o777 & (process.platform === 'win32' ? 0 : 0o077), 0, 'state file 0600');

  // M2: shadow-week copies are deleted by retention (30 days) or at once when the shadow week ends.
  assert.strictEqual(vqStore.purgeShadow(30), 0, 'nothing is 30 days old yet');
  const v1File = path.join(vqStore.filesDir, vqStore.get(v1.id)!.file!.stored_as);
  assert.ok(fs.existsSync(v1File));
  const purgedNow = vqStore.purgeShadow(0);
  const pv1 = vqStore.get(v1.id)!;
  assert.deepStrictEqual([purgedNow, fs.existsSync(v1File), pv1.has_text, pv1.file?.name, pv1.observed?.patient?.name, pv1.observed?.patient?.key, pv1.shadow?.patient_key, pv1.match?.patient?.chartPatientId], [2, false, false, 'document', '', '7001', '7001', '7001'], 'original and details removed; IDs for the report stay');
  assert.strictEqual(shadow.agreement(pv1, (id) => vqStore.get(id)), 'agrees', 'the report still works from the keys');
  assert.strictEqual(vqStore.purgeShadow(0), 0, 'idempotent');

  delete process.env.INTAKE_QUEUE_SOURCE;
  delete process.env.INTAKE_QUEUE_PER_RUN;
  ok('indexing queue as the shadow source: off by default, refused in live mode, one item per DocumentID (cap, no refetch, duplicates remembered), listing failure is an error, exact high-confidence truth by DocumentID, never filed (chart or indexing), reads only; one listing shared with the observer; queue time kept; one source per document; a copy never mislabels the queue item; failed fetches back off and stop; shadow copies purged by retention or at once');

  await intake.intakePipeline.idle();
  ocrSrv.srv.close();

  // 13. Logs carry no names, birth dates, MRNs, phones or document text
  const all = logged.join('\n');
  for (const bad of ['Testpatient', 'TESTPATIENT', 'Marigold', 'Zephyr', 'Lightfoot', 'Twinly', 'NOBODY', '1961', '482913', '771234', '555-0142', 'Creatinine', 'Smith John', 'correct horse']) {
    assert.ok(!all.includes(bad), `log leaks "${bad}"`);
  }
  ok(`logs (${logged.length} lines) hold IDs, counts and codes only`);

  console.log = orig.log;
  console.warn = orig.warn;
  console.error = orig.error;
  console.log(`\n${passed} checks passed`);
}

main()
  .catch((e) => {
    console.log = (globalThis as any).console.log;
    process.stderr.write(`FAIL ${e?.message || e}\n${e?.stack || ''}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode || 0), 50).unref?.();
  });
