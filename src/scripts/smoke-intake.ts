/**
 * Offline checks for the document intake module (no network beyond 127.0.0.1, no credentials,
 * made-up patients only). Webhook HMAC (good / bad / missing), event allowlist, durable dedupe,
 * extraction on three synthetic documents (plus fax-OCR noise and a multi-patient batch), the match
 * decision table, document-type mapping, the pipeline with fake Veradigm and MOATiT Fax, the OCR
 * client and pipeline against a fake OCR server, the drop folder, the filing guard, screen
 * wording, and that logs never carry document content.
 *
 *   npm run smoke:intake
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-intake-'));
process.env.CALL_RECORDS_DIR = TMP;
process.env.INTAKE_DROP_DIR = path.join(TMP, 'inbox');
process.env.CLINIC_TIMEZONE = 'America/Boise';
for (const k of ['MOATIT_FAX_WEBHOOK_SECRET', 'MOATIT_FAX_BASE_URL', 'MOATIT_FAX_API_KEY', 'INTAKE_FILING', 'INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED', 'INTAKE_OCR_MIN_CONFIDENCE']) {
  delete process.env[k];
}
// The OCR container is not running here: OCR is off except where a fake OCR server is wired in.
process.env.INTAKE_OCR_URL = 'off';

import assert from 'assert';
import { createHmac } from 'crypto';
import type { AddressInfo } from 'net';

const SECRET = 'smoke-webhook-secret';
const sign = (body: string | Buffer, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const NOW = new Date('2026-10-09T15:00:00Z');

// ── Synthetic documents (made-up people, 555 numbers) ────────────────────────
const LAB = `QUEST DIAGNOSTICS   Fax: (208) 555-0190
LABORATORY REPORT
Patient Name: TESTPATIENT, MARIGOLD J        DOB: 03/14/1961
MRN: 00482913    Sex: F   Patient Phone: (208) 555-0142
Ordering Physician: Dr. Example
Date Collected: 10/08/2026 08:15   Reported: 10/08/2026 16:40

TEST                 RESULT   FLAG   REFERENCE RANGE   UNITS
Creatinine           2.4      H      0.6-1.1           mg/dL
eGFR                 22       L      >59               mL/min/1.73m2
Potassium            6.8      HH     3.5-5.1           mmol/L
Sodium               139             135-145           mmol/L
CRITICAL VALUE called to clinic RN at 16:35.
`;
const IMAGING = `From: Snake River Imaging Center
RADIOLOGY REPORT
RE: Zephyr, Quillon
D.O.B. 1958-07-02     Exam Date: Oct 7, 2026
EXAM: Renal ultrasound, complete
TECHNIQUE: Grayscale and color Doppler images.
FINDINGS: Kidneys are normal in size. No hydronephrosis.
IMPRESSION: No acute abnormality. No abnormal findings.
`;
const CONSULT = `Practice: Boise Valley Cardiology Associates
Consultation Note
Patient: Orrin B. Lightfoot    DOB: 9/5/49
Date of Service: 10-06-2026

Dear Dr. Example,
Thank you for referring Mr. Lightfoot for evaluation of hypertension.
History of Present Illness: ...
Assessment and Plan: Continue current regimen. Follow up in 3 months.
`;

async function main(): Promise<void> {
  const fax = await import('../platform/modules/intake/moatit-fax');
  const { IntakeStore, intakeStore } = await import('../platform/modules/intake/store');
  const { extractFields, normalizeDate, parseName, classifySubtype } = await import('../platform/modules/intake/extract');
  const { decideMatch, matchPatient } = await import('../platform/modules/intake/match');
  const { DocTypeCache, mapKindToType, parseDocumentTypes, categoryOverrides } = await import('../platform/modules/intake/doctypes');
  const filing = await import('../platform/modules/intake/file');
  const { scanDropFolder } = await import('../platform/modules/intake/folder');
  const { IntakePipeline, OCR_MAX_WAITS, autoFileBlocker } = await import('../platform/modules/intake/pipeline');
  const intake = await import('../platform/modules/intake');
  const { UnityActions } = await import('../unity/config/unity-endpoints');
  const express = (await import('express')).default;

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // Capture everything logged while intake code runs; checked for leaks at the end.
  const logged: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const capture = (fn: (...a: any[]) => void) => (...a: any[]) => {
    logged.push(a.map(String).join(' '));
    fn(...a);
  };
  console.warn = capture(orig.warn);
  console.error = capture(orig.error);
  const quiet = <T,>(f: () => T): T => {
    const l = console.log;
    console.log = (...a: any[]) => logged.push(a.map(String).join(' '));
    try {
      return f();
    } finally {
      console.log = l;
    }
  };

  // 1. HMAC verification
  const body = JSON.stringify({ event: 'fax.received', job_id: 'job_abc123', pages: 2 });
  const h = (over: Record<string, string> = {}) => ({
    'x-webhook-signature': sign(body),
    'x-webhook-event': 'fax.received',
    'x-webhook-id': 'fax:job_abc123:fax.received',
    'x-webhook-attempt': '1',
    ...over,
  });
  assert.strictEqual(fax.verifyFaxWebhook(body, h(), undefined).status, 503, 'closed without a secret');
  assert.strictEqual(fax.verifyFaxWebhook(body, h(), '').status, 503);
  const good = fax.verifyFaxWebhook(Buffer.from(body), h(), SECRET);
  assert.ok(good.ok && good.job_id === 'job_abc123' && good.webhook_id === 'fax:job_abc123:fax.received');
  assert.ok(fax.verifyFaxWebhook(body, h({ 'x-webhook-signature': sign(body).toUpperCase().replace('SHA256=', 'sha256=') }), SECRET).ok, 'hex case-insensitive');
  assert.strictEqual(fax.verifyFaxWebhook(body, h({ 'x-webhook-signature': sign(body, 'other-secret') }), SECRET).status, 401, 'wrong key');
  assert.strictEqual(fax.verifyFaxWebhook(body + ' ', h(), SECRET).status, 401, 'tampered body');
  assert.strictEqual(fax.verifyFaxWebhook(body, h({ 'x-webhook-signature': '' }), SECRET).status, 401, 'missing signature');
  assert.strictEqual(fax.verifyFaxWebhook(body, h({ 'x-webhook-signature': 'sha256=abc' }), SECRET).status, 401, 'malformed signature');
  assert.strictEqual(fax.verifyFaxWebhook(body, h({ 'x-webhook-signature': createHmac('sha256', SECRET).update(body).digest('hex') }), SECRET).status, 401, 'no sha256= prefix');
  ok('webhook HMAC: good accepted, bad/missing/tampered rejected (401), closed when unconfigured (503)');

  // 2. Event allowlist and webhook ID
  assert.strictEqual(fax.verifyFaxWebhook(body, h({ 'x-webhook-event': 'fax.sent', 'x-webhook-id': 'fax:job_abc123:fax.sent' }), SECRET).status, 400);
  assert.strictEqual(fax.verifyFaxWebhook(body, h({ 'x-webhook-event': '' }), SECRET).status, 400);
  assert.strictEqual(fax.verifyFaxWebhook(body, h({ 'x-webhook-id': 'fax:../../etc:fax.received' }), SECRET).status, 400, 'unsafe job id');
  assert.strictEqual(fax.verifyFaxWebhook(body, h({ 'x-webhook-id': 'fax:job_abc123:fax.failed' }), SECRET).status, 400, 'id/event mismatch');
  assert.strictEqual(fax.verifyFaxWebhook(body, h({ 'x-webhook-id': '' }), SECRET).status, 400);
  assert.strictEqual(fax.verifyFaxWebhook(body, h({ 'x-webhook-signature': 'nope', 'x-webhook-event': 'fax.sent' }), SECRET).status, 401, 'signature checked before event');
  ok('event allowlist: only fax.received with a matching fax:<job>:<event> ID');

  // 3. Durable dedupe
  const store = new IntakeStore(path.join(TMP, 'dedupe'), () => NOW);
  const d1 = fax.handleFaxDelivery(Buffer.from(body), h(), store, SECRET);
  const d2 = fax.handleFaxDelivery(Buffer.from(body), h({ 'x-webhook-attempt': '2' }), store, SECRET);
  assert.deepStrictEqual([d1.status, d1.duplicate, d2.status, d2.duplicate], [204, false, 204, true]);
  assert.strictEqual(d1.item_id, d2.item_id);
  const reopened = new IntakeStore(path.join(TMP, 'dedupe'));
  assert.strictEqual(reopened.list().length, 1, 'recorded on disk before the 2xx');
  assert.strictEqual(fax.handleFaxDelivery(Buffer.from(body), h(), reopened, SECRET).duplicate, true, 'dedupe survives a restart');
  const mism = JSON.stringify({ job_id: 'job_other' });
  assert.strictEqual(fax.handleFaxDelivery(Buffer.from(mism), h({ 'x-webhook-signature': sign(mism) }), store, SECRET).status, 400, 'body/header job mismatch');
  const notJson = 'not json';
  assert.strictEqual(fax.handleFaxDelivery(Buffer.from(notJson), h({ 'x-webhook-signature': sign(notJson) }), store, SECRET).status, 400);
  const pdf = Buffer.from('%PDF-1.4\n% synthetic test document\n%%EOF\n');
  const a1 = store.addDocument({ source: 'upload', source_ref: '', name: 'a.pdf', mime: 'application/pdf', data: pdf });
  const a2 = store.addDocument({ source: 'folder', source_ref: 'folder:other-name.pdf', name: '../../other.pdf', mime: 'application/pdf', data: pdf });
  assert.deepStrictEqual([a1.duplicate, a2.duplicate, a2.item.id], [false, true, a1.item.id], 'same bytes = same document');
  assert.ok(/^in_/.test(a1.item.file!.stored_as) && a1.item.file!.sha256.length === 64);
  assert.ok(!fs.readdirSync(path.join(TMP, 'dedupe')).some((f) => f.endsWith('.tmp')), 'no temp files left');
  ok('dedupe: by webhook ID (durable across restarts) and by file hash');

  // 4. Webhook route over 127.0.0.1 (raw body survives the app-wide JSON parser)
  const routeStore = new IntakeStore(path.join(TMP, 'route'));
  const app = express();
  fax.mountFaxWebhook(app, { store: () => routeStore });
  app.use(express.json());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/moatit-fax`;
  const post = (headers: Record<string, string>) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }).then((r) => r.status);
  const recorded: string[] = [];
  fax.setFaxRecordedHandler((id) => recorded.push(id));
  try {
    assert.strictEqual(await post(h()), 503);
    process.env.MOATIT_FAX_WEBHOOK_SECRET = SECRET;
    assert.strictEqual(await post(h({ 'x-webhook-signature': sign(body, 'nope') })), 401);
    assert.strictEqual(await post(h({ 'x-webhook-event': 'fax.sent', 'x-webhook-id': 'fax:job_abc123:fax.sent' })), 400);
    const l = console.log;
    console.log = capture(() => undefined);
    try {
      assert.strictEqual(await post(h()), 204);
      assert.strictEqual(await post(h({ 'x-webhook-attempt': '2' })), 204);
    } finally {
      console.log = l;
    }
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(routeStore.list().length, 1);
    assert.strictEqual(recorded.length, 1, 'processing scheduled once');
  } finally {
    delete process.env.MOATIT_FAX_WEBHOOK_SECRET;
    fax.setFaxRecordedHandler(null);
    server.close();
  }
  ok('POST /webhooks/moatit-fax: 503 unconfigured, 401 bad signature, 400 bad event, 204 recorded and duplicate');

  // 5. Extraction on three synthetic documents
  const lab = extractFields(LAB, NOW);
  assert.deepStrictEqual(lab.patient_name, { value: { first: 'Marigold', last: 'Testpatient', full: 'Marigold J Testpatient' }, confidence: 'high' });
  assert.deepStrictEqual([lab.dob?.value, lab.dob?.confidence], ['03/14/1961', 'high']);
  assert.deepStrictEqual([lab.mrn?.value, lab.mrn?.confidence], ['00482913', 'high']);
  assert.deepStrictEqual([lab.phone?.value, lab.phone?.confidence], ['2085550142', 'high']);
  assert.strictEqual(lab.sender?.value, 'Quest Diagnostics');
  assert.strictEqual(lab.collection_date?.value, '10/08/2026');
  assert.strictEqual(lab.kind.value, 'lab_result');
  assert.ok(lab.abnormal.flagged && lab.abnormal.critical);
  assert.deepStrictEqual(lab.abnormal.markers, ['CRITICAL', 'H', 'HH', 'L']);
  assert.strictEqual(lab.abnormal.flagged_lines, 3, 'Sodium (no flag) and units like mmol/L are not flags');

  const img = extractFields(IMAGING, NOW);
  assert.deepStrictEqual([img.patient_name?.value.first, img.patient_name?.value.last, img.patient_name?.confidence], ['Quillon', 'Zephyr', 'medium']);
  assert.strictEqual(img.dob?.value, '07/02/1958');
  assert.strictEqual(img.mrn, undefined);
  assert.deepStrictEqual([img.sender?.value, img.sender?.confidence], ['Snake River Imaging Center', 'high']);
  assert.deepStrictEqual([img.collection_date?.value, img.collection_date?.confidence], ['10/07/2026', 'medium']);
  assert.strictEqual(img.kind.value, 'imaging');
  assert.deepStrictEqual([img.abnormal.flagged, img.abnormal.critical], [false, false], '"No abnormal findings" is not a flag');

  const con = extractFields(CONSULT, NOW);
  assert.deepStrictEqual([con.patient_name?.value.full, con.patient_name?.confidence], ['Orrin B. Lightfoot', 'high']);
  assert.strictEqual(con.dob?.value, '09/05/1949', 'two-digit birth year goes to the past');
  assert.strictEqual(con.sender?.value, 'Boise Valley Cardiology Associates');
  assert.strictEqual(con.collection_date?.value, '10/06/2026');
  assert.strictEqual(con.kind.value, 'consult');
  assert.strictEqual(con.abnormal.flagged, false);
  assert.strictEqual(con.phone, undefined);

  assert.strictEqual(normalizeDate('8 Oct 2026', { now: NOW }), '10/08/2026');
  assert.strictEqual(normalizeDate('October 8th, 2026', { now: NOW }), '10/08/2026');
  assert.strictEqual(normalizeDate('10.08.2026', { now: NOW }), '10/08/2026');
  assert.strictEqual(normalizeDate('02/30/1960', { now: NOW }), '', 'impossible date');
  assert.strictEqual(normalizeDate('01/01/2030', { pastOnly: true, now: NOW }), '', 'future birth date');
  assert.strictEqual(parseName('Results pending 123'), null);
  assert.strictEqual(extractFields('Fax cover sheet. Pages: 3', NOW).kind.value, 'other');
  assert.strictEqual(lab.patient_count, 1);
  ok('extraction: name, DOB (several formats), MRN, phone, sender, collection date, kind, abnormal flags on 3 synthetic documents');

  // 5b. Fax OCR noise, plain "Phone:" in the patient block, surname particles, multi-patient batch
  const NOISY = `From: LARKSPUR REF LAB 2085550151   Page 1/2   10/09/2026 08:14
LARKSPUR REFERENCE LABORATORIES                         LABORATORY REPORT
Meridian, ID 83642  Tel 208-555-0150  Fax 208-555-0151
| Patient Name; TESTPATIENT, MARIGOLD J              Specimen ID; LR1234567
D,O.B, 3/14/1961    Sex: F                            Collactad: 10/08/2026 06:24
Patient 1D: 4824913                                    Received: 10/08/2026 10:13
Critical values are telephoned to the ordering client per laboratory policy.
Hemoglobin A1c         7.9 %       *H     (<5.7)
Potassium              6.9 (C)            3.5-5.1 mmol/L
`;
  const noisy = extractFields(NOISY, NOW);
  assert.deepStrictEqual([noisy.patient_name?.value.last, noisy.patient_name?.confidence, noisy.dob?.value], ['Testpatient', 'high', '03/14/1961']);
  assert.deepStrictEqual([noisy.mrn?.value, noisy.mrn?.confidence], ['4824913', 'medium'], '"Patient 1D" read as Patient ID');
  assert.strictEqual(noisy.collection_date?.value, '10/08/2026', '"Collactad" still a collection date');
  assert.strictEqual(noisy.sender?.value, 'LARKSPUR REFERENCE LABORATORIES', 'letterhead, not the fax machine header');
  assert.deepStrictEqual([noisy.abnormal.critical, noisy.abnormal.markers], [true, ['C', 'H']], '*H and (C); the policy line is not a critical value');
  const clinic = extractFields('Juniper Flats Family Clinic   Tel: (208) 555-0150\nName: Van Wyk, Maxine\nDOB: 02/03/1950\nPhone: (986) 555-0123\n', NOW);
  assert.deepStrictEqual([clinic.phone?.value, clinic.phone?.confidence], ['9865550123', 'medium'], 'plain Phone: inside the patient block');
  assert.strictEqual(extractFields('Phone: (986) 555-0123\nRE: Maxine Van Wyk\nDOB: 02/03/1950', NOW).phone?.confidence, 'low', 'plain Phone: before the patient block');
  assert.deepStrictEqual(parseName('Maxine Van Wyk'), { first: 'Maxine', last: 'Van Wyk', full: 'Maxine Van Wyk' });
  assert.strictEqual(parseName('Report attached'), null);
  assert.strictEqual(extractFields('RE: Lab results\nPatient: Orrin Lightfoot  DOB: 9/5/49', NOW).patient_name?.value.last, 'Lightfoot');
  const BATCH = `SAWTOOTH RAPID LAB - DAILY BATCH RESULTS
PT: TESTPATIENT,MARIGOLD      DOB: 1961-03-14   SEX: F
MRN: 482913                   COLL: 10/08/2026 06:45
  CREAT     2.41H  (0.60-1.30) mg/dL
PT! ZEPHYR,QUILLON            DOB: 1958-07-02   SEX: M
MRN: 771234                   COLL: 10/08/2026 07:10
`;
  const batch = extractFields(BATCH, NOW);
  assert.deepStrictEqual([batch.patient_count, batch.patient_name?.value.last, batch.kind.value], [2, 'Testpatient', 'lab_result']);
  assert.strictEqual(extractFields(BATCH.split('PT! ZEPHYR')[0] + 'PT: TESTPATIENT,MARIGOLD  DOB: 1961-03-14\n', NOW).patient_count, 1, 'a repeated header is one patient');
  assert.strictEqual(extractFields(BATCH.replace('1958-07-02', '1961-03-14').replace('ZEPHYR,QUILLON', 'TESTPATIENT,MARIGOLO').replace('771234', '482918'), NOW).patient_count, 1, 'OCR noise is not a second patient');
  const lostLabels = BATCH.replace('PT: TESTPATIENT,MARIGOLD      DOB:', 'Pri TESTPATIENT,MARIGOLD      NOB:').replace('MRN: 482913', 'PATIENT ID! 482913');
  assert.deepStrictEqual([extractFields(lostLabels, NOW).patient_count, extractFields(lostLabels, NOW).patient_name?.value.last], [2, 'Zephyr'], 'two MRNs = two patients even when one name/DOB label is lost');
  const unread = extractFields('Patient: Marigold Testpatient\nDOB: 03/14/1961\nMed Ree #: ?????\nPatient Phone: (208) 555-0142', NOW);
  assert.deepStrictEqual([unread.mrn, unread.mrn_unreadable], [undefined, true]);
  assert.strictEqual(extractFields(IMAGING + 'IMPRESSION: Findings consistent with medical renal disease.\n', NOW).mrn_unreadable, undefined, 'prose is not an MRN label');
  ok('extraction under fax OCR noise: ";" "!" "," for ":", D,O.B., Patient 1D, Collactad, letterhead sender, *H / (C) flags, patient-block phone, particles, multi-patient count');

  // 5c. Pages: per-page text, sender lists, which patient each page belongs to
  const pages = await import('../platform/modules/intake/pages');
  assert.deepStrictEqual(pages.splitPages('a\f\nb\f'), ['a', '\nb'], 'trailing form feed dropped');
  assert.deepStrictEqual(pages.splitPages('a\fb\f', 3), ['a', 'b', ''], 'a blank last page kept when the count says so');
  assert.deepStrictEqual(pages.splitPages('no breaks'), ['no breaks']);
  assert.strictEqual(pages.pagesFromMarkers('--- Page 1 ---\nalpha\n\n--- Page 3 ---\ngamma', 3), 'alpha\f\fgamma', 'MOATiT Fax markers; a blank page 2 comes back empty');
  assert.strictEqual(pages.pagesFromMarkers('plain text'), 'plain text');
  const job = fax.parseFaxJob({ id: 7, page_count: 3, ocr: { status: 'complete', raw_text: '--- Page 1 ---\nA\n\n--- Page 2 ---\nB\n\n--- Page 3 ---\nC' }, from_number: '+12085550163' });
  assert.deepStrictEqual([job.text, job.page_count, job.ocr_state], ['A\fB\fC', 3, 'complete'], 'MOATiT Fax enterprise ocr.raw_text is read, page by page');
  process.env.INTAKE_BATCH_SENDERS = ' Sawtooth Rapid Lab , 208-555-0163';
  assert.ok(pages.isListedSender('INTAKE_BATCH_SENDERS', { sender: 'SAWTOOTH RAPID LAB' }));
  assert.ok(pages.isListedSender('INTAKE_BATCH_SENDERS', { sender: 'S4WTOOTH', text: 'x\nSAWTOOTH  RAPID LAB - DAILY BATCH' }), 'the name anywhere in the text counts (OCR may misread one copy)');
  assert.ok(pages.isListedSender('INTAKE_BATCH_SENDERS', { senderFax: '+1 (208) 555-0163' }), 'a fax number entry matches the sending fax');
  assert.ok(!pages.isListedSender('INTAKE_BATCH_SENDERS', { sender: 'Larkspur Reference Laboratories', senderFax: '2085550151', text: 'call 208-555-0163' }), 'a number entry never matches text');
  delete process.env.INTAKE_BATCH_SENDERS;
  assert.ok(!pages.isListedSender('INTAKE_BATCH_SENDERS', { sender: 'SAWTOOTH RAPID LAB' }), 'empty list');

  const HEAD = 'SAWTOOTH RAPID LAB - DAILY BATCH RESULTS\nBATCH: 20261009-03   RUN DATE: 10/09/2026\n';
  const pt = (name: string, dob: string, mrn: string, cont = '') => `${HEAD}PT: ${name.padEnd(26)} DOB: ${dob}   SEX: F${cont}\nMRN: ${mrn}                ACC#: SR1001   COLL: 10/08/2026 06:45\n  CREAT      2.41H (0.60-1.30) mg/dL\n  K           4.1  (3.5-5.1) mmol/L\n`;
  const RESULTS_ONLY = `${HEAD}  BUN          31H (7-20) mg/dL\n  PHOS        5.2H (2.5-4.5) mg/dL\n`;
  const COVER = 'FAX\nSawtooth Rapid Lab\nTo:     Idaho Kidney Institute\nFrom:   Sawtooth Rapid Lab\nPages:  4 (including cover)\nRE:     Lab results\nCONFIDENTIALITY NOTICE: protected health information.';
  const A = (c = '') => pt('TESTPATIENT,MARIGOLD', '1961-03-14', '482913', c);
  const B = pt('ZEPHYR,QUILLON', '1958-07-02', '771234');
  const C = pt('LIGHTFOOT,ORRIN', '1949-09-05', '330017');
  const seg = (texts: string[], batch: boolean, more: Partial<Parameters<typeof pages.segmentPages>[1]> = {}) =>
    pages.segmentPages(texts, { batch, wholeCount: extractFields(texts.join('\f'), NOW).patient_count ?? 0, expectedPages: texts.length, now: NOW, ...more });
  const sp1 = seg([COVER, A(), A('  (CONTINUED)'), B, C], true);
  assert.deepStrictEqual([sp1.decision, sp1.cover_pages, sp1.patients.map((g) => g.pages)], ['split', [1], [[2, 3], [4], [5]]], 'batch: one part per patient, cover kept out');
  assert.deepStrictEqual([seg([A(), A('  (CONTINUED)')], true).decision, seg([A(), A('  (CONTINUED)')], true).checked], ['single', true], 'batch, one patient on every page');
  // The blind spot: the second patient's identifiers are all unreadable, so the file looks like one patient.
  const blind = seg([A(), RESULTS_ONLY], true);
  assert.deepStrictEqual([blind.decision, /Page 2 has no readable patient identifier/.test(blind.reason)], ['review', true], 'batch sender: a page without an identifier sends the whole file to staff');
  assert.strictEqual(seg([A(), RESULTS_ONLY], false).decision, 'single', 'other senders: one patient on the document, filed whole as before');
  const contd = seg([A(), RESULTS_ONLY, B], false);
  assert.deepStrictEqual([contd.decision, contd.patients.map((g) => g.pages)], ['split', [[1, 2], [3]]], 'other senders: a continuation page goes with the patient before it');
  assert.strictEqual(seg([A(), RESULTS_ONLY, B], true).decision, 'review', 'batch sender: no continuation pages');
  assert.match(seg([A(), B, A()], true).reason, /also appears on page 1, with another patient in between/, 'pages of one patient not contiguous');
  assert.match(seg([A() + B, C], true).reason, /Page 1 shows more than one patient/);
  const dropMrn = (t: string) => t.replace(/MRN: \d*/, 'ACCT:');
  assert.match(seg([dropMrn(A()), dropMrn(pt('TESTPATIENT,MARIGOLD', '1961-03-15', '')), B], true).reason, /almost, but not exactly/, 'a DOB one digit off: never merged, never split');
  assert.deepStrictEqual(seg([A(), pt('TESTPATIENT,MARIGOLO', '1961-03-14', '482913'), B], true).patients.map((g) => g.pages), [[1, 2], [3]], 'the same MRN read exactly: OCR noise in the name is the same patient');
  assert.match(seg([A(), pt('TESTPATIENT,MARIGOLD', '1961-03-14', '482918'), B], true).reason, /almost, but not exactly/, 'an MRN one digit off is not the same MRN');
  assert.deepStrictEqual(seg([COVER.replace('Lab results', 'TESTPATIENT, MARIGOLD J'), A(), B], true).cover_pages, [1], 'a cover sheet naming the patient (no DOB) is still a cover');
  // A packed batch: page 2 starts with the end of the first patient's results, then the next patient.
  const packed2 = `${HEAD}  BUN          31H (7-20) mg/dL\n  PHOS        5.2H (2.5-4.5) mg/dL\n--------------------\n${B.slice(HEAD.length)}`;
  assert.match(seg([A(), packed2], true).reason, /Page 2 has results above its patient line/, 'results above a new patient line: review, never given to that patient');
  assert.match(seg([A(), packed2], false).reason, /Page 2 has results above its patient line/, 'the same for any sender');
  // A packed page: the first patient's line on top, a second patient below whose line is unreadable.
  const hidden = `${A()}------------------------------------------\n##########  ######   #####\n  CREAT      1.10  (0.60-1.30) mg/dL\n  K           3.9  (3.5-5.1) mmol/L\n`;
  assert.match(seg([hidden], true).reason, /Page 1 has a block of results without a readable patient line/, 'in-page blind spot (ruled-off block without a patient line): review');
  assert.strictEqual(seg([`${A()}------------------------------------------\nEND OF BATCH 20261009-03   1 PATIENT(S)\n`], true).decision, 'single', 'a closing rule is not a block');
  assert.match(seg([pt('QUILLFEATHER,MARK', '1970-05-05', ''), pt('QUILLFEATHER,MARY', '1970-05-05', '')].map((t) => t.replace('MRN: ', 'ACCT: ')), true).reason, /almost, but not exactly/, 'twins Mark / Mary: staff decide');
  assert.match(seg([A(), B], true, { expectedPages: 3 }).reason, /text has 2 page\(s\) but the file has 3/, 'page count mismatch');
  assert.match(seg([A(), B], false, { split: false }).reason, /splitting is turned off/);
  assert.strictEqual(seg([A(), B], true, { expectedPages: undefined }).decision, 'split', 'page count from the text when the source did not say');
  assert.match(seg([A().replace(/MRN: \d+/, 'MRN: ').replace('DOB: 1961-03-14', 'DOB: ??')], true, { expectedPages: undefined }).reason, /page count of the file is unknown/);
  assert.match(seg([A(), A().replace(/DOB: [\d-]+/, 'DOB: ????').replace(/MRN: \d+/, 'MRN: ')], true).reason, /Page 2 has no readable patient name and date of birth or MRN/, 'batch: a name alone is not enough');
  assert.strictEqual(seg([A(), A().replace(/DOB: [\d-]+/, 'DOB: ????').replace(/MRN: \d+/, 'MRN: '), B], false).decision, 'split', 'other senders: a name that agrees is enough for a continuation page');
  assert.strictEqual(pages.segmentPages([LAB], { batch: false, wholeCount: 1, now: NOW }).checked, false, 'other single-patient documents are not re-read page by page');
  ok('pages: form feeds and MOATiT Fax markers, sender lists (name, text, fax number), split by patient, cover sheets, continuation rules, and every doubt (blind spot, non-contiguous, two on a page, near-identical, page count) goes to review');

  // 6. Match decision table
  const cand = (o: Partial<Record<string, any>> = {}) => ({
    patientId: '9001', chartPatientId: '7001', firstName: 'Marigold', lastName: 'Testpatient',
    dateOfBirth: '3/14/1961', mrn: '482913', phones: ['208-555-0142'], ...o,
  });
  const noMrn = { ...lab, mrn: undefined };
  const noMrnNoPhone = { ...lab, mrn: undefined, phone: undefined };
  const table: [string, any, any[], string, string?][] = [
    ['MRN agrees (leading zeros ignored)', lab, [cand()], 'auto', 'mrn'],
    ['exact name + DOB + phone', noMrn, [cand({ mrn: '' })], 'auto', 'phone'],
    ['candidate has no MRN, phone agrees', lab, [cand({ mrn: '' })], 'auto', 'phone'],
    ['name + DOB only', noMrnNoPhone, [cand()], 'review'],
    ['MRN conflict', lab, [cand({ mrn: '555' })], 'review'],
    ['phone differs', noMrn, [cand({ mrn: '', phones: ['2085550000'] })], 'review'],
    ['nickname + phone (not exact name)', noMrn, [cand({ firstName: 'Marigoldie', mrn: '' })], 'review'],
    ['no EHR chart', lab, [cand({ chartPatientId: '' })], 'review'],
    ['low-confidence phone ignored', { ...noMrn, phone: { value: '2085550142', confidence: 'low' } }, [cand({ mrn: '' })], 'review'],
    ['nobody', lab, [], 'none'],
    ['DOB differs', lab, [cand({ dateOfBirth: '03/14/1962' })], 'none'],
    ['no DOB on the document', { ...lab, dob: undefined }, [cand()], 'none'],
    ['two patients', lab, [cand(), cand({ patientId: '9002', chartPatientId: '7002', mrn: '482913' })], 'ambiguous'],
    ['document MRN = the EHR chart MRN (PatientNumber)', lab, [cand({ mrn: '17804', mrns: ['17804', '482913'] })], 'auto', 'mrn'],
    ['document MRN = neither MRN', lab, [cand({ mrn: '17804', mrns: ['17804', '186770'] })], 'review'],
    ['two patients named on the document', { ...lab, patient_count: 2 }, [cand()], 'ambiguous'],
    ['MRN label unreadable, phone agrees', { ...noMrn, mrn_unreadable: true }, [cand({ mrn: '' })], 'review'],
  ];
  for (const [label, ex, cands, want, second] of table) {
    const r = decideMatch(ex, cands);
    assert.strictEqual(r.decision, want, `${label}: got ${r.decision}`);
    if (second) assert.strictEqual(r.second_identifier, second, label);
    if (want === 'auto') assert.strictEqual(r.patient?.chartPatientId, '7001');
  }
  const calls: any[] = [];
  const fakeRun = async (name: string, args: any) => {
    calls.push([name, args]);
    return { patients: [{ ...cand(), phone: { home: '(208) 555-0142' } }], total: 1 };
  };
  const m1 = await matchPatient(lab, fakeRun, () => NOW);
  assert.deepStrictEqual([m1.decision, m1.checked_at], ['auto', NOW.toISOString()]);
  assert.deepStrictEqual(calls[0], ['unity_search_patients', { lastName: 'Testpatient', firstName: 'Marigold', dateOfBirth: '03/14/1961' }]);
  const both = await matchPatient(lab, async () => ({ patients: [{ ...cand(), mrn: '17804', patientNumber: '482913' }], total: 1 }), () => NOW);
  assert.deepStrictEqual([both.decision, both.second_identifier], ['auto', 'mrn'], 'search rows carry PM MRN and EHR PatientNumber; either agrees');
  const failed = await matchPatient(lab, async () => ({ success: false, error_code: 'NETWORK_ERROR', retryable: true, tool: 'x', message: 'x' }));
  assert.deepStrictEqual([failed.decision, failed.error_code], ['error', 'NETWORK_ERROR'], 'a failed search is an error, never "no match"');
  const thrown = await matchPatient(lab, async () => {
    throw new Error('boom');
  });
  assert.strictEqual(thrown.decision, 'error');
  assert.strictEqual((await matchPatient(lab, async () => ({ weird: true }))).decision, 'error');
  const before = calls.length;
  assert.strictEqual((await matchPatient({ ...lab, dob: undefined }, fakeRun)).decision, 'none');
  assert.strictEqual(calls.length, before, 'no search without name + DOB');
  ok(`match decision table (${table.length} cases) + search failures are errors`);

  // 7. Document types
  const typeRows = [
    {
      getdocumenttypeinfo: [
        { DisplayName: '(ready for indexing)', EntryCode: '-1000999', ID: '1', DocumentFormat: 'Image', Archived: 'N' },
        { DisplayName: 'Labs/Procedures', EntryCode: 'LAB', ID: '12', DocumentFormat: 'Image', Archived: 'N' },
        { DisplayName: 'Consultant Letter', EntryCode: 'CONS', ID: '15', DocumentFormat: 'Image', Archived: 'N' },
        { DisplayName: 'Old Radiology', EntryCode: 'RAD', ID: '20', DocumentFormat: 'Image', Archived: 'Y' },
        { DisplayName: 'Colonoscopy Report', EntryCode: 'COL', ID: '30', DocumentFormat: 'Image', Archived: 'N' },
      ],
    },
  ];
  const types = parseDocumentTypes(typeRows);
  assert.strictEqual(types.length, 5);
  assert.deepStrictEqual(mapKindToType('lab_result', types), { id: '12', name: 'Labs/Procedures', reason: 'keyword' });
  assert.deepStrictEqual(mapKindToType('consult', types), { id: '15', name: 'Consultant Letter', reason: 'keyword' });
  assert.deepStrictEqual(mapKindToType('imaging', types), { id: '1', name: '(ready for indexing)', reason: 'fallback' }, 'archived type skipped');
  // Subtypes pick a finer category; the clinic's INTAKE_CATEGORY_MAP wins over both
  const moreTypes = parseDocumentTypes([{ getdocumenttypeinfo: [
    ...typeRows[0].getdocumenttypeinfo,
    { DisplayName: 'CT Scan', EntryCode: '6', ID: '6', DocumentFormat: '', Archived: 'N' },
    { DisplayName: 'Radiology Report', EntryCode: '40', ID: '40', DocumentFormat: '', Archived: 'N' },
    { DisplayName: 'Pathology Report', EntryCode: '41', ID: '41', DocumentFormat: '', Archived: 'N' },
    { DisplayName: 'Hospital Discharge Summary', EntryCode: '42', ID: '42', DocumentFormat: '', Archived: 'N' },
    { DisplayName: 'Lab Results', EntryCode: '16', ID: '16', DocumentFormat: '', Archived: 'N' },
  ] }]);
  assert.strictEqual(mapKindToType('imaging', moreTypes, 'ct', {})!.name, 'CT Scan');
  assert.strictEqual(mapKindToType('imaging', moreTypes, 'ultrasound', {})!.name, 'Radiology Report');
  assert.strictEqual(mapKindToType('lab_result', moreTypes, 'pathology', {})!.name, 'Pathology Report');
  assert.strictEqual(mapKindToType('other', moreTypes, 'discharge_summary', {})!.name, 'Hospital Discharge Summary');
  assert.strictEqual(mapKindToType('other', moreTypes, undefined, {})!.reason, 'fallback', 'plain "other" still goes to indexing');
  const clinicMap = { lab_result: 'Lab Results', 'imaging.ultrasound': 'CT Scan', pathology: 'No Such Type' };
  assert.deepStrictEqual(mapKindToType('lab_result', moreTypes, undefined, clinicMap), { id: '16', name: 'Lab Results', reason: 'configured' });
  assert.strictEqual(mapKindToType('imaging', moreTypes, 'ultrasound', clinicMap)!.name, 'CT Scan', 'kind.subtype key');
  assert.strictEqual(mapKindToType('lab_result', moreTypes, 'pathology', clinicMap)!.name, 'Pathology Report', 'unknown configured name falls through');
  assert.deepStrictEqual(categoryOverrides('{"Lab_Result":" Lab Results "}'), { lab_result: 'Lab Results' });
  assert.deepStrictEqual(categoryOverrides('not json'), {});
  const sub = (t: string, k: any) => classifySubtype(t, k)?.value;
  assert.strictEqual(sub('RADIOLOGY REPORT\nEXAM: CT ABDOMEN AND PELVIS WITHOUT CONTRAST', 'imaging'), 'ct');
  assert.strictEqual(sub('RENAL ULTRASOUND\nFINDINGS: right kidney 10.2 cm', 'imaging'), 'ultrasound');
  assert.strictEqual(sub('CHEST X-RAY 2 VIEWS\nIMPRESSION: no acute process', 'imaging'), 'chest_xray');
  assert.strictEqual(sub('SURGICAL PATHOLOGY REPORT\nKidney biopsy, left', 'lab_result'), 'pathology');
  assert.strictEqual(sub('HOSPITAL DISCHARGE SUMMARY\nAdmit date 10/01/2026', 'other'), 'discharge_summary');
  assert.strictEqual(sub('BASIC METABOLIC PANEL\nCreatinine 2.4 H', 'lab_result'), undefined, 'plain labs have no subtype');
  assert.strictEqual(sub('CT ABDOMEN', 'lab_result'), undefined, 'subtype must fit the kind');
  assert.deepStrictEqual(mapKindToType('other', types)?.reason, 'fallback');
  assert.strictEqual(mapKindToType('lab_result', []), null);
  let t = 0;
  const unityCalls: any[] = [];
  const fakeUnity: any = {
    executeAction: async (action: string, params: any, pid: string, target: string) => {
      unityCalls.push([action, target]);
      return { success: true, data: typeRows };
    },
  };
  const cache = new DocTypeCache(fakeUnity, () => t);
  await cache.suggest('lab_result');
  await cache.suggest('consult');
  assert.strictEqual(unityCalls.length, 1, 'cached');
  t += 61 * 60_000;
  await cache.suggest('consult');
  assert.strictEqual(unityCalls.length, 2, 'reloaded after an hour');
  assert.deepStrictEqual(unityCalls[0], [UnityActions.Document.GET_DOCUMENT_TYPES, 'EHR']);
  assert.strictEqual(UnityActions.Document.GET_DOCUMENT_TYPES, 'GetDocumentType');
  await assert.rejects(new DocTypeCache({ executeAction: async () => ({ success: false, error: 'x' }) } as any).list(), (e: any) => typeof e.code === 'string');
  await assert.rejects(new DocTypeCache({ executeAction: async () => ({ success: true, data: [] }) } as any).list(), (e: any) => typeof e.code === 'string', 'empty list is an error');
  await assert.rejects(new DocTypeCache({ executeAction: async () => { throw new Error('down'); } } as any).list(), (e: any) => typeof e.code === 'string');
  ok('document types: kind and subtype → category (CT Scan, Pathology Report, Hospital Discharge Summary...), clinic map, fallback "(ready for indexing)", 1 h cache, failures throw');

  // 8. Pipeline: upload with text, fax with fake MOATiT Fax, OCR wait, unconfigured API
  const pStore = new IntakeStore(path.join(TMP, 'pipeline'), () => NOW);
  const fakeFetch = async (u: string, init: any) => {
    assert.strictEqual(init.headers.Authorization, 'Bearer smoke-fax-key');
    if (u.endsWith('/api/v1/enterprise/fax/job_pending')) return new Response(JSON.stringify({ status: 'received', ocr_status: 'processing' }), { status: 200 });
    if (u.endsWith('/api/v1/enterprise/fax/job_lab')) return new Response(JSON.stringify({ data: { status: 'received', ocr: { status: 'completed', text: LAB }, from_number: '+1 (208) 555-0190' } }), { status: 200 });
    if (u.endsWith('/api/v1/enterprise/fax/job_lab/download')) return new Response(pdf.toString('latin1') + 'lab', { status: 200, headers: { 'content-type': 'application/pdf' } });
    if (u.endsWith('/fax/job_gone')) return new Response('{}', { status: 404 });
    return new Response('', { status: 500 });
  };
  const client = new fax.MoatitFaxClient({ baseUrl: 'https://fax.example.test/', apiKey: 'smoke-fax-key', fetchImpl: fakeFetch as any, sleep: async () => undefined });
  const delayed: (() => void)[] = [];
  const pipe = new IntakePipeline({ store: () => pStore, fax: () => client, now: () => NOW, later: (fn) => delayed.push(fn) });
  pipe.setDeps({ runTool: fakeRun }, new DocTypeCache(fakeUnity));

  const up = pStore.addDocument({ source: 'upload', source_ref: '', name: 'consult.pdf', mime: 'application/pdf', data: Buffer.concat([pdf, Buffer.from('c')]), text: CONSULT, by: 'smoke' });
  const fx = pStore.recordFax('fax:job_lab:fax.received', 'job_lab').item;
  const pend = pStore.recordFax('fax:job_pending:fax.received', 'job_pending').item;
  const gone = pStore.recordFax('fax:job_gone:fax.received', 'job_gone').item;
  const noText = pStore.addDocument({ source: 'folder', source_ref: '', name: 'scan.pdf', mime: 'application/pdf', data: Buffer.concat([pdf, Buffer.from('n')]) }).item;
  quiet(() => {
    for (const id of [up.item.id, fx.id, pend.id, gone.id, noText.id]) pipe.enqueue(id);
  });
  await pipe.idle();

  const upDone = pStore.get(up.item.id)!;
  assert.strictEqual(upDone.status, 'needs_review', 'consult: Lightfoot is not in the fake search results');
  assert.strictEqual(upDone.match?.decision, 'none');
  assert.strictEqual(upDone.document_type?.name, 'Consultant Letter');
  const fxDone = pStore.get(fx.id)!;
  assert.deepStrictEqual([fxDone.status, fxDone.match?.decision, fxDone.document_type?.name, fxDone.sender_fax], ['matched', 'auto', 'Labs/Procedures', '+12085550190']);
  assert.ok(fxDone.file && fxDone.has_text && pStore.readText(fx.id).includes('Creatinine'));
  assert.deepStrictEqual(fxDone.history.map((x) => x.action).slice(0, 2), ['fax received', 'file downloaded']);
  assert.deepStrictEqual([pStore.get(pend.id)!.status, pStore.get(pend.id)!.ocr_waits, delayed.length], ['received', 1, 1], 'waits for OCR');
  for (let i = 0; i < OCR_MAX_WAITS; i++) {
    quiet(() => delayed.shift()?.());
    await pipe.idle();
  }
  assert.strictEqual(pStore.get(pend.id)!.status, 'failed', 'after the OCR waits it downloads; the fake download fails (500) → failed, not lost');
  assert.strictEqual(pStore.get(pend.id)!.error_code, 'FAX_API_HTTP_500');
  assert.deepStrictEqual([pStore.get(gone.id)!.status, pStore.get(gone.id)!.error_code], ['failed', 'FAX_API_HTTP_404']);
  assert.strictEqual(pStore.get(noText.id)!.status, 'needs_review');
  const unconfigured = new IntakePipeline({ store: () => pStore, fax: () => null });
  const lone = pStore.recordFax('fax:job_x:fax.received', 'job_x').item;
  await unconfigured.process(lone.id);
  assert.strictEqual(pStore.get(lone.id)!.error_code, 'FAX_API_NOT_CONFIGURED');
  const searchDown = new IntakePipeline({ store: () => pStore, deps: { runTool: async () => ({ success: false, error_code: 'AUTH_ERROR', retryable: false, tool: 'x', message: '' }) } });
  const up2 = pStore.addDocument({ source: 'upload', source_ref: '', name: 'lab.pdf', mime: 'application/pdf', data: Buffer.concat([pdf, Buffer.from('2')]), text: LAB }).item;
  await searchDown.process(up2.id);
  assert.deepStrictEqual([pStore.get(up2.id)!.status, pStore.get(up2.id)!.error_code], ['failed', 'AUTH_ERROR']);
  ok('pipeline: fax fetch + read + match + type; OCR wait; fetch failures and search failures end in "failed" with a code');

  // 8b. Local OCR: client against a fake OCR server on 127.0.0.1, then the pipeline with it
  const ocrMod = await import('../platform/modules/intake/ocr');
  assert.strictEqual(ocrMod.ocrBaseUrl(), null, 'INTAKE_OCR_URL=off');
  delete process.env.INTAKE_OCR_URL;
  assert.strictEqual(ocrMod.ocrBaseUrl(), 'http://ocr:8090', 'default: the ocr service on the drawbridge network');
  process.env.INTAKE_OCR_URL = 'off';
  assert.strictEqual(ocrMod.ocrMinConfidence(), 60);
  assert.strictEqual(ocrMod.ocrReviewReason({ mean_confidence: 59.9, used_text_layer: false }) !== null, true);
  assert.strictEqual(ocrMod.ocrReviewReason({ mean_confidence: 88, used_text_layer: false }), null);
  assert.strictEqual(ocrMod.ocrReviewReason({ mean_confidence: 0, used_text_layer: true }), null, 'text layer is exact');
  assert.throws(() => ocrMod.parseOcrResult({ pages: 1 }), (e: any) => e.code === 'OCR_BAD_RESPONSE');

  const ocrHits: string[] = [];
  const ocrApp = express();
  ocrApp.post('/ocr', express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('latin1') : '';
    const mark = (body.match(/OCRCASE:(\w+)/) || [])[1] || '';
    ocrHits.push(mark);
    if (mark === 'lab') return res.json({ text: LAB, pages: 1, mean_confidence: 88.5, used_text_layer: false });
    if (mark === 'low') return res.json({ text: LAB, pages: 1, mean_confidence: 41.0, used_text_layer: false });
    if (mark === 'empty') return res.json({ text: '  \n', pages: 1, mean_confidence: 0, used_text_layer: false });
    if (mark === 'boom') return res.status(500).json({ error: 'OCR_FAILED' });
    if (mark === 'bad') return res.type('text/plain').send('not json');
    if (mark === 'unsupported') return res.status(400).json({ error: 'UNSUPPORTED_TYPE' });
    if (mark === 'slow') return void setTimeout(() => res.json({ text: LAB, pages: 1, mean_confidence: 90, used_text_layer: false }), 400);
    return res.status(404).end();
  });
  const ocrSrv = ocrApp.listen(0, '127.0.0.1');
  await new Promise((r) => ocrSrv.once('listening', r));
  const ocrUrl = `http://127.0.0.1:${(ocrSrv.address() as AddressInfo).port}`;
  try {
    const client = new ocrMod.OcrClient({ baseUrl: ocrUrl, sleep: async () => undefined });
    const r = await client.read(Buffer.from('%PDF-1.4 OCRCASE:lab'));
    assert.deepStrictEqual([r.pages, r.mean_confidence, r.used_text_layer, r.text.includes('Creatinine')], [1, 88.5, false, true]);
    await assert.rejects(client.read(Buffer.from('OCRCASE:boom')), (e: any) => e.code === 'OCR_HTTP_500' && e.retryable === true);
    assert.strictEqual(ocrHits.filter((x) => x === 'boom').length, 2, '5xx retried once');
    await assert.rejects(client.read(Buffer.from('OCRCASE:unsupported')), (e: any) => e.code === 'OCR_UNSUPPORTED_TYPE' && !e.retryable);
    await assert.rejects(client.read(Buffer.from('OCRCASE:bad')), (e: any) => e.code === 'OCR_BAD_RESPONSE');
    await assert.rejects(
      new ocrMod.OcrClient({ baseUrl: ocrUrl, timeoutMs: 50, attempts: 1 }).read(Buffer.from('OCRCASE:slow')),
      (e: any) => e.code === 'OCR_TIMEOUT'
    );
    const closed = express().listen(0, '127.0.0.1');
    await new Promise((r) => closed.once('listening', r));
    const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise((r) => closed.close(r));
    await assert.rejects(new ocrMod.OcrClient({ baseUrl: deadUrl, sleep: async () => undefined }).read(Buffer.from('x')), (e: any) => e.code === 'OCR_UNAVAILABLE');

    const oStore = new IntakeStore(path.join(TMP, 'ocr'), () => NOW);
    const oPipe = new IntakePipeline({ store: () => oStore, now: () => NOW, ocr: () => client, deps: { runTool: fakeRun } });
    const addScan = (mark: string) =>
      oStore.addDocument({ source: 'folder', source_ref: '', name: `scan-${mark}.tif`, mime: 'image/tiff', data: Buffer.from(`II*\u0000 OCRCASE:${mark}`) }).item.id;
    const ids = Object.fromEntries(['lab', 'low', 'empty', 'boom', 'unsupported'].map((m) => [m, addScan(m)]));
    quiet(() => Object.values(ids).forEach((id) => oPipe.enqueue(id)));
    await oPipe.idle();
    const got = (m: string) => oStore.get(ids[m])!;
    assert.deepStrictEqual([got('lab').status, got('lab').match?.decision, got('lab').ocr?.mean_confidence], ['matched', 'auto', 88.5]);
    assert.ok(oStore.readText(ids.lab).includes('Creatinine') && got('lab').history.some((x) => x.action === 'OCR read 1 page(s), confidence 89'));
    assert.deepStrictEqual([got('low').status, got('low').match?.decision], ['needs_review', 'auto'], 'low OCR confidence: matched candidate shown, never auto');
    assert.ok(/low confidence/.test(got('low').note || ''));
    assert.deepStrictEqual([got('empty').status, got('empty').note?.startsWith('OCR found no readable text')], ['needs_review', true]);
    assert.deepStrictEqual([got('boom').status, got('boom').error_code], ['failed', 'OCR_HTTP_500'], 'OCR down: failed with a code, staff can retry');
    assert.deepStrictEqual([got('unsupported').status, got('unsupported').error_code], ['failed', 'OCR_UNSUPPORTED_TYPE']);
    const withText = oStore.addDocument({ source: 'upload', source_ref: '', name: 'typed.pdf', mime: 'application/pdf', data: Buffer.from('%PDF typed OCRCASE:lab2'), text: LAB }).item.id;
    const before = ocrHits.length;
    await oPipe.process(withText);
    assert.strictEqual(ocrHits.length, before, 'documents that come with text are not sent to OCR');
    const offPipe = new IntakePipeline({ store: () => oStore, now: () => NOW, ocr: () => null, deps: { runTool: fakeRun } });
    const offId = addScan('off');
    await offPipe.process(offId);
    assert.deepStrictEqual([oStore.get(offId)!.status, ocrHits.includes('off')], ['needs_review', false], 'OCR off: review by hand, nothing sent');
  } finally {
    ocrSrv.close();
  }
  ok('local OCR: client codes (500 retried, 4xx, bad JSON, timeout, unreachable), pipeline reads, gates low confidence, fails loudly, skips documents with text');

  // 9. Drop folder
  const inbox = process.env.INTAKE_DROP_DIR!;
  fs.mkdirSync(inbox, { recursive: true });
  const old = (NOW.getTime() - 60_000) / 1000;
  const put = (name: string, data: Buffer, mtime = old) => {
    fs.writeFileSync(path.join(inbox, name), data);
    fs.utimesSync(path.join(inbox, name), mtime, mtime);
  };
  const fStore = new IntakeStore(path.join(TMP, 'folder'), () => NOW);
  put('Testpatient Marigold labs.PDF', Buffer.concat([pdf, Buffer.from('f1')]));
  put('fresh.tif', Buffer.from('II*\u0000fresh'), NOW.getTime() / 1000 - 2);
  put('notes.txt', Buffer.from('hello'));
  put('.hidden.pdf', pdf);
  const s1 = scanDropFolder(fStore, inbox, NOW.getTime());
  assert.deepStrictEqual([s1.added.length, s1.duplicates, s1.skipped], [1, 0, 1]);
  assert.ok(!fs.existsSync(path.join(inbox, 'Testpatient Marigold labs.PDF')), 'moved out of the inbox');
  assert.ok(fs.existsSync(path.join(inbox, 'fresh.tif')) && fs.existsSync(path.join(inbox, 'notes.txt')), 'too-new and other types stay');
  assert.strictEqual(fStore.get(s1.added[0])!.file!.mime, 'application/pdf');
  put('copy.pdf', Buffer.concat([pdf, Buffer.from('f1')]));
  const s2 = scanDropFolder(fStore, inbox, NOW.getTime());
  assert.deepStrictEqual([s2.added.length, s2.duplicates], [0, 1]);
  assert.strictEqual(scanDropFolder(fStore, path.join(TMP, 'missing'), NOW.getTime()).added.length, 0, 'missing folder is fine');
  ok('drop folder: picks up PDF/TIFF/PNG/JPEG older than 10 s, moves them in, dedupes by hash');

  // 10. Filing (SaveScanDocument + review task) against a fake Veradigm® EHR
  const ready = { ...fxDone };
  const fcalls: { action: string; params: any; pid: string }[] = [];
  let unityMode: 'ok' | 'reject' | 'timeout' | 'task_reject' = 'ok';
  const fileUnity = {
    async executeAction(action: string, params: any, pid: string) {
      fcalls.push({ action, params, pid });
      if (unityMode === 'timeout' && action === 'SaveScanDocument') throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
      if (unityMode === 'reject' && action === 'SaveScanDocument') return { success: false, error: 'SaveScanDocument: Doctype is not recognized' };
      if (action === 'SaveTask') {
        return unityMode === 'task_reject' ? { success: false, error: 'Target User Not found' } : { success: true, data: [{ savetaskinfo: [{ TaskId: '7001', status: '0' }] }] };
      }
      const chunked = /<chunkupload>/.test(params.Parameter4 || '');
      const done = !chunked || /<bDoneUpload>true</.test(params.Parameter4);
      return { success: true, data: [{ savescandocumentinfo: [done ? { documentID: String(9000 + fcalls.length) } : { documentVar: 'guid-1' }] }] };
    },
  } as any;
  const deps = { unity: fileUnity, store: () => pStore, now: () => NOW };
  await assert.rejects(filing.fileToChart(ready, 't', deps), (e: any) => e.error_code === 'FILING_DISABLED' && e.retryable === false);
  await assert.rejects(filing.sendToIndexing(ready, 't', deps), (e: any) => e.error_code === 'FILING_DISABLED');
  process.env.INTAKE_FILING = 'review';
  await assert.rejects(filing.fileToChart(ready, 't', deps), (e: any) => e.error_code === 'FILING_DISABLED', 'format not confirmed');
  process.env.INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED = 'yes';
  await assert.rejects(filing.fileToChart(ready, 't', deps), (e: any) => e.error_code === 'FILING_DISABLED', 'only the literal "true" confirms');
  process.env.INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED = 'true';
  await assert.rejects(filing.fileToChart(ready, 't', null), (e: any) => e.error_code === 'FILING_DISABLED', 'no deps = not configured');
  const reviewItem = pStore.update(ready.id, { match: { ...ready.match!, decision: 'review' } });
  await assert.rejects(filing.fileToChart(reviewItem, 't', deps), (e: any) => e.error_code === 'NOT_READY', 'review match needs staff');
  pStore.update(ready.id, { match: ready.match });
  assert.strictEqual(fcalls.length, 0, 'no Veradigm call while refused');

  // Veradigm refuses: not filed, marker cleared, a retry is allowed
  unityMode = 'reject';
  await assert.rejects(filing.fileToChart(ready, 't', deps), (e: any) => e.error_code === 'FILING_REJECTED');
  assert.ok(!pStore.get(ready.id)!.filing && pStore.get(ready.id)!.status === 'matched');
  // No answer: uncertain, and no automatic second attempt
  unityMode = 'timeout';
  await assert.rejects(filing.fileToChart(ready, 't', deps), (e: any) => e.error_code === 'FILING_UNCERTAIN');
  const n = fcalls.length;
  unityMode = 'ok';
  await assert.rejects(filing.fileToChart(ready, 't', deps), (e: any) => e.error_code === 'FILING_UNCERTAIN', 'uncertain blocks a retry');
  assert.strictEqual(fcalls.length, n, 'no call after an uncertain attempt');
  pStore.update(ready.id, { filing: undefined, error_code: undefined }, 'staff checked the chart', 't');

  // Success: one SaveScanDocument (Submitted by default) + a review task when INTAKE_REVIEW_USER is set
  process.env.INTAKE_REVIEW_USER = 'REVIEWER.TEST';
  fcalls.length = 0;
  const r1 = await filing.fileToChart(ready, 'staff1', deps);
  assert.deepStrictEqual(fcalls.map((c) => c.action), ['SaveScanDocument', 'SaveTask']);
  const sc = fcalls[0];
  assert.strictEqual(sc.pid, ready.match!.patient!.chartPatientId);
  assert.strictEqual(sc.params.Parameter1, 'Labs/Procedures');
  assert.ok(/^drawbridge-[\w-]+\.pdf$/.test(sc.params.Parameter2), 'file name without slashes or spaces');
  assert.ok(/<docstatus>2<\/docstatus>/.test(sc.params.Parameter3) && /<indexsource>None</.test(sc.params.Parameter3));
  assert.ok(/<clinicaldate>\d{1,2}\/\d{1,2}\/\d{4}<\/clinicaldate>/.test(sc.params.Parameter3));
  assert.ok(!/<doctitle>[^<]*\//.test(sc.params.Parameter3), 'no slash in the title');
  const title = sc.params.Parameter3.match(/<doctitle>([^<]*)</)[1];
  assert.ok(title.length <= filing.TITLE_MAX && /^Outside lab [A-Z][a-z]{2} \d{1,2} \d{4}/.test(title), `short title with the date first: ${title}`);
  assert.strictEqual(Buffer.from(sc.params.Data, 'base64').length, ready.file!.size);
  assert.deepStrictEqual([fcalls[1].params.Parameter1, fcalls[1].params.Parameter2, fcalls[1].params.Parameter3], ['Review', 'REVIEWER.TEST', r1.document_id]);
  const filed = pStore.get(ready.id)!;
  assert.deepStrictEqual([filed.status, filed.filed?.document_id, filed.filed?.task_id, filed.filed?.by], ['filed', r1.document_id, '7001', 'staff1']);
  await assert.rejects(filing.fileToChart(filed, 't', deps), (e: any) => e.error_code === 'ALREADY_FILED');
  await assert.rejects(filing.sendToIndexing(filed, 't', deps), (e: any) => e.error_code === 'ALREADY_FILED');

  // Chunked upload (over 2 MB), approved status; a failed task keeps the filing
  const bigData = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(filing.CHUNK_LIMIT + 1500, 0x20)]);
  const big = pStore.addDocument({ source: 'upload', source_ref: '', name: 'big.pdf', mime: 'application/pdf', data: bigData, by: 't' }).item;
  pStore.update(big.id, { status: 'matched', match: ready.match, document_type: ready.document_type, extracted: ready.extracted });
  process.env.INTAKE_DOC_STATUS = 'approved';
  unityMode = 'task_reject';
  fcalls.length = 0;
  const r2 = await filing.fileToChart(pStore.get(big.id)!, 't', deps);
  const chunks = fcalls.filter((c) => c.action === 'SaveScanDocument');
  assert.strictEqual(chunks.length, 3, '2 MB + 1.5 KB = 3 chunks of 1 MB');
  assert.ok(/<offset>0<\/offset>.*<bDoneUpload>false<\/bDoneUpload><documentVar><\/documentVar>/.test(chunks[0].params.Parameter4));
  assert.ok(/<offset>1048576<\/offset>.*<documentVar>guid-1<\/documentVar>/.test(chunks[1].params.Parameter4));
  assert.ok(/<bDoneUpload>true<\/bDoneUpload>/.test(chunks[2].params.Parameter4));
  assert.strictEqual(chunks.reduce((a, c) => a + Buffer.from(c.params.Data, 'base64').length, 0), bigData.length);
  assert.ok(/<docstatus>4<\/docstatus>/.test(chunks[0].params.Parameter3));
  assert.strictEqual(r2.task_error, 'TASK_REJECTED');
  assert.strictEqual(pStore.get(big.id)!.status, 'filed', 'a failed task does not undo the filing');

  // Send to indexing: "(ready for indexing)", status Ready for Indexing, no task
  const idx = pStore.addDocument({ source: 'upload', source_ref: '', name: 'idx.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4\nidx'), by: 't' }).item;
  pStore.update(idx.id, { status: 'needs_review', match: { ...ready.match!, decision: 'review' } });
  unityMode = 'ok';
  fcalls.length = 0;
  await filing.sendToIndexing(pStore.get(idx.id)!, 't', deps);
  assert.deepStrictEqual(fcalls.map((c) => [c.action, c.params.Parameter1]), [['SaveScanDocument', '(ready for indexing)']]);
  assert.ok(/<docstatus>1<\/docstatus>/.test(fcalls[0].params.Parameter3));
  assert.strictEqual(pStore.get(idx.id)!.status, 'sent_to_indexing');

  // Auto-filing gate (pipeline step 5)
  const autoItem = { ...ready, status: 'matched' as const, filed: undefined, document_type: { id: '16', name: 'Lab Results', reason: 'keyword' as const } };
  assert.strictEqual(autoFileBlocker(autoItem), 'filing mode is not auto', 'review mode never auto-files');
  process.env.INTAKE_FILING = 'auto';
  assert.strictEqual(autoFileBlocker(autoItem), '');
  assert.strictEqual(autoFileBlocker({ ...autoItem, match: { ...autoItem.match!, decision: 'review' } }), 'not auto-matched');
  assert.strictEqual(autoFileBlocker({ ...autoItem, document_type: { id: '-1000999', name: '(ready for indexing)', reason: 'fallback' } }), 'no specific document type');
  process.env.INTAKE_NO_AUTO_SENDERS = 'express lab, Daily Batch';
  const sender = (v: string) => ({ ...autoItem, extracted: { ...autoItem.extracted!, sender: { value: v, confidence: 'medium' as const } } });
  assert.strictEqual(autoFileBlocker(sender('EXPRESS LAB INC')), 'sender is set to staff review');
  assert.strictEqual(autoFileBlocker(sender('Summit Reference Laboratory')), '');
  process.env.INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED = 'false';
  assert.strictEqual(autoFileBlocker(autoItem), 'filing disabled');
  delete process.env.INTAKE_NO_AUTO_SENDERS;

  process.env.INTAKE_FILING = 'everything';
  assert.strictEqual(filing.filingMode(), 'off', 'unknown mode = off');
  for (const k of ['INTAKE_FILING', 'INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED', 'INTAKE_REVIEW_USER', 'INTAKE_DOC_STATUS']) delete process.env[k];
  const fileSrc = ['file.js', 'file.ts'].map((f) => path.join(__dirname, '../platform/modules/intake', f)).find((f) => fs.existsSync(f))!;
  for (const f of fs.readdirSync(path.dirname(fileSrc)).filter((x) => /\.(js|ts)$/.test(x) && !x.endsWith('.d.ts') && !/^file\./.test(x))) {
    const src = fs.readFileSync(path.join(path.dirname(fileSrc), f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/SaveScanDocument|SAVE_SCAN_DOCUMENT|SAVE_DOCUMENT_IMAGE|SaveDocumentImage|SaveTask|SAVE_TASK/.test(src), `${f}: only file.ts writes to Veradigm`);
  }
  ok('filing: guards, SaveScanDocument (single and 3 chunks), review task, rejected/uncertain handling, no duplicate filing, send to indexing; only file.ts writes');

  // 10b. Batch faxes end to end: per-page OCR, split into one part per patient, each part matched
  //      and auto-filed on its own; the blind spot to review; re-processing makes no duplicates.
  const batchPages: Record<string, string[]> = {
    batch: [COVER, A(), A('  (CONTINUED)'), B, C],
    blind: [A(), RESULTS_ONLY],
    mismatch: [A(), B],
    pagesdown: [A(), B],
  };
  let pagesDown = true;
  const pageCalls: string[] = [];
  const bOcrApp = express();
  bOcrApp.post(['/ocr', '/pages'], express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
    const mark = (req.body.toString('latin1').match(/BATCHCASE:(\w+)/) || [])[1] || '';
    const texts = batchPages[mark];
    if (!texts) return res.status(404).end();
    if (req.path === '/ocr') {
      return res.json({ text: texts.join('\f\n'), pages: texts.length, mean_confidence: 86, used_text_layer: false, page_texts: texts, page_confidences: texts.map((_, i) => 80 + i) });
    }
    const select = String(req.query.select || '');
    pageCalls.push(`${mark}:${select}`);
    if (mark === 'pagesdown' && pagesDown) return res.status(500).json({ error: 'OCR_FAILED' });
    res.setHeader('X-Source-Pages', String(mark === 'mismatch' ? texts.length + 1 : texts.length));
    return res.type('application/pdf').send(Buffer.from(`%PDF-1.4\n% part of BATCHCASE:${mark} pages ${select}\n%%EOF\n`));
  });
  const bSrv = bOcrApp.listen(0, '127.0.0.1');
  await new Promise((r) => bSrv.once('listening', r));
  const bClient = new ocrMod.OcrClient({ baseUrl: `http://127.0.0.1:${(bSrv.address() as AddressInfo).port}`, sleep: async () => undefined });
  const PEOPLE: Record<string, any> = {
    testpatient: { patientId: '9001', chartPatientId: '7001', firstName: 'Marigold', lastName: 'Testpatient', dateOfBirth: '03/14/1961', mrn: '482913' },
    zephyr: { patientId: '9002', chartPatientId: '7002', firstName: 'Quillon', lastName: 'Zephyr', dateOfBirth: '07/02/1958', mrn: '771234' },
    lightfoot: { patientId: '9003', chartPatientId: '7003', firstName: 'Orrin', lastName: 'Lightfoot', dateOfBirth: '09/05/1949', mrn: '330017' },
  };
  const searched: string[] = [];
  const batchRun = async (_name: string, a: any) => {
    searched.push(String(a.lastName).toLowerCase());
    const p = PEOPLE[String(a.lastName).toLowerCase()];
    return { patients: p ? [p] : [], total: p ? 1 : 0 };
  };
  const bStore = new IntakeStore(path.join(TMP, 'batch'), () => NOW);
  const bCalls: { action: string; pid: string; data: string; type: string }[] = [];
  const bUnity = {
    async executeAction(action: string, params: any, pid: string) {
      if (action === 'GetDocumentType') return { success: true, data: typeRows };
      bCalls.push({ action, pid, data: Buffer.from(params.Data || '', 'base64').toString('latin1'), type: params.Parameter1 });
      return { success: true, data: [{ savescandocumentinfo: [{ documentID: String(5000 + bCalls.length) }] }] };
    },
  } as any;
  const bPipe = new IntakePipeline({ store: () => bStore, now: () => NOW, ocr: () => bClient });
  bPipe.setDeps({ runTool: batchRun }, new DocTypeCache(bUnity));
  filing.setFilingDeps({ unity: bUnity, store: () => bStore, now: () => NOW });
  Object.assign(process.env, { INTAKE_FILING: 'auto', INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED: 'true', INTAKE_BATCH_SENDERS: 'Sawtooth Rapid Lab' });
  const addBatch = (mark: string) =>
    bStore.addDocument({ source: 'folder', source_ref: '', name: `batch-${mark}.tif`, mime: 'image/tiff', data: Buffer.from(`II*\u0000 BATCHCASE:${mark}`) }).item.id;
  try {
    const parentId = addBatch('batch');
    quiet(() => bPipe.enqueue(parentId));
    await bPipe.idle();
    const parentItem = bStore.get(parentId)!;
    assert.deepStrictEqual([parentItem.status, parentItem.split?.pages, parentItem.split?.cover_pages], ['split', [[2, 3], [4], [5]], [1]], 'parent split by patient');
    assert.ok(!parentItem.match && !parentItem.filed, 'the parent itself is never matched or filed');
    assert.deepStrictEqual(pageCalls.splice(0), ['batch:2,3', 'batch:4', 'batch:5'], 'the OCR container cut one file per patient');
    const kids = parentItem.split!.children.map((id) => bStore.get(id)!);
    assert.deepStrictEqual(kids.map((k) => [k.parent_id, k.part?.index, k.part?.of, k.part?.pages]), [[parentId, 0, 3, [2, 3]], [parentId, 1, 3, [4]], [parentId, 2, 3, [5]]], 'parts link back to the parent');
    assert.deepStrictEqual(kids.map((k) => [k.status, k.match?.patient?.chartPatientId, k.document_type?.name]), [
      ['filed', '7001', 'Labs/Procedures'],
      ['filed', '7002', 'Labs/Procedures'],
      ['filed', '7003', 'Labs/Procedures'],
    ], 'each part matched (two identifiers), typed with suggest(kind, subtype) and auto-filed');
    assert.deepStrictEqual(kids.map((k) => k.ocr?.mean_confidence), [81.5, 83, 84], 'a part is gated on its own pages\' OCR confidence');
    assert.ok(!bStore.readText(kids[0].id).includes('ZEPHYR') && !bStore.readText(kids[1].id).includes('TESTPATIENT') && !bStore.readText(kids[0].id).includes('CONFIDENTIALITY'), 'a part holds only its own pages (no cover)');
    assert.deepStrictEqual(bCalls.map((c) => [c.action, c.pid, c.data.match(/pages ([\d,]+)/)?.[1]]), [
      ['SaveScanDocument', '7001', '2,3'],
      ['SaveScanDocument', '7002', '4'],
      ['SaveScanDocument', '7003', '5'],
    ], 'each chart gets only its patient\'s pages');
    assert.ok(/pages 2-3/.test(kids[0].file!.name) && kids[0].history[0].action.startsWith(`split from ${parentId}`));
    // Re-processing (a crash before the parent was marked split): the same parts, nothing new, nothing filed twice.
    bStore.update(parentId, { status: 'read' });
    quiet(() => bPipe.enqueue(parentId));
    await bPipe.idle();
    assert.deepStrictEqual([bStore.get(parentId)!.status, bStore.list().filter((i) => i.parent_id === parentId).length, bCalls.length, pageCalls.length], ['split', 3, 3, 0], 'idempotent: no duplicate parts, no second filing');
    assert.strictEqual(bStore.addDocument({ source: 'upload', source_ref: '', name: 'again.tif', mime: 'image/tiff', data: Buffer.from('II*\u0000 BATCHCASE:batch') }).duplicate, true, 'the same batch file again is a duplicate');
    await assert.rejects(filing.fileToChart(bStore.get(parentId)!, 'staff', { unity: bUnity, store: () => bStore, now: () => NOW }), (e: any) => e.error_code === 'NOT_READY', 'a split parent cannot be filed');

    // The blind spot: page 2 shows no identifier. Batch sender → the whole file goes to staff, nothing filed.
    const blindId = addBatch('blind');
    await bPipe.process(blindId);
    const blindItem = bStore.get(blindId)!;
    assert.deepStrictEqual([blindItem.status, blindItem.match?.decision, blindItem.pages_check?.ok, bCalls.length], ['needs_review', 'auto', false, 3], 'one-patient-looking batch with an unidentified page: review, candidate shown');
    assert.match(blindItem.note || '', /Page 2 has no readable patient identifier/);
    // The split endpoint fails: parent failed with the code, no parts; a retry splits it.
    const downId = addBatch('pagesdown');
    await quiet(() => bPipe.process(downId));
    assert.deepStrictEqual([bStore.get(downId)!.status, bStore.get(downId)!.error_code, bStore.list().filter((i) => i.parent_id === downId).length], ['failed', 'OCR_HTTP_500', 0]);
    pagesDown = false;
    bStore.update(downId, { status: 'received', error_code: undefined });
    quiet(() => bPipe.enqueue(downId));
    await bPipe.idle();
    assert.deepStrictEqual([bStore.get(downId)!.status, bStore.list().filter((i) => i.parent_id === downId).length], ['split', 2], 'retry after the OCR service is back');
    // The file has a different page count than the text: not split.
    const misId = addBatch('mismatch');
    await bPipe.process(misId);
    assert.deepStrictEqual([bStore.get(misId)!.status, bStore.list().filter((i) => i.parent_id === misId).length], ['needs_review', 0]);
    assert.match(bStore.get(misId)!.note || '', /file has 3 page\(s\) but its text has 2/);
    // OCR off: a multi-patient document that came with text is not split.
    const offPipe2 = new IntakePipeline({ store: () => bStore, now: () => NOW, ocr: () => null, deps: { runTool: batchRun } });
    const typed = bStore.addDocument({ source: 'upload', source_ref: '', name: 'typed.pdf', mime: 'application/pdf', data: Buffer.from('%PDF typed batch'), text: [A(), B].join('\f') }).item.id;
    await offPipe2.process(typed);
    assert.match(bStore.get(typed)!.note || '', /Splitting needs the OCR service/);

    // Auto-file gate: a batch sender's document without a passed page check, a duplicate file.
    const autoBase = { ...kids[1], status: 'matched' as const, filed: undefined };
    assert.strictEqual(autoFileBlocker({ ...autoBase, pages_check: undefined }), 'batch sender: every page must be checked first');
    assert.strictEqual(autoFileBlocker({ ...autoBase, filed: undefined }), '');
    assert.strictEqual(autoFileBlocker({ ...autoBase, duplicate_of: 'in_other000' }), 'same file as an earlier document');
    process.env.INTAKE_NO_AUTO_SENDERS = 'sawtooth';
    assert.strictEqual(autoFileBlocker(autoBase), 'sender is set to staff review', 'INTAKE_NO_AUTO_SENDERS still holds a sender back');
    delete process.env.INTAKE_NO_AUTO_SENDERS;

    // Screens: the parent lists its parts, a part links back.
    const fam = { children: kids.map((k) => bStore.get(k.id)!) };
    const ph = intake.itemPage(bStore.get(parentId)!, '', [], fam);
    assert.ok(ph.includes('Split by patient') && kids.every((k) => ph.includes(`/intake/item/${k.id}`)) && ph.includes('pages 2-3') && ph.includes('cover sheet (page 1)'));
    assert.ok(/<button[^>]*disabled[^>]*>File to chart</.test(ph), 'no filing button for a split parent');
    const ch = intake.itemPage(bStore.get(kids[1].id)!, '', [], { parent: bStore.get(parentId)! });
    assert.ok(ch.includes('Part 2 of 3') && ch.includes(`/intake/item/${parentId}`));
    const qh = intake.queuePage(bStore.list(), bStore.counts(), '');
    assert.ok(qh.includes('3 patients, one document each') && qh.includes('Part 1 of 3 (pages 2-3)') && qh.includes('Split by patient'));
    assert.ok(!/\b(mcp|fhir|unity)\b/i.test(ph + ch + qh));

    // Retention: the split original goes once every part is filed and old enough.
    const later = new IntakeStore(path.join(TMP, 'batch'), () => new Date(NOW.getTime() + 31 * 86_400_000));
    assert.ok(fs.existsSync(later.filePath(later.get(parentId)!)));
    later.pruneFiled(30);
    assert.ok(!later.filePath(later.get(parentId)!) && later.get(parentId)!.status === 'split', 'split original removed after its parts were filed; the item stays');
  } finally {
    bSrv.close();
    filing.setFilingDeps(null);
    for (const k of ['INTAKE_FILING', 'INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED', 'INTAKE_BATCH_SENDERS']) delete process.env[k];
  }
  ok('batch fax: per-page OCR, split into one part per patient (OCR container cuts the file), each part matched, typed and auto-filed to its own chart; blind spot to review; idempotent; split failures, page mismatch and OCR off leave nothing half-done; screens link parent and parts');

  // 11. Screens: wording, escaping, disabled buttons
  const evil = pStore.update(up.item.id, { note: '<script>alert(1)</script>' });
  const html = intake.queuePage(pStore.list(), pStore.counts(), '') + intake.itemPage(pStore.get(fx.id)!, 'FILING_NOT_IMPLEMENTED') + intake.itemPage(evil);
  const opts = [{ id: '16', name: 'Lab Results' }, { id: '6', name: '<CT Scan>' }];
  const notFiled = { ...pStore.get(fx.id)!, status: 'matched' as const, filed: undefined, document_type: { id: '16', name: 'Lab Results', reason: 'staff' as const } };
  const picker = intake.itemPage(notFiled, '', opts);
  assert.ok(/name="type_id"/.test(picker) && /<option value="16" selected>Lab Results<\/option>/.test(picker) && picker.includes('&lt;CT Scan&gt;'), 'category picker, escaped');
  assert.ok(/picked by staff/.test(picker));
  assert.ok(!/name="type_id"/.test(intake.itemPage({ ...notFiled, status: 'filed' }, '', opts)), 'no picker once filed');
  assert.ok(!/\b(mcp|fhir|unity)\b/i.test(html), 'screens (and the upload script) never say MCP/FHIR/Unity');
  assert.ok(html.includes('Veradigm® EHR'));
  assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;alert(1)'), 'escaped');
  assert.ok(/<button[^>]*disabled[^>]*>File to chart</.test(html) && /<button[^>]*disabled[^>]*>Send to indexing</.test(html), 'filing buttons disabled while off');
  assert.ok(html.includes('Filing to the Veradigm® EHR chart is turned off'));
  assert.ok(html.includes('Marigold J Testpatient') || html.includes('Marigold Testpatient'));
  ok('screens: no MCP/FHIR/Unity wording, escaped, filing buttons disabled with an explanation');

  // 11b. Staff routes over 127.0.0.1 (login is the platform's job; a stand-in user here)
  const staff = express();
  staff.use(express.json()); // the server-wide parser must not swallow the upload body
  staff.use('/app/intake', (req: any, _res, next) => {
    req.drawbridgeUser = 'smoke.staff';
    next();
  }, express.urlencoded({ extended: false }), intake.intakeModule.appRouter!({} as any));
  const srv = staff.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/app/intake`;
  try {
    const big = Buffer.concat([pdf, Buffer.alloc(300_000, 0x20)]); // > 100 KB default JSON limit
    const upRes = await fetch(`${base}/upload`, {
      method: 'POST',
      headers: { 'content-type': intake.UPLOAD_TYPE },
      body: JSON.stringify({ name: 'route.pdf', data_base64: big.toString('base64'), text: CONSULT }),
    });
    assert.strictEqual(upRes.status, 200);
    const { id } = (await upRes.json()) as any;
    assert.ok(/^in_/.test(id));
    const html = await fetch(`${base}/item/${id}`).then((r) => r.text());
    assert.ok(html.includes('route.pdf') && !/\b(mcp|fhir|unity)\b/i.test(html));
    const orig = await fetch(`${base}/item/${id}/original`);
    assert.deepStrictEqual([orig.status, orig.headers.get('content-type'), orig.headers.get('x-content-type-options')], [200, 'application/pdf', 'nosniff']);
    assert.strictEqual(Buffer.from(await orig.arrayBuffer()).length, big.length);
    const bad = await fetch(`${base}/upload`, { method: 'POST', headers: { 'content-type': intake.UPLOAD_TYPE }, body: JSON.stringify({ name: 'x.html', data_base64: Buffer.from('<html>').toString('base64') }) });
    assert.strictEqual(bad.status, 400, 'only PDF/TIFF/PNG/JPEG bytes');
    const filed = await fetch(`${base}/item/${id}/file-to-chart`, { method: 'POST', redirect: 'manual' });
    assert.ok(filed.status === 302 && /m=FILING_DISABLED/.test(filed.headers.get('location') || ''));
    await fetch(`${base}/item/${id}/reviewed`, { method: 'POST', redirect: 'manual' });
    const after = intakeStore().get(id)!;
    assert.strictEqual(after.reviewed_by, 'smoke.staff');
    assert.ok(after.history.some((x) => x.action === 'filing refused (FILING_DISABLED)' && x.by === 'smoke.staff'));
    assert.strictEqual((await fetch(`${base}/item/in_doesnotexist1`)).status, 404);
    assert.strictEqual((await fetch(`${base}/?status=needs_review`)).status, 200);
    await intake.intakePipeline.idle();
  } finally {
    srv.close();
  }
  ok('staff routes: upload (base64 JSON, past the 100 KB parser), item page, original file, filing refused + audited, mark reviewed');

  // 12. Module registration
  const { loadPlatformModules } = await import('../platform/modules');
  const { platformModules } = await import('../platform/registry');
  loadPlatformModules();
  const mod = platformModules().find((m) => m.name === 'intake');
  assert.deepStrictEqual(mod?.nav, { path: '/intake', label: 'Document intake', order: 35 });
  assert.ok(!mod?.getTools, 'no agent tools: the phone agent never files documents');
  ok('module registered: intake, /intake, order 35, no agent tools');

  // 13. Logs carry no document content, identifiers or secrets
  const all = logged.join('\n');
  for (const bad of ['Testpatient', 'Marigold', 'Zephyr', 'Lightfoot', '1961', '482913', '555-0142', '2085550142', 'Creatinine', SECRET, 'smoke-fax-key']) {
    assert.ok(!all.includes(bad), `log leaks "${bad}"`);
  }
  ok(`logs (${logged.length} lines) hold IDs and error codes only`);

  console.log = orig.log;
  console.log(`\n${passed} checks passed`);
}

main()
  .catch((e) => {
    console.error('FAIL', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
