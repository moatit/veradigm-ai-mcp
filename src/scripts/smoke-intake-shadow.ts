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
  ok('roster: header variants (BOM, ; tab, "Patient Name"), DOB formats, merge, skip, required columns, same search shape, staff search');

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
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
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

  // 11. Named staff logins (DRAWBRIDGE_USERS_FILE)
  const usersFile = path.join(TMP, 'users');
  const line = shell.hashStaffPassword('pat.reviewer', 'correct horse battery');
  assert.ok(/^pat\.reviewer:scrypt\$16384\$8\$1\$/.test(line) && !line.includes('correct horse'));
  assert.throws(() => shell.hashStaffPassword('pat', 'short'));
  fs.writeFileSync(usersFile, `${line}\n${shell.hashStaffPassword('lee.staff', 'another long password')}\n`);
  process.env.DRAWBRIDGE_USERS_FILE = usersFile;
  process.env.DRAWBRIDGE_USERNAME = 'shared';
  process.env.DRAWBRIDGE_PASSWORD = 'shared-password-123';
  const loginApp = express();
  loginApp.use('/app', shell.shellRouter());
  loginApp.get('/app/x', shell.requireLogin, (req: any, res) => res.send(`hello ${req.drawbridgeUser}`));
  const ls = await listen(loginApp);
  try {
    const login = (u: string, p: string) => fetch(`${ls.url}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ u, p, next: '/app/x' }) });
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
    assert.deepStrictEqual(await fetch(`${sv.url}/health`).then((r) => r.json()), { status: 'healthy', server: 'intake-shadow', mode: 'shadow', filing: 'impossible', patient_search: 'veradigm read-only' });
    const gate = await fetch(`${sv.url}/app/intake`, { redirect: 'manual' });
    assert.ok(gate.status === 302 && /\/app\/login/.test(gate.headers.get('location') || ''), 'staff screens need a login');
    assert.strictEqual((await fetch(`${sv.url}/unity/api/retell`, { method: 'POST' })).status, 404, 'no phone-agent endpoints');
    assert.strictEqual((await fetch(`${sv.url}/webhooks/moatit-fax`, { method: 'POST', body: '{}' })).status, 503, 'MOATiT Fax webhook closed until its secret is set');
  } finally {
    sv.srv.close();
  }
  ok('shadow server: intake only, health says filing impossible, login required, no agent endpoints, Unity locked to reads, fax webhook closed until configured');

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
