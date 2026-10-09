/**
 * Offline checks for the document intake module (no network beyond 127.0.0.1, no credentials,
 * made-up patients only). Webhook HMAC (good / bad / missing), event allowlist, durable dedupe,
 * extraction on three synthetic documents, the match decision table, document-type mapping,
 * the pipeline with fake Veradigm and MOATiT Fax, the drop folder, the filing guard, screen
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
for (const k of ['MOATIT_FAX_WEBHOOK_SECRET', 'MOATIT_FAX_BASE_URL', 'MOATIT_FAX_API_KEY', 'INTAKE_FILING', 'INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED']) {
  delete process.env[k];
}

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
  const { extractFields, normalizeDate, parseName } = await import('../platform/modules/intake/extract');
  const { decideMatch, matchPatient } = await import('../platform/modules/intake/match');
  const { DocTypeCache, mapKindToType, parseDocumentTypes } = await import('../platform/modules/intake/doctypes');
  const filing = await import('../platform/modules/intake/file');
  const { scanDropFolder } = await import('../platform/modules/intake/folder');
  const { IntakePipeline, OCR_MAX_WAITS } = await import('../platform/modules/intake/pipeline');
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
  ok('extraction: name, DOB (several formats), MRN, phone, sender, collection date, kind, abnormal flags on 3 synthetic documents');

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
  ok('document types: kind → Labs/Procedures / Consultant Letter, fallback "(ready for indexing)", 1 h cache, failures throw');

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

  // 10. Filing guard (no Veradigm write on this branch)
  const ready = { ...fxDone };
  await assert.rejects(filing.fileToChart(ready), (e: any) => e.error_code === 'FILING_DISABLED' && e.retryable === false);
  await assert.rejects(filing.sendToIndexing(ready), (e: any) => e.error_code === 'FILING_DISABLED');
  process.env.INTAKE_FILING = 'review';
  await assert.rejects(filing.fileToChart(ready), (e: any) => e.error_code === 'FILING_DISABLED', 'format not confirmed');
  process.env.INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED = 'yes';
  await assert.rejects(filing.fileToChart(ready), (e: any) => e.error_code === 'FILING_DISABLED', 'only the literal "true" confirms');
  process.env.INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED = 'true';
  await assert.rejects(filing.fileToChart({ ...ready, match: { ...ready.match!, decision: 'review' } }), (e: any) => e.error_code === 'NOT_READY');
  await assert.rejects(filing.fileToChart({ ...ready, status: 'filed' }), (e: any) => e.error_code === 'ALREADY_FILED');
  await assert.rejects(filing.fileToChart(ready), (e: any) => e.error_code === 'FILING_NOT_IMPLEMENTED');
  process.env.INTAKE_FILING = 'everything';
  assert.strictEqual(filing.filingMode(), 'off', 'unknown mode = off');
  delete process.env.INTAKE_FILING;
  delete process.env.INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED;
  const fileSrc = ['file.js', 'file.ts'].map((f) => path.join(__dirname, '../platform/modules/intake', f)).find((f) => fs.existsSync(f))!;
  const code = fs.readFileSync(fileSrc, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/executeAction|SaveDocumentImage|SAVE_DOCUMENT_IMAGE|runTool/.test(code), 'file.ts makes no Veradigm call');
  for (const f of fs.readdirSync(path.dirname(fileSrc)).filter((x) => /\.(js|ts)$/.test(x) && !x.endsWith('.d.ts'))) {
    const src = fs.readFileSync(path.join(path.dirname(fileSrc), f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/SAVE_DOCUMENT_IMAGE|SaveDocumentImage|SaveTask|SAVE_TASK/.test(src), `${f} must not write to Veradigm`);
  }
  ok('filing guard: refuses while INTAKE_FILING is off or the save format is unconfirmed; no write call anywhere in the module');

  // 11. Screens: wording, escaping, disabled buttons
  const evil = pStore.update(up.item.id, { note: '<script>alert(1)</script>' });
  const html = intake.queuePage(pStore.list(), pStore.counts(), '') + intake.itemPage(pStore.get(fx.id)!, 'FILING_NOT_IMPLEMENTED') + intake.itemPage(evil);
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
