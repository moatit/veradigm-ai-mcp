/**
 * Offline checks for the intake clinic rules (notify.ts; Idaho Kidney Institute's setup answers, Oct 13
 * 2026). No network beyond 127.0.0.1, no credentials, made-up people only, a fake Veradigm®:
 *
 *   1. Documents that always go to a person (INTAKE_ALWAYS_PERSON): records requests, prior authorizations,
 *      refill requests, referrals are detected and held with a staff-readable reason, even with a perfect
 *      patient match; a lab result that mentions a referral or a refill in passing is not caught.
 *   2. Critical results: High priority task with "CRITICAL" first, phone call required on the item, never
 *      auto-filed without a recipient, back to staff when the task can't be created (INTAKE_CRITICAL_NOTIFY).
 *   3. Review task to the ordering provider (INTAKE_TASK_TARGET=ordering_provider): read from the document,
 *      matched to one Veradigm® EHR provider (GetProviders, read-only), INTAKE_REVIEW_USER otherwise.
 *   4. Same-day appointments (INTAKE_SAME_DAY_NO_NOTIFY): no task when the collection date is an appointment
 *      day (GetScheduleByPatientID, read-only); critical results always notify; a failed lookup notifies.
 *   5. The lab category for IKI is "Lab Results".
 *
 *   npm run smoke:intake   (runs this file too)
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-intake-rules-'));
process.env.CALL_RECORDS_DIR = TMP;
process.env.INTAKE_DROP_DIR = path.join(TMP, 'inbox');
process.env.INTAKE_OCR_URL = 'off';
for (const k of [
  'INTAKE_FILING', 'INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED', 'INTAKE_REVIEW_USER', 'INTAKE_DOC_STATUS', 'INTAKE_MODE', 'INTAKE_ROSTER_CSV',
  'INTAKE_ALWAYS_PERSON', 'INTAKE_TASK_TARGET', 'INTAKE_CRITICAL_NOTIFY', 'INTAKE_SAME_DAY_NO_NOTIFY', 'INTAKE_CATEGORY_MAP',
  'INTAKE_NO_AUTO_SENDERS', 'INTAKE_BATCH_SENDERS', 'INTAKE_MATCH_RULE',
]) {
  delete process.env[k];
}

import assert from 'assert';
import type { AddressInfo } from 'net';

const NOW = new Date('2026-10-09T15:00:00Z');

// ── Synthetic documents (made-up people, 555 numbers, fictional plans and pharmacies) ──
const PATIENT = `Patient Name: TESTPATIENT, MARIGOLD J        DOB: 03/14/1961
MRN: 00482913    Sex: F   Patient Phone: (208) 555-0142`;
const LAB_CRITICAL = `QUEST DIAGNOSTICS   Fax: (208) 555-0190
LABORATORY REPORT
${PATIENT}
Ordering Physician: Dr. Example
Date Collected: 10/08/2026 08:15   Reported: 10/08/2026 16:40

TEST                 RESULT   FLAG   REFERENCE RANGE   UNITS
Creatinine           2.4      H      0.6-1.1           mg/dL
Potassium            6.8      HH     3.5-5.1           mmol/L
Sodium               139             135-145           mmol/L
CRITICAL VALUE called to clinic RN at 16:35.
`;
const LAB_ROUTINE = `QUEST DIAGNOSTICS   Fax: (208) 555-0190
LABORATORY REPORT
${PATIENT}
Ordering Provider: Rowan Hale, MD (Idaho Kidney Institute)
Date Collected: 10/08/2026 08:15   Reported: 10/08/2026 16:40

TEST                 RESULT   FLAG   REFERENCE RANGE   UNITS
Creatinine           2.4      H      0.6-1.1           mg/dL
Sodium               139             135-145           mmol/L
Critical values are telephoned to the ordering client per laboratory policy.
`;
// A result that mentions a referral, a refill and a prior auth number in passing: still a lab result.
const LAB_MENTIONS = `${LAB_ROUTINE}Prior auth #: 4471902
Comment: patient referred by Dr. Example for CKD follow-up. Refill lisinopril per PCP.
Reason for referral on the requisition: CKD stage 3b.
`;
const PRIOR_AUTH = `SAGEBRUSH HEALTH PLAN - UTILIZATION MANAGEMENT
PRIOR AUTHORIZATION REQUEST
${PATIENT}
Member ID: ZZX900112233
Requested medication: patiromer 8.4 g packet    NDC: 00000-0000-00
Diagnosis: N18.4 (ICD-10)
Please complete the attached form and fax it back within 72 hours.
`;
const RECORDS = `SNAKE RIVER DISABILITY SERVICES
REQUEST FOR MEDICAL RECORDS
${PATIENT}
Please send copies of office notes and lab results for dates of service 01/01/2025 to present.
An authorization signed by the patient is enclosed (HIPAA).
`;
const REFILL = `SAWTOOTH VALLEY PHARMACY   Fax: (208) 555-0177
PRESCRIPTION REFILL REQUEST
${PATIENT}
Medication: lisinopril 10 mg tablet   Sig: 1 tablet daily   Qty: 90
Refills remaining: 0     Last filled: 09/10/2026
Please authorize a new prescription or call the pharmacy.
`;
const REFERRAL = `JUNIPER FLATS FAMILY CLINIC
REFERRAL FORM
${PATIENT}
Referred to: Idaho Kidney Institute, Nephrology
Reason for referral: CKD stage 4, rising creatinine.
`;
const COVER_TICKED = `FAX
To: Idaho Kidney Institute     From: Sagebrush Health Plan
[ ] Urgent   [X] Prior authorization   [ ] Records request
RE: TESTPATIENT, MARIGOLD J
\f${PATIENT}
Member ID: ZZX900112233    Requested service: CT abdomen (CPT 74176)
Status: approved through 12/31/2026.
`;
const COVER_UNTICKED = `FAX
To: Idaho Kidney Institute     From: Quest Diagnostics
[X] Lab results   [ ] Prior authorization   [ ] Refill request
RE: Requested records
\f${LAB_ROUTINE}`;

async function main(): Promise<void> {
  const { IntakeStore, intakeStore } = await import('../platform/modules/intake/store');
  const { extractFields, abnormalFlags, classifyKind, classifyRequest, parseProvider } = await import('../platform/modules/intake/extract');
  const notify = await import('../platform/modules/intake/notify');
  const { DocTypeCache, mapKindToType, parseDocumentTypes } = await import('../platform/modules/intake/doctypes');
  const filing = await import('../platform/modules/intake/file');
  const { IntakePipeline, autoFileBlocker, itemAutoFileBlocker } = await import('../platform/modules/intake/pipeline');
  const { blockerCode, shadowDecision } = await import('../platform/modules/intake/shadow');
  const intake = await import('../platform/modules/intake');
  const { UnityActions } = await import('../unity/config/unity-endpoints');
  const express = (await import('express')).default;

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };
  const logged: string[] = [];
  const orig = { log: console.log, error: console.error };
  console.error = (...a: any[]) => {
    logged.push(a.map(String).join(' '));
    orig.error(...a);
  };
  const quiet = async <T,>(f: () => Promise<T>): Promise<T> => {
    const l = console.log;
    console.log = (...a: any[]) => logged.push(a.map(String).join(' '));
    try {
      return await f();
    } finally {
      console.log = l;
    }
  };
  const x = (t: string) => extractFields(t, NOW);

  // ── 1. Documents that always go to a person ────────────────────────────────
  const req = (t: string) => x(t).request?.value;
  assert.strictEqual(req(PRIOR_AUTH), 'prior_auth');
  assert.strictEqual(req(RECORDS), 'records_request');
  assert.strictEqual(req(REFILL), 'refill_request');
  assert.strictEqual(req(COVER_TICKED), 'prior_auth', 'a ticked box on the cover sheet');
  assert.strictEqual(req('FAX\nRE: Medication refill request for your patient\n\fPatient: Marigold Testpatient  DOB: 03/14/1961'), 'refill_request', 'an RE: line');
  assert.strictEqual(x(REFERRAL).kind.value, 'referral');
  // Not requests
  assert.strictEqual(req(LAB_MENTIONS), undefined, 'a lab result mentioning a referral, a refill and a prior auth number');
  assert.strictEqual(x(LAB_MENTIONS).kind.value, 'lab_result');
  assert.strictEqual(req(COVER_UNTICKED), undefined, 'unticked boxes and "RE: Requested records" are not requests');
  assert.strictEqual(req(LAB_CRITICAL), undefined);
  const consult = 'Boise Valley Cardiology Associates\nConsultation Note\nPatient: Orrin B. Lightfoot    DOB: 9/5/49\nDear Dr. Example,\nThank you for referring Mr. Lightfoot. Assessment and Plan: refill his statin.';
  assert.deepStrictEqual([x(consult).kind.value, req(consult)], ['consult', undefined], '"Thank you for referring" is a consult letter');
  // A report needs two of the request's own words besides the title; a non-report with three may be named anywhere.
  assert.strictEqual(classifyKind(LAB_ROUTINE).confidence, 'high');
  assert.strictEqual(classifyRequest('PRIOR AUTHORIZATION #: 12345\n' + LAB_ROUTINE), undefined);
  assert.strictEqual(classifyRequest('PRIOR AUTHORIZATION\nMember ID: 1  NDC: 2\n' + LAB_ROUTINE)?.value, 'prior_auth');
  assert.deepStrictEqual(
    classifyRequest(`${Array.from({ length: 12 }, (_, i) => `Note line ${i + 1}.`).join('\n')}\nThis is a refill request. Pharmacy: Sawtooth. Sig: 1 daily. Qty: 30. Last filled 9/1.`),
    { value: 'refill_request', confidence: 'medium' }
  );
  // Referrals: titled, or a letter that refers the patient; "Reason for referral" on a result is not one.
  assert.strictEqual(req(REFERRAL), 'referral');
  assert.strictEqual(req('Sweetwater Community Health\n\nDear Dr. Hale,\nI am referring Ms. Testpatient for evaluation of rising creatinine. Reason for referral: CKD 4.\nPlease see her at your earliest opening.\nPatient: Marigold Testpatient  DOB: 03/14/1961'), 'referral', 'a referral letter without a title');
  assert.strictEqual(req('LABORATORY REPORT\nReferral #: 2210\n' + LAB_ROUTINE), undefined, '"Referral #" in a lab header');
  assert.strictEqual(req(consult.replace('Assessment and Plan', 'Reason for referral: hypertension. Assessment and Plan')), undefined, 'a consult letter quoting the reason for referral');
  assert.strictEqual(req('RADIOLOGY REPORT\nReferred by: Dr. Hale   Reason for referral: flank pain\nFINDINGS: normal kidneys.\nIMPRESSION: no hydronephrosis.\nTECHNIQUE: grayscale.'), undefined, 'an imaging report');

  // INTAKE_ALWAYS_PERSON
  assert.deepStrictEqual(notify.alwaysPersonTypes(undefined), ['records_request', 'prior_auth', 'refill_request', 'referral'], 'unset: all four');
  assert.strictEqual(notify.alwaysPersonReason({ ...x(LAB_ROUTINE), kind: { value: 'referral', confidence: 'medium' } }), '', 'the kind alone (passing mentions) is not a referral');
  assert.deepStrictEqual(notify.alwaysPersonTypes('none'), []);
  assert.deepStrictEqual(notify.alwaysPersonTypes('records_request,prior_auth,refill_request,referral'), notify.ALWAYS_PERSON_TYPES);
  assert.deepStrictEqual(notify.alwaysPersonTypes('Prior_Authorization, referral'), ['prior_auth', 'referral'], 'aliases, any case');
  assert.deepStrictEqual(notify.alwaysPersonTypes('prior_auth,priorauth'), notify.ALWAYS_PERSON_TYPES, 'a typo keeps all four (fail closed)');
  assert.strictEqual(notify.alwaysPersonReason(x(PRIOR_AUTH)), 'Prior authorization: always reviewed by staff');
  assert.strictEqual(notify.alwaysPersonReason(x(RECORDS)), 'Medical records request: always reviewed by staff');
  assert.strictEqual(notify.alwaysPersonReason(x(REFILL)), 'Medication refill request: always reviewed by staff');
  assert.strictEqual(notify.alwaysPersonReason(x(REFERRAL)), 'Referral: always reviewed by staff');
  assert.strictEqual(notify.alwaysPersonReason(x(LAB_MENTIONS)), '');
  process.env.INTAKE_ALWAYS_PERSON = 'prior_auth';
  assert.deepStrictEqual([notify.alwaysPersonReason(x(PRIOR_AUTH)), notify.alwaysPersonReason(x(REFERRAL))], ['Prior authorization: always reviewed by staff', ''], 'only the listed types');
  delete process.env.INTAKE_ALWAYS_PERSON;
  assert.strictEqual(blockerCode('Prior authorization: always reviewed by staff'), 'always_person', 'shadow report reason');

  // Pipeline: a perfect patient match (name, DOB, MRN, phone) still goes to staff, with the reason.
  const typeRows = [{ getdocumenttypeinfo: [
    { DisplayName: '(ready for indexing)', EntryCode: '-1000999', ID: '1', Archived: 'N' },
    { DisplayName: 'Labs/Procedures', EntryCode: 'LAB', ID: '12', Archived: 'N' },
    { DisplayName: 'Lab Results', EntryCode: '16', ID: '16', Archived: 'N' },
    { DisplayName: 'Referral Letter', EntryCode: '33', ID: '33', Archived: 'N' },
    { DisplayName: 'Consultant Letter', EntryCode: 'CONS', ID: '15', Archived: 'N' },
  ] }];
  const docTypes = new DocTypeCache({ executeAction: async () => ({ success: true, data: typeRows }) } as any);
  const marigold = { patientId: '9001', chartPatientId: '7001', firstName: 'Marigold', lastName: 'Testpatient', dateOfBirth: '3/14/1961', mrn: '482913', phone: { home: '(208) 555-0142' } };
  const search = async (name: string) => (name === 'unity_search_patients' ? { patients: [marigold], total: 1 } : { success: false, error_code: 'UNKNOWN_TOOL', retryable: false });
  const store = new IntakeStore(path.join(TMP, 'rules'), () => NOW);
  const pipe = new IntakePipeline({ store: () => store, now: () => NOW, ocr: () => null, deps: { runTool: search } });
  pipe.setDeps({ runTool: search }, docTypes);
  let n = 0;
  const add = (text: string, name = 'doc.pdf') => store.addDocument({ source: 'upload', source_ref: '', name, mime: 'application/pdf', data: Buffer.from(`%PDF-1.4\n${n++}\n${name}`), text, by: 'smoke' }).item;

  // Every Veradigm® call is recorded; only these actions exist in the fake (anything else throws).
  const calls: { action: string; params: any; pid: string; target: string }[] = [];
  const fake = {
    task: 'ok' as 'ok' | 'reject' | 'timeout' | 'noid',
    providers: 'ok' as 'ok' | 'fail' | 'empty',
    schedule: 'ok' as 'ok' | 'fail' | 'throw',
    appointments: [] as Record<string, string>[],
  };
  const providerRows = [{ getprovidersinfo: [
    { ProviderID: '101', FirstName: 'Ellis', LastName: 'Example', UserName: 'EXAMPLE.E' },
    { ProviderID: '102', FirstName: 'Rowan', LastName: 'Hale', UserName: 'HALE.R' },
    { ProviderID: '103', FirstName: 'Juniper', LastName: 'Hale', UserName: 'HALE.J' },
    { ProviderID: '104', FirstName: 'Imani', LastName: 'Castell', UserName: 'CASTELL.I' },
    { ProviderID: '105', FirstName: 'Noel', LastName: 'Nouser' },
    { ProviderID: '106', FirstName: 'Old', LastName: 'Gone', UserName: 'GONE.O', Inactive: 'Y' },
    // Veradigm® EHR's own row shape (sandbox GetProviders, Oct 13, 2026): EntryCode, ProviderInactive, UserInactive.
    { EntryCode: '107', FirstName: 'Past', LastName: ' Retired', UserName: 'RETIRED.P', ProviderInactive: 'Y', UserInactive: '', referral: 'N' },
    { EntryCode: '108', FirstName: 'Locked', LastName: 'Out', UserName: 'OUT.L', ProviderInactive: 'N', UserInactive: 'Y', referral: 'N' },
    { EntryCode: '109', FirstName: 'Sable', LastName: ' Ingram', Middle: '', UserName: 'INGRAM.S', ProviderInactive: 'N', UserInactive: '', referral: 'Y' },
  ] }];
  const unity: any = {
    async executeAction(action: string, params: any, pid: string, target: string) {
      calls.push({ action, params, pid, target });
      if (action === 'SaveScanDocument') return { success: true, data: [{ savescandocumentinfo: [{ documentID: String(5000 + calls.length) }] }] };
      if (action === 'SaveTask') {
        if (fake.task === 'timeout') throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        if (fake.task === 'reject') return { success: false, error: 'Target User Not found' };
        return { success: true, data: [{ savetaskinfo: [fake.task === 'noid' ? { status: '0' } : { TaskId: String(8000 + calls.length) }] }] };
      }
      if (action === 'GetProviders') {
        if (fake.providers === 'fail') return { success: false, error: 'not licensed' };
        return { success: true, data: fake.providers === 'empty' ? [] : providerRows };
      }
      if (action === 'GetScheduleByPatientID') {
        if (fake.schedule === 'throw') throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
        if (fake.schedule === 'fail') return { success: false, error: 'error' };
        return { success: true, data: [{ getschedulebypatientidinfo: fake.appointments }] };
      }
      throw new Error(`unexpected Veradigm action ${action}`);
    },
  };
  const actions = () => calls.map((c) => c.action);
  const deps = () => ({ unity, store: () => store, now: () => NOW, providers: new notify.ProviderDirectory(unity) });
  process.env.INTAKE_FILING = 'auto';
  process.env.INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED = 'true';
  process.env.INTAKE_REVIEW_USER = 'REVIEW.POOL';
  filing.setFilingDeps({ unity, store: () => store, now: () => NOW });

  const held: Record<string, string> = {};
  for (const [label, text] of [['prior_auth', PRIOR_AUTH], ['records', RECORDS], ['refill', REFILL], ['referral', REFERRAL], ['cover', COVER_TICKED]] as const) {
    const it = add(text, `${label}.pdf`);
    await quiet(() => pipe.process(it.id));
    const done = store.get(it.id)!;
    assert.strictEqual(done.match?.decision, 'auto', `${label}: the patient match itself is perfect`);
    assert.strictEqual(done.status, 'needs_review', `${label}: never auto-filed`);
    assert.ok(/: always reviewed by staff\./.test(done.note || ''), `${label}: reason shown (${done.note})`);
    assert.ok(itemAutoFileBlocker(done).endsWith('always reviewed by staff'));
    assert.strictEqual(shadowDecision(done, itemAutoFileBlocker(done), NOW).code, 'always_person', `${label}: shadow mode says why`);
    held[label] = done.note!;
  }
  assert.ok(held.prior_auth.startsWith('Prior authorization: always reviewed by staff.'));
  assert.ok(held.referral.startsWith('Referral: always reviewed by staff.'));
  assert.ok(!actions().includes('SaveScanDocument'), 'nothing filed');
  const page = intake.itemPage(store.list().find((i) => i.file?.name === 'prior_auth.pdf')!);
  assert.ok(page.includes('Prior authorization: always reviewed by staff.') && page.includes('Always to staff'), 'item screen shows the reason');
  assert.ok(intake.queuePage(store.list(), store.counts(), '').includes('Prior authorization: staff'), 'queue shows it');
  // The same lab result with passing mentions is filed as usual (category: Lab Results, see 5).
  process.env.INTAKE_CATEGORY_MAP = '{"lab_result":"Lab Results"}';
  const mention = add(LAB_MENTIONS, 'mentions.pdf');
  await quiet(() => pipe.process(mention.id));
  assert.deepStrictEqual([store.get(mention.id)!.status, store.get(mention.id)!.filed?.document_type], ['filed', 'Lab Results'], 'a lab result mentioning a referral or refill is filed');
  // INTAKE_ALWAYS_PERSON=none: the rule is off.
  process.env.INTAKE_ALWAYS_PERSON = 'none';
  const pa2 = add(PRIOR_AUTH, 'pa2.pdf');
  await quiet(() => pipe.process(pa2.id));
  assert.ok(!/always reviewed/.test(store.get(pa2.id)!.note || '') && !/always reviewed/.test(itemAutoFileBlocker(store.get(pa2.id)!)), 'rule off');
  delete process.env.INTAKE_ALWAYS_PERSON;
  ok('always to a person: records requests, prior authorizations, refill requests (title, RE: line, ticked box) and referrals held with the reason even on a perfect match; passing mentions, unticked boxes and "Thank you for referring" are not caught; INTAKE_ALWAYS_PERSON list, aliases, fail-closed typo, off');

  // ── 2. Critical results ─────────────────────────────────────────────────────
  assert.ok(abnormalFlags('GLU              41LL (70-99) mg/dL').critical, '"41LL": a critical flag written against the value');
  assert.ok(abnormalFlags('Potassium     6.6 mmol/L     “HH     (3.5-5.1)').critical, 'a star read as a quote');
  assert.ok(abnormalFlags('Potassium 6.8 (C)').critical);
  assert.ok(abnormalFlags('** CRITICAL RESULT: Potassium 6.8 called to RN **').critical);
  assert.ok(abnormalFlags('PANIC VALUE: glucose 38').critical);
  for (const line of [
    'Critical values are telephoned to the ordering client per laboratory policy.',
    'Critical valuos aro telephonod to the ordering clent per laboratory policy',
    'Critical values.are tolophoned to the ordering client per laboratory policy',
    'Critical values: none',
    'Syringa Valley Hospital - Critical Care Unit',
    'Sodium 134 L (135-145)',
  ]) {
    assert.ok(!abnormalFlags(line).critical, `not critical: ${line}`);
  }
  // Marked on the item as soon as it is read.
  delete process.env.INTAKE_REVIEW_USER;
  const crit = add(LAB_CRITICAL, 'critical.pdf');
  calls.length = 0;
  await quiet(() => pipe.process(crit.id));
  let c = store.get(crit.id)!;
  assert.deepStrictEqual([c.notify?.critical, c.notify?.call_required], [true, true], 'phone call required, recorded at read');
  assert.strictEqual(c.status, 'matched');
  assert.strictEqual(autoFileBlocker(c), 'critical result, and no one is set up to receive its review task');
  assert.ok(/waiting for staff: critical result/.test(c.note || ''), 'never auto-filed without someone to get its task');
  assert.ok(!actions().includes('SaveScanDocument'));
  process.env.INTAKE_REVIEW_USER = 'REVIEW.POOL';
  assert.strictEqual(autoFileBlocker(c), '');
  delete process.env.INTAKE_REVIEW_USER;
  process.env.INTAKE_CRITICAL_NOTIFY = 'RN.ONCALL';
  assert.strictEqual(autoFileBlocker(c), '', 'INTAKE_CRITICAL_NOTIFY alone is enough');
  // Filed: High priority, CRITICAL first, to INTAKE_CRITICAL_NOTIFY.
  calls.length = 0;
  const r1 = await quiet(() => filing.fileToChart(c, 'drawbridge', deps()));
  const t1 = calls.find((k) => k.action === 'SaveTask')!;
  assert.deepStrictEqual([t1.params.Parameter1, t1.params.Parameter2, t1.params.Parameter3], ['Review', 'RN.ONCALL', r1.document_id]);
  assert.ok(/<taskpriority>High<\/taskpriority>/.test(t1.params.Parameter5), 'High priority');
  assert.ok(/<subject>CRITICAL: New outside document for review: Outside lab/.test(t1.params.Parameter5), `CRITICAL first: ${t1.params.Parameter5}`);
  assert.ok(t1.params.Parameter4.startsWith('CRITICAL result: a phone call is required.'));
  c = store.get(crit.id)!;
  assert.deepStrictEqual(
    [c.status, c.notify?.critical, c.notify?.call_required, c.notify?.priority, c.notify?.recipient, c.notify?.recipient_source, c.notify?.task_id],
    ['filed', true, true, 'High', 'RN.ONCALL', 'critical_notify', r1.task_id]
  );
  assert.ok(c.history.some((h) => /^CRITICAL review task \d+ sent to RN\.ONCALL, critical results recipient \(High\)$/.test(h.action)));
  const critPage = intake.itemPage(c);
  assert.ok(critPage.includes('A phone call is required. Drawbridge does not place calls.') && critPage.includes('High priority'), 'shown on the item');
  assert.ok(intake.queuePage([c], store.counts(), '').includes('critical: call required'), 'and in the queue');
  // A routine result: Medium, no prefix.
  process.env.INTAKE_REVIEW_USER = 'REVIEW.POOL';
  const routine = add(LAB_ROUTINE, 'routine.pdf');
  calls.length = 0;
  await quiet(() => pipe.process(routine.id));
  const t2 = calls.find((k) => k.action === 'SaveTask')!;
  assert.ok(/<taskpriority>Medium<\/taskpriority><subject>New outside document/.test(t2.params.Parameter5) && t2.params.Parameter2 === 'REVIEW.POOL');
  assert.deepStrictEqual([store.get(routine.id)!.notify?.critical, store.get(routine.id)!.notify?.call_required], [false, false]);
  // Task refused, no answer, no task ID, no recipient: filed, but back to staff with the reason.
  const back: string[] = [];
  for (const mode of ['reject', 'timeout', 'noid', 'none'] as const) {
    if (mode === 'none') {
      delete process.env.INTAKE_CRITICAL_NOTIFY;
      delete process.env.INTAKE_REVIEW_USER;
      process.env.INTAKE_FILING = 'review';
    } else fake.task = mode;
    const it = add(LAB_CRITICAL, `critical-${mode}.pdf`);
    store.update(it.id, { extracted: x(LAB_CRITICAL), match: c.match, document_type: c.document_type, status: 'matched' });
    const r = await quiet(() => filing.fileToChart(store.get(it.id)!, 'staff1', deps()));
    const after = store.get(it.id)!;
    assert.deepStrictEqual([after.status, after.filed?.document_id], ['needs_review', r.document_id], `${mode}: filed, back to staff`);
    assert.ok(/^CRITICAL result filed to the chart \(document \d+\), but no review task was created \((TASK_REJECTED|TASK_UNCERTAIN|NO_TASK_ID|NO_RECIPIENT)\)\. Tell the provider now: a phone call is required\.$/.test(after.note || ''), after.note);
    assert.ok(r.task_error);
    back.push(it.id);
  }
  fake.task = 'ok';
  process.env.INTAKE_FILING = 'auto';
  await assert.rejects(filing.fileToChart(store.get(back[0])!, 't', deps()), (e: any) => e.error_code === 'ALREADY_FILED', 'never filed twice');
  const untold = intake.itemPage(store.get(back[0])!);
  assert.ok(/<button[^>]*>Provider was told</.test(untold) && /<button[^>]*disabled[^>]*>File to chart</.test(untold), 'staff can record the call; filing is disabled');
  assert.ok(untold.includes('Veradigm® EHR refused it'));
  // Nothing in intake ever places a call: the only Veradigm actions used are these four.
  assert.ok(calls.every((k) => ['SaveScanDocument', 'SaveTask', 'GetProviders', 'GetScheduleByPatientID'].includes(k.action)));
  const intakeDir = path.dirname(require.resolve('../platform/modules/intake/notify'));
  for (const f of fs.readdirSync(intakeDir).filter((n) => /\.(ts|js)$/.test(n) && !n.endsWith('.d.ts'))) {
    const src = fs.readFileSync(path.join(intakeDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/outreach|dialer|retell|placeCall|createPhoneCall|\/v2\/create-phone-call/i.test(src), `${f}: no call placing`);
  }
  ok('critical results: lab flags read (41LL, “HH, (C), CRITICAL/PANIC; not the policy line, OCR-garbled or not), phone call required on the item at read, High priority + "CRITICAL" subject to INTAKE_CRITICAL_NOTIFY (else the normal recipient), never auto-filed without a recipient, back to staff when the task is refused/unanswered/without ID/without recipient, no call placed');

  // ── 3. Review task to the ordering provider ─────────────────────────────────
  const op = (t: string) => {
    const v = x(t).ordering_provider;
    return v ? [v.value.first, v.value.last, v.confidence] : undefined;
  };
  assert.deepStrictEqual(op('Ordering Provider: Imani Castell, MD  (Idaho Kidney Institute)'), ['Imani', 'Castell', 'high']);
  assert.deepStrictEqual(op('Patient: X Y     Ordering: Lucinda Farr, MO'), ['Lucinda', 'Farr', 'high'], 'fax OCR of ", MD"');
  assert.deepStrictEqual(op('Ordering Provider, Teodor Quill, MID (Idaho Kidney Institute)'), ['Teodor', 'Quill', 'high']);
  assert.deepStrictEqual(op('Ordered by: Dr. Hale'), ['', 'Hale', 'high']);
  assert.deepStrictEqual(op('Requesting Physician: HALE, ROWAN'), ['Rowan', 'Hale', 'high']);
  assert.deepStrictEqual(op('Physician: R. Hale, DO'), ['R', 'Hale', 'medium']);
  assert.deepStrictEqual(op('Exam: US RENAL     Referring: Dr. Priya Vanterpool'), ['Priya', 'Vanterpool', 'medium']);
  assert.deepStrictEqual(op('Attn:   Dr. Imani Castell\nRE: Lab results'), ['Imani', 'Castell', 'medium'], 'cover sheet');
  assert.deepStrictEqual(op('Please forward to Or, imani Castell at Idaho Kidney Institute.'), ['Imani', 'Castell', 'medium'], '"Dr." read as "Or,"');
  assert.deepStrictEqual(op('Ordering: Rowan Hale, MD\nAttn: Dr. Imani Castell'), ['Rowan', 'Hale', 'high'], 'the ordering label wins over the cover sheet');
  assert.deepStrictEqual(op('Attn: Dr. Imani Castell\nPlease forward to Dr. Rowan Hale at IKI.'), ['Imani', 'Castell', 'low'], 'two different people: not used');
  for (const t of [
    'Electronically signed by Corwin Ashdale, MD on 10/08/2026',
    'Interpreting Physician: Elspeth Moraine, MD',
    'Reviewed by: Junia Pell, MD',
    'Performing Lab: Larkspur. Medical Director: Odessa Wren, MD',
    'Critical values are telephoned to the ordering client per laboratory policy.',
    'Ordering: Idaho Kidney Institute',
    'Attn: Medical Records',
    'Physician: Hale',
  ]) {
    assert.strictEqual(op(t), undefined, `no ordering provider in: ${t}`);
  }
  assert.strictEqual(parseProvider('Dr. Anh Van Der Berg, MD')?.last, 'Van Der Berg');

  const dirList = notify.parseProviders(providerRows);
  assert.deepStrictEqual(dirList.map((p) => p.user), ['EXAMPLE.E', 'HALE.R', 'HALE.J', 'CASTELL.I', '', '', 'INGRAM.S'], 'inactive providers dropped (Inactive, ProviderInactive); a row without a user name or with an inactive login kept (it can be matched, never sent to)');
  assert.deepStrictEqual(dirList.slice(5).map((p) => [p.id, p.first, p.last]), [['108', 'Locked', 'Out'], ['109', 'Sable', 'Ingram']], 'EntryCode as the ID, names trimmed');
  assert.strictEqual(notify.matchProvider({ first: 'Locked', last: 'Out', full: 'Locked Out' }, dirList).provider, undefined, 'inactive login: no task');
  assert.strictEqual(notify.matchProvider({ first: 'Sable', last: 'Ingram', full: 'Sable Ingram' }, dirList).provider?.user, 'INGRAM.S');
  assert.deepStrictEqual(notify.parseProviders([{ ProviderName: 'Castell, Imani', UserName: 'IC' }, { Name: 'Rowan Q Hale', Username: 'RH' }]).map((p) => [p.first, p.last, p.user]), [['Imani', 'Castell', 'IC'], ['Rowan', 'Hale', 'RH']]);
  const mp = (first: string, last: string) => notify.matchProvider({ first, last, full: `${first} ${last}` }, dirList);
  assert.strictEqual(mp('Rowan', 'Hale').provider?.user, 'HALE.R');
  assert.strictEqual(mp('R', 'Hale').provider?.user, 'HALE.R', 'initial');
  assert.strictEqual(mp('', 'Hale').provider, undefined, 'two Hales: no guess');
  assert.ok(/2 providers/.test(mp('', 'Hale').note));
  assert.strictEqual(mp('', 'Example').provider?.user, 'EXAMPLE.E', 'a last name alone when only one provider has it');
  assert.strictEqual(mp('Imani', 'Castel').provider?.user, 'CASTELL.I', 'one letter off (OCR) with the exact first name');
  assert.strictEqual(mp('Ivan', 'Castel').provider, undefined);
  assert.strictEqual(mp('Bob', 'Hale').provider, undefined, 'another first name: no match');
  assert.ok(/no user name/.test(mp('Noel', 'Nouser').note));
  assert.strictEqual(mp('Old', 'Gone').provider, undefined, 'inactive');
  // Directory: one GetProviders (EHR) per hour; failures throw, never an empty list.
  let clock = 0;
  const dirCalls: string[] = [];
  const dirUnity = { executeAction: async (a: string, _p: any, _pid: string, target: string) => (dirCalls.push(`${a}:${target}`), { success: true, data: providerRows }) };
  const dir = new notify.ProviderDirectory(dirUnity as any, () => clock);
  await dir.list();
  await dir.list();
  clock += 61 * 60_000;
  await dir.list();
  assert.deepStrictEqual(dirCalls, ['GetProviders:EHR', 'GetProviders:EHR']);
  assert.strictEqual(UnityActions.Provider.GET_PROVIDERS, 'GetProviders');
  await assert.rejects(new notify.ProviderDirectory({ executeAction: async () => ({ success: false, error: 'x' }) } as any).list(), (e: any) => typeof e.code === 'string');
  await assert.rejects(new notify.ProviderDirectory({ executeAction: async () => ({ success: true, data: [] }) } as any).list(), (e: any) => typeof e.code === 'string');

  // Filing with INTAKE_TASK_TARGET=ordering_provider
  process.env.INTAKE_TASK_TARGET = 'ordering_provider';
  process.env.INTAKE_REVIEW_USER = 'REVIEW.POOL';
  const fileWith = async (text: string, name: string) => {
    const it = add(text, name);
    store.update(it.id, { extracted: x(text), match: c.match, document_type: c.document_type, status: 'matched' });
    calls.length = 0;
    await quiet(() => filing.fileToChart(store.get(it.id)!, 'staff1', deps()));
    return { item: store.get(it.id)!, task: calls.find((k) => k.action === 'SaveTask'), calls: [...calls] };
  };
  let f = await fileWith(LAB_ROUTINE, 'op-hale.pdf');
  assert.strictEqual(f.task?.params.Parameter2, 'HALE.R', 'Rowan Hale, MD on the document → his Veradigm® EHR user');
  assert.deepStrictEqual(f.calls.filter((k) => k.action === 'GetProviders').map((k) => [k.target, k.pid, JSON.stringify(k.params)]), [['EHR', '', '{}']], 'read-only GetProviders');
  assert.deepStrictEqual([f.item.notify?.recipient_source, f.item.notify?.ordering_provider?.name, f.item.notify?.ordering_provider?.user], ['ordering_provider', 'Rowan Hale', 'HALE.R']);
  assert.ok(intake.itemPage(f.item).includes('Rowan Hale') && intake.itemPage(f.item).includes('(ordering provider)'));
  f = await fileWith(LAB_ROUTINE.replace('Rowan Hale', 'Ingrid Nobody'), 'op-unknown.pdf');
  assert.deepStrictEqual([f.task?.params.Parameter2, f.item.notify?.recipient_source], ['REVIEW.POOL', 'review_user'], 'no confident match → INTAKE_REVIEW_USER');
  assert.ok(/not found/.test(f.item.notify?.ordering_provider?.note || ''));
  f = await fileWith(LAB_ROUTINE.replace('Ordering Provider: Rowan Hale, MD', 'Ordered by: Dr. Hale'), 'op-two-hales.pdf');
  assert.strictEqual(f.task?.params.Parameter2, 'REVIEW.POOL', 'two Hales: review user');
  f = await fileWith(LAB_ROUTINE.replace(/Ordering Provider:.*\n/, ''), 'op-none.pdf');
  assert.deepStrictEqual([f.task?.params.Parameter2, f.item.notify?.ordering_provider?.note], ['REVIEW.POOL', 'No ordering provider found on the document.']);
  fake.providers = 'fail';
  f = await fileWith(LAB_ROUTINE, 'op-dir-down.pdf');
  assert.deepStrictEqual([f.task?.params.Parameter2, f.item.status], ['REVIEW.POOL', 'filed'], 'provider list down → review user, filing unaffected');
  assert.ok(/Provider list unavailable/.test(f.item.notify?.ordering_provider?.note || ''));
  fake.providers = 'ok';
  // Critical: INTAKE_CRITICAL_NOTIFY still wins; unset, the ordering provider gets the High task.
  process.env.INTAKE_CRITICAL_NOTIFY = 'RN.ONCALL';
  f = await fileWith(LAB_CRITICAL, 'op-crit-rn.pdf');
  assert.deepStrictEqual([f.task?.params.Parameter2, f.item.notify?.ordering_provider?.user], ['RN.ONCALL', 'EXAMPLE.E']);
  delete process.env.INTAKE_CRITICAL_NOTIFY;
  f = await fileWith(LAB_CRITICAL, 'op-crit.pdf');
  assert.deepStrictEqual([f.task?.params.Parameter2, f.item.notify?.priority], ['EXAMPLE.E', 'High'], 'Dr. Example, the only Example');
  // review_user (default): no provider lookup at all.
  delete process.env.INTAKE_TASK_TARGET;
  f = await fileWith(LAB_ROUTINE, 'op-default.pdf');
  assert.deepStrictEqual([f.task?.params.Parameter2, f.calls.some((k) => k.action === 'GetProviders')], ['REVIEW.POOL', false]);
  assert.ok(/Not used/.test(f.item.notify?.ordering_provider?.note || ''));
  assert.strictEqual(notify.taskTarget(), 'review_user');
  process.env.INTAKE_TASK_TARGET = 'Ordering-Provider';
  assert.strictEqual(notify.taskTarget(), 'ordering_provider');
  ok('ordering provider: read from Ordering/Ordered by/Requesting/Physician/Referring/Attn labels (OCR-tolerant, never the signing or interpreting doctor), matched to exactly one active Veradigm® EHR provider with a user name (GetProviders, read-only, 1 h cache), task to that user; INTAKE_REVIEW_USER when unsure or the list is down; critical recipient still wins');

  // ── 4. Same-day appointments ────────────────────────────────────────────────
  process.env.INTAKE_SAME_DAY_NO_NOTIFY = 'on';
  assert.strictEqual(UnityActions.Scheduling.GET_APPOINTMENTS, 'GetScheduleByPatientID', 'the by-patient schedule, never GetSchedule');
  fake.appointments = [
    { Patient_ID: '9001', Appointment_DateTime: '10/8/2026 9:30:00 AM', Status: 'S' },
    { Patient_ID: '9001', Appointment_DateTime: '10/20/2026 1:00:00 PM', Status: 'S' },
  ];
  f = await fileWith(LAB_ROUTINE, 'sd-same.pdf');
  assert.strictEqual(f.task, undefined, 'collection date = appointment date: no task');
  const sched = f.calls.filter((k) => k.action === 'GetScheduleByPatientID');
  assert.deepStrictEqual(sched.map((k) => [k.pid, k.target]), [['9001', 'PM']], 'read-only lookup by PM patient ID');
  assert.ok(!f.calls.some((k) => k.action === 'GetSchedule'));
  assert.deepStrictEqual([f.item.status, f.item.notify?.skipped, f.item.notify?.same_day?.date], ['filed', 'same_day_appointment', '10/08/2026'], 'filed, no notification');
  assert.ok(f.item.history.some((h) => h.action === 'no review task: same-day appointment on 10/08/2026'));
  assert.ok(intake.itemPage(f.item).includes('Not sent: Appointment on 10/08/2026'));
  f = await fileWith(LAB_CRITICAL, 'sd-critical.pdf');
  assert.ok(f.task && /High/.test(f.task.params.Parameter5), 'critical always notifies');
  assert.ok(!f.calls.some((k) => k.action === 'GetScheduleByPatientID'), 'no lookup needed for a critical result');
  for (const [label, appts, mode] of [
    ['cancelled that day', [{ Patient_ID: '9001', Appointment_DateTime: '10/8/2026 9:30:00 AM', Status: 'X' }], 'ok'],
    ['no-show that day', [{ Patient_ID: '9001', Appointment_DateTime: '10/8/2026 9:30:00 AM', Status: 'N' }], 'ok'],
    ['another day', [{ Patient_ID: '9001', Appointment_DateTime: '10/9/2026 9:30:00 AM', Status: 'S' }], 'ok'],
    ["another patient's row", [{ Patient_ID: '9555', Appointment_DateTime: '10/8/2026 9:30:00 AM', Status: 'S' }], 'ok'],
    ['lookup refused', [], 'fail'],
    ['lookup down', [], 'throw'],
  ] as const) {
    fake.appointments = [...appts] as any;
    fake.schedule = mode;
    f = await fileWith(LAB_ROUTINE, `sd-${label}.pdf`);
    assert.ok(f.task, `${label}: notified as usual`);
    assert.strictEqual(f.item.notify?.skipped, undefined);
  }
  assert.ok(/Appointment lookup failed \(SCHEDULE_LOOKUP_FAILED\); notified as usual\./.test(f.item.notify?.same_day?.note || ''));
  fake.schedule = 'ok';
  fake.appointments = [{ Patient_ID: '9001', Appointment_DateTime: '10/8/2026 9:30:00 AM', Status: 'C' }];
  f = await fileWith(LAB_ROUTINE.replace(/Date Collected:.*\n/, ''), 'sd-no-date.pdf');
  assert.ok(f.task && /No collection or service date/.test(f.item.notify?.same_day?.note || ''), 'no collection date on the document: notified');
  f = await fileWith(consult, 'sd-consult.pdf');
  assert.ok(f.task && !f.calls.some((k) => k.action === 'GetScheduleByPatientID'), 'only lab and imaging results');
  const noPm = add(LAB_ROUTINE, 'sd-no-pm.pdf');
  store.update(noPm.id, { extracted: x(LAB_ROUTINE), match: { ...c.match!, patient: { ...c.match!.patient!, patientId: '' } }, document_type: c.document_type, status: 'matched' });
  calls.length = 0;
  await quiet(() => filing.fileToChart(store.get(noPm.id)!, 't', deps()));
  assert.ok(calls.some((k) => k.action === 'SaveTask') && !calls.some((k) => k.action === 'GetScheduleByPatientID'), 'EHR-only patient: notified');
  process.env.INTAKE_SAME_DAY_NO_NOTIFY = 'off';
  f = await fileWith(LAB_ROUTINE, 'sd-off.pdf');
  assert.ok(f.task && !f.calls.some((k) => k.action === 'GetScheduleByPatientID'), 'setting off: no lookup');
  delete process.env.INTAKE_SAME_DAY_NO_NOTIFY;
  ok('same-day appointments: no task when the collection date is an appointment day (GetScheduleByPatientID by PM patient ID, read-only), filed anyway; critical always notifies; cancelled/no-show/other days/other patients/failed lookups/no date/no PM ID/non-results notify as usual; off by default');

  // ── 5. Lab category for IKI ─────────────────────────────────────────────────
  const types = parseDocumentTypes(typeRows);
  const iki = { lab_result: 'Lab Results' };
  assert.deepStrictEqual(mapKindToType('lab_result', types, undefined, iki), { id: '16', name: 'Lab Results', reason: 'configured' }, 'IKI: INTAKE_CATEGORY_MAP={"lab_result":"Lab Results"}');
  assert.strictEqual(mapKindToType('lab_result', types, undefined, {})!.name, 'Labs/Procedures', 'without the map, an EHR with both names gets Labs/Procedures (the sandbox list): IKI sets the map');
  assert.strictEqual(mapKindToType('lab_result', types.filter((t) => t.name !== 'Labs/Procedures'), undefined, {})!.name, 'Lab Results', 'an EHR with only "Lab Results" gets it by default');
  assert.strictEqual(mapKindToType('lab_result', types, 'pathology', iki)!.name, 'Lab Results', 'pathology without its own category goes to Lab Results too');
  assert.strictEqual(store.list().find((i) => i.file?.name === 'mentions.pdf')!.filed?.document_type, 'Lab Results', 'filed under Lab Results end to end');
  ok('lab category: "Lab Results" with IKI\'s INTAKE_CATEGORY_MAP (end to end); the default alone picks Labs/Procedures when both exist');

  // ── Staff route: "Provider was told" (127.0.0.1; login is the platform's job) ──
  const shared = intakeStore();
  const told = shared.addDocument({ source: 'upload', source_ref: '', name: 'told.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4\ntold'), text: LAB_CRITICAL, by: 'smoke' }).item;
  shared.update(told.id, {
    status: 'needs_review',
    extracted: x(LAB_CRITICAL),
    filed: { document_id: '5999', document_type: 'Lab Results', doc_status: '2', at: NOW.toISOString(), by: 'drawbridge' },
    notify: { critical: true, call_required: true, task_error: 'TASK_REJECTED' },
    note: 'CRITICAL result filed ...',
  });
  const app = express();
  app.use('/app/intake', (req: any, _res, next) => {
    req.drawbridgeUser = 'smoke.staff';
    next();
  }, intake.intakeModule.appRouter!({} as any));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/app/intake`;
  try {
    const cat = await fetch(`${base}/item/${told.id}/category`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'type_id=12' });
    assert.ok(/m=ALREADY_FILED/.test(cat.headers.get('location') || ''), 'filed: category locked');
    const r = await fetch(`${base}/item/${told.id}/notified`, { method: 'POST', redirect: 'manual' });
    assert.ok(r.status === 302 && /m=notified/.test(r.headers.get('location') || ''));
    const after = shared.get(told.id)!;
    assert.deepStrictEqual([after.status, after.notify?.handled_by, after.note], ['filed', 'smoke.staff', undefined]);
    assert.ok(after.history.some((h) => h.by === 'smoke.staff' && /provider was told/.test(h.action)));
    const html = await fetch(`${base}/item/${told.id}`).then((res) => res.text());
    assert.ok(html.includes('Provider told (recorded by smoke.staff') && !/>Provider was told</.test(html) && !/\b(mcp|fhir|unity)\b/i.test(html));
  } finally {
    srv.close();
  }
  ok('staff route: a critical result filed without a task stays with staff until someone records that the provider was told');

  // Logs: item IDs and codes only (no names, user names, document text).
  const all = logged.join('\n');
  for (const bad of ['Testpatient', 'Marigold', 'Hale', 'HALE.R', 'RN.ONCALL', 'REVIEW.POOL', 'EXAMPLE.E', 'Example', 'Creatinine', '482913', 'lisinopril']) {
    assert.ok(!all.includes(bad), `log leaks "${bad}"`);
  }
  ok(`logs (${logged.length} lines) hold IDs and error codes only`);

  for (const k of ['INTAKE_FILING', 'INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED', 'INTAKE_REVIEW_USER', 'INTAKE_TASK_TARGET', 'INTAKE_CATEGORY_MAP']) delete process.env[k];
  filing.setFilingDeps(null);
  console.error = orig.error;
  console.log(`\n${passed} checks passed`);
}

main()
  .catch((e) => {
    console.error('FAIL', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
