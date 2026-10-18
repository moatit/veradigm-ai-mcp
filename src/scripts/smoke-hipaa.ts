/**
 * Offline checks for the HIPAA technical safeguards added on top of the staff login (127.0.0.1 only, fakes, no
 * Veradigm call; docs/drawbridge/HIPAA_TECHNICAL_SAFEGUARDS.md):
 *  - staff access audit: who opened which call record / document, for which patient, and staff actions (164.312(b))
 *  - document integrity: SHA-256 at receipt verified before a download and before filing (164.312(c))
 *  - access and disclosure report per patient / per staff user, admin only, HTML and CSV (164.528, breach scoping)
 *  - export and record-view volume alerts (security events, 164.308(a)(1)(ii)(D), 164.308(a)(6))
 *  - minimum necessary in what the phone agent receives (164.502(b), 164.514(d))
 *  - patient identifiers never in URLs; intake record retention; 6-year audit retention default
 *  - the "HIPAA & Compliance" staff page (signed-in only, plain language) and HIPAA_TECHNICAL_SAFEGUARDS.md are
 *    generated from the same safeguards list and agree
 *
 *   npm run smoke:hipaa
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-hipaa-'));
process.env.CALL_RECORDS_DIR = TMP;
process.env.AUDIT_DIR = TMP;
process.env.INTAKE_DROP_DIR = path.join(TMP, 'inbox');
process.env.INTAKE_OCR_URL = 'off';
process.env.CLINIC_TIMEZONE = 'America/Boise';
process.env.DRAWBRIDGE_USERS_FILE = path.join(TMP, 'users');
process.env.DRAWBRIDGE_SESSION_SECRET = 'smoke-hipaa-secret-0123456789abcdef';
process.env.DRAWBRIDGE_EXPORT_ALERT_PER_HOUR = '3';
process.env.DRAWBRIDGE_VIEW_ALERT_PER_HOUR = '4';
for (const k of [
  'INTAKE_MODE', 'INTAKE_ROSTER_CSV', 'INTAKE_REVIEW_USER', 'INTAKE_TASK_TARGET', 'INTAKE_DOC_STATUS', 'AUDIT_RETENTION_DAYS', 'NODE_ENV',
  'DRAWBRIDGE_REQUIRE_TOTP', 'DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS', 'DRAWBRIDGE_AGENT_STAFF_TOOLS', 'DRAWBRIDGE_USERNAME', 'DRAWBRIDGE_PASSWORD',
]) {
  delete process.env[k];
}

import assert from 'assert';
import type { AddressInfo } from 'net';

async function main(): Promise<void> {
  const express = (await import('express')).default;
  const shell = await import('../platform/shell');
  const auth = await import('../platform/staff-auth');
  const audit = await import('../platform/audit');
  const { staffAudit } = await import('../platform/app');
  const { onCallModule } = await import('../unity/oncall/notebook');
  const { callRecords } = await import('../unity/oncall/call-records');
  const intake = await import('../platform/modules/intake');
  const { intakeStore, IntakeStore } = await import('../platform/modules/intake/store');
  const filing = await import('../platform/modules/intake/file');
  const activity = await import('../platform/modules/activity');
  const mn = await import('../utils/minimum-necessary');
  const { toVoiceSummary } = await import('../utils/response-formatter');
  const sec = await import('../platform/security-events');
  const compliance = await import('../platform/modules/compliance');
  const safeguards = await import('../platform/modules/compliance/safeguards');

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };
  const quiet = { warn: console.warn, error: console.error, log: console.log };
  console.warn = () => undefined;
  console.error = () => undefined;
  console.log = (...a: unknown[]) => {
    if (!/^\[(SECURITY|Drawbridge|Intake)\]/.test(String(a[0]))) quiet.log(...a);
  };

  // Staff: one regular, one administrator, both with TOTP.
  const secrets: Record<string, string> = { 'pat.staff': auth.newTotpSecret(), 'ada.admin': auth.newTotpSecret() };
  fs.writeFileSync(
    process.env.DRAWBRIDGE_USERS_FILE!,
    `${shell.hashStaffPassword('pat.staff', 'river lamp orbit nine')}:totp=${secrets['pat.staff']}\n` +
      `${shell.hashStaffPassword('ada.admin', 'copper fern atlas kite')}:totp=${secrets['ada.admin']}:role=admin\n`
  );

  const deps: any = { unity: { executeAction: async () => ({ success: false, error: 'offline' }) }, runTool: async () => ({}) };
  const app = express();
  app.use('/app', shell.shellRouter());
  for (const [p, m] of [['/oncall', onCallModule], ['/intake', intake.intakeModule], ['/activity', activity.activityModule], ['/compliance', compliance.complianceModule]] as const) {
    shell.registerNav(m.nav!); // as mountPlatform does
    app.use(`/app${p}`, shell.requireLogin, staffAudit(m.name), express.urlencoded({ extended: false }), m.appRouter!(deps));
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** Each user signs in once here, so the current code is always unused. */
  const login = async (u: string, p: string) => {
    const code = auth.totpCode(secrets[u], Math.floor(Date.now() / 30_000));
    const r = await fetch(`${url}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ u, p, otp: code, next: '/app' }).toString() });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie, `sign-in of ${u}`);
    return cookie;
  };
  const get = (cookie: string, p: string) => fetch(`${url}${p}`, { redirect: 'manual', headers: { cookie } });
  const post = (cookie: string, p: string, body: Record<string, string>) =>
    fetch(`${url}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const lines = async () => {
    await audit.flushAudit();
    const dir = path.join(TMP, 'audit');
    return fs
      .readdirSync(dir)
      .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  };

  try {
    const pat = await login('pat.staff', 'river lamp orbit nine');
    const ada = await login('ada.admin', 'copper fern atlas kite');

    // 1. Staff access audit: views of PHI (who, which call record, which patient) and staff actions
    callRecords.upsert('call_hipaa1', 'after_hours', {
      verified: true,
      patient_name: 'Zelda Quixote',
      dob: '02/03/1950',
      patient_ref: { system: 'veradigm_ehr', id: '56500' },
      reason_verbatim: 'chest pain since noon',
    });
    const view = await get(pat, '/app/oncall/call/call_hipaa1');
    assert.strictEqual(view.status, 200);
    const viewHtml = await view.text();
    assert.ok(/<title>Call record · Drawbridge<\/title>/.test(viewHtml), 'no patient name in the page title (browser history)');
    assert.strictEqual((await get(pat, '/app/oncall')).status, 200);
    assert.strictEqual((await post(pat, '/app/oncall/mode', { mode: 'after_hours' })).status, 302);
    let l = await lines();
    const v = l.find((x) => x.kind === 'view' && x.object === 'call_record:call_hipaa1');
    assert.ok(v && v.user === 'pat.staff' && v.patient_id === '56500' && v.tool === 'oncall_view' && v.success && v.channel === 'staff_app', JSON.stringify(v));
    assert.ok(l.some((x) => x.kind === 'view' && x.object === '/app/oncall' && x.user === 'pat.staff' && !x.patient_id), 'list screen');
    assert.ok(l.some((x) => x.kind === 'staff' && x.tool === 'oncall_action' && x.object === '/app/oncall/mode' && x.user === 'pat.staff'), 'staff action (POST)');
    const text = JSON.stringify(l);
    for (const bad of ['Zelda', 'Quixote', '1950', 'chest pain', 'river lamp']) assert.ok(!text.includes(bad), `audit leaks "${bad}"`);
    for (const d of await audit.auditDays()) assert.ok((await audit.verifyAuditDay(d)).ok, 'hash chain intact with view lines');
    ok('staff access audit: every staff screen (view) and action (staff) with user, opaque path and patient ID; no names, DOBs or messages; hash chain intact');

    // 2. Document integrity: SHA-256 from receipt checked before a download and before filing
    process.env.INTAKE_FILING = 'review';
    process.env.INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED = 'true';
    const store = intakeStore();
    const doc = store.addDocument({ source: 'upload', source_ref: '', name: 'Quixote labs.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4\nhipaa original'), text: 'LAB', by: 'pat.staff' }).item;
    const patient = { patientId: '700', chartPatientId: '56500', name: 'Zelda Quixote', dateOfBirth: '02/03/1950', mrn: 'M1' };
    store.update(doc.id, { status: 'matched', match: { decision: 'auto', reason: 'two identifiers', candidates: 1, patient, checked_at: new Date().toISOString() } as any, document_type: { id: '12', name: 'Lab Results', reason: 'staff' } as any });
    const dl = await get(pat, `/app/intake/item/${doc.id}/original`);
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(Buffer.from(await dl.arrayBuffer()).toString(), '%PDF-1.4\nhipaa original');
    assert.strictEqual((await get(pat, `/app/intake/item/${doc.id}`)).status, 200);
    fs.writeFileSync(store.filePath(store.get(doc.id)!), '%PDF-1.4\ntampered');
    const bad = await get(pat, `/app/intake/item/${doc.id}/original`);
    assert.strictEqual(bad.status, 409, 'a changed original is not served');
    let called = 0;
    const fake = { executeAction: async () => ((called++, { success: true, data: [{ documentID: '1' }] }) as any) };
    await assert.rejects(filing.fileToChart(store.get(doc.id)!, 'pat.staff', { unity: fake, store: () => store }), (e: any) => e.error_code === 'INTEGRITY_FAILED');
    assert.strictEqual(called, 0, 'nothing sent to Veradigm');
    assert.deepStrictEqual([store.get(doc.id)!.status, store.get(doc.id)!.error_code], ['needs_review', 'INTEGRITY_FAILED']);
    l = await lines();
    assert.ok(l.some((x) => x.kind === 'security' && x.tool === 'export' && x.object === `intake_original:${doc.id}` && x.patient_id === '56500' && x.user === 'pat.staff'), 'download = export event');
    assert.ok(l.some((x) => x.kind === 'view' && x.object === `intake_item:${doc.id}` && x.patient_id === '56500'), 'item view with the chart patient ID');
    assert.strictEqual(l.filter((x) => x.tool === 'integrity_failed').length, 2, 'download and filing both raised integrity_failed');
    ok('integrity: the SHA-256 recorded at receipt is checked before a download (409) and before filing (INTEGRITY_FAILED, nothing sent); security events');

    // 3. Access and disclosure report: admin only, patient ID in the POST body, HTML and CSV, itself logged
    assert.strictEqual((await get(pat, '/app/activity/disclosures')).status, 403, 'staff role refused');
    assert.strictEqual((await post(pat, '/app/activity/disclosures', { patient: '56500', from: '2000-01-01', to: '2100-01-01' })).status, 403);
    const form = await (await get(ada, '/app/activity/disclosures')).text();
    assert.ok(/<form[^>]*method="post"[^>]*action="\/app\/activity\/disclosures"/.test(form), 'POST form');
    const today = audit.dayKey();
    const report = await post(ada, '/app/activity/disclosures', { patient: '56500', from: today, to: today, format: 'html' });
    assert.strictEqual(report.status, 200);
    const rhtml = await report.text();
    assert.ok(rhtml.includes('call_record:call_hipaa1') && rhtml.includes(`intake_original:${doc.id}`) && rhtml.includes('pat.staff'), 'views and exports of this patient');
    assert.ok(!rhtml.includes('Zelda'), 'no names from the audit');
    const csv = await post(ada, '/app/activity/disclosures', { patient: '56500', from: today, to: today, format: 'csv' });
    assert.ok(/text\/csv/.test(csv.headers.get('content-type') || '') && /attachment; filename="drawbridge-access-report-/.test(csv.headers.get('content-disposition') || ''));
    assert.ok(!(csv.headers.get('content-disposition') || '').includes('56500'), 'no patient ID in the file name');
    const csvText = await csv.text();
    assert.ok(csvText.startsWith('time_utc,type,staff_user,channel,what,object,outcome,error_code,call_id,patient_id') && csvText.includes(',56500'));
    assert.strictEqual(activity.accessReportCsv([{ ts: 't', server: 'unity', kind: 'tool', call_id: '=HYPERLINK("x")', tool: 't', patient_id: '1', success: true, error_code: '', latency_ms: 0, channel: 'c' }]).split('\r\n')[1].split(',')[8], `"'=HYPERLINK(""x"")"`, 'no spreadsheet formulas');
    const byUser = await activity.accessReport({ user: 'pat.staff', from: today, to: today });
    assert.ok(byUser.length >= 5 && byUser.every((e) => e.user === 'pat.staff'), 'per staff user (breach scoping)');
    assert.strictEqual((await post(ada, '/app/activity/disclosures', { from: today, to: today })).status, 400, 'a patient or a user is required');
    l = await lines();
    assert.ok(l.some((x) => x.kind === 'staff' && x.user === 'ada.admin' && x.patient_id === '56500' && /^access_report:/.test(x.object)), 'the report is itself logged');
    ok('access and disclosure report: administrators only, patient ID in the POST body (never the URL), per patient or staff user, HTML and CSV (formula-safe), itself logged');

    // 4. Volume alerts: exports (limit 3/h here) and patient-record views (limit 4/h here)
    l = await lines();
    const exportsSoFar = l.filter((x) => x.tool === 'export' && x.user === 'ada.admin').length;
    for (let i = exportsSoFar; i < 4; i++) await post(ada, '/app/activity/disclosures', { patient: '56500', from: today, to: today, format: 'csv' });
    for (let i = 0; i < 5; i++) await get(pat, '/app/oncall/call/call_hipaa1');
    l = await lines();
    assert.strictEqual(l.filter((x) => x.tool === 'export_volume_alert' && x.user === 'ada.admin').length, 1, 'one export alert per hour');
    assert.strictEqual(l.filter((x) => x.tool === 'view_volume_alert' && x.user === 'pat.staff').length, 1, 'one view alert per hour');
    const activityPage = await (await get(ada, `/app/activity?date=${today}`)).text();
    assert.ok(activityPage.includes('Security events') && activityPage.includes('export volume alert') && activityPage.includes('to review'), 'alerts on the Activity screen');
    let t = 0;
    const m = new sec.VolumeMonitor('export_volume_alert', () => 2, () => t);
    assert.deepStrictEqual([m.record('x'), m.record('x'), m.record('x'), m.record('x')], [false, false, true, false]);
    t += 3601_000;
    assert.deepStrictEqual([m.record('x'), m.record('x'), m.record('x')], [false, false, true], 'window slides');
    ok('unusual volume: exports and patient-record views over DRAWBRIDGE_EXPORT_/VIEW_ALERT_PER_HOUR raise one security event per user per hour, shown on Activity');

    // 5. Minimum necessary for the phone agent
    const full = {
      success: true,
      total: 2,
      message: 'Found 2 patient(s)',
      patients: [
        { id: '1', patientId: '700', chartPatientId: '56500', firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '02/03/1950', mrn: 'M1', ssnLast4: '6789', address: { line1: '1 Main' }, phone: { cell: '2085550100' }, email: 'z@example.com', race: 'x', gender: 'F' },
        { id: '2', patientId: '701', chartPatientId: '56501', firstName: 'Zelma', lastName: 'Quist', dateOfBirth: '07/07/1966', mrn: 'M2' },
      ],
    };
    const nameOnly: any = mn.forAgent('unity_search_patients', { lastName: 'Qu' }, full);
    assert.ok(nameOnly.withheld && !JSON.stringify(nameOnly).includes('Zel') && !JSON.stringify(nameOnly).includes('1950'), 'name-only search: count only');
    assert.ok(/date of birth/.test(toVoiceSummary('unity_search_patients', nameOnly)) && !/Zel/.test(toVoiceSummary('unity_search_patients', nameOnly)));
    const withDob: any = mn.forAgent('unity_search_patients', { firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '02/03/1950' }, { ...full, total: 1, patients: [full.patients[0]] });
    assert.deepStrictEqual(Object.keys(withDob.patients[0]).sort(), ['chartPatientId', 'dateOfBirth', 'firstName', 'id', 'lastName', 'patientId']);
    const byMrn: any = mn.forAgent('unity_get_patient_by_mrn', { mrn: 'M1' }, { success: true, patient: full.patients[0], message: 'ok' });
    assert.strictEqual(byMrn.patient.mrn, 'M1', 'MRN kept when the caller gave it');
    assert.ok(!('address' in byMrn.patient) && !('ssnLast4' in byMrn.patient) && !('phone' in byMrn.patient));
    const fhirPatient = { id: 'p1', name: 'Zelda Quixote', firstName: 'Zelda', lastName: 'Quixote', birthDate: '1950-02-03', phone: '2085550100', email: 'z@example.com', address: '1 Main', gender: 'female', mrn: 'M1' };
    assert.deepStrictEqual(Object.keys(mn.forAgent('get_patient_details', { patientId: 'p1' }, fhirPatient) as any).sort(), ['birthDate', 'firstName', 'id', 'lastName', 'name']);
    const deep: any = mn.forAgent('x', {}, { success: true, resource: { identifier: [{ system: 'urn:oid:2.16.840.1.113883.4.1', value: '123-45-6789' }, { type: { coding: [{ code: 'MR' }] }, value: 'M1' }], SSN: '123456789' } });
    assert.ok(!JSON.stringify(deep).includes('6789') && JSON.stringify(deep).includes('M1'), 'SSN identifiers and keys removed anywhere');
    const failure = { success: false, error_code: 'API_ERROR', retryable: true };
    assert.strictEqual(mn.forAgent('unity_search_patients', {}, failure), failure, 'failures untouched (never an empty result)');
    assert.ok(!mn.agentToolAllowed('unity_get_day_schedule') && !mn.agentToolAllowed('unity_get_changed_appointments') && mn.agentToolAllowed('unity_search_patients'));
    assert.ok(mn.agentToolAllowed('unity_get_day_schedule', { DRAWBRIDGE_AGENT_STAFF_TOOLS: 'on' } as any), 'staff voice assistant deployments only');
    ok('minimum necessary for the agent: name-only search gives a count, records cut to name/DOB/IDs (MRN only when given), no SSN anywhere, staff-only tools refused, failures untouched');

    // 6. No patient identifiers in staff URLs: patient-specific forms POST, links carry opaque IDs only
    const srcDir = path.join(process.cwd(), 'src', 'platform', 'modules');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const src = fs.readFileSync(p, 'utf8');
          if (/[?&](patientId|patient|dob|dateOfBirth|mrn|name|ssn)=/i.test(src.replace(/\/\/.*$/gm, ''))) offenders.push(path.relative(srcDir, p));
        }
      }
    };
    walk(srcDir);
    assert.deepStrictEqual(offenders, [], 'patient identifier in a staff URL');
    const sched = fs.readFileSync(path.join(srcDir, 'scheduling', 'screens.ts'), 'utf8');
    assert.ok(/<form method="post" action="\$\{BASE\}" class="row"/.test(sched), 'free-text staff question is POSTed');
    ok('no patient identifiers in staff URLs (query strings hold dates, statuses and opaque IDs only); free-text question POSTed');

    // 7. Retention: intake records lose patient details after INTAKE_RECORD_RETENTION_DAYS; audit default is 6 years
    let clock = Date.now();
    const rStore = new IntakeStore(path.join(TMP, 'retention'), () => new Date(clock));
    const filed = rStore.addDocument({ source: 'upload', source_ref: '', name: 'Quixote Zelda.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4\nretention'), text: 'Zelda Quixote 02/03/1950', by: 'x' }).item;
    rStore.update(filed.id, {
      status: 'filed',
      extracted: { name: { value: 'Zelda Quixote' } } as any,
      match: { decision: 'auto', reason: 'Zelda Quixote, 02/03/1950', candidates: 1, patient } as any,
      filed: { document_id: '9001', document_type: 'Lab Results', doc_status: '2', at: new Date(clock).toISOString(), by: 'x' },
      note: 'Zelda',
    });
    const waiting = rStore.addDocument({ source: 'upload', source_ref: '', name: 'waiting.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4\nwaiting'), text: 'Zelda', by: 'x' }).item;
    rStore.update(waiting.id, { status: 'needs_review', extracted: { name: { value: 'Zelda Quixote' } } as any });
    assert.strictEqual(rStore.purgeRecords(90), 0, 'not yet');
    clock += 91 * 86_400_000;
    assert.strictEqual(rStore.purgeRecords(90), 1);
    const after = rStore.get(filed.id)!;
    assert.ok(after.purged_at && !after.extracted && !after.note && after.file?.name === 'document' && after.file.sha256 && after.filed?.document_id === '9001');
    assert.deepStrictEqual(after.match?.patient, { patientId: '700', chartPatientId: '56500' } as any);
    assert.ok(!JSON.stringify(after).includes('Zelda') && !fs.existsSync(path.join(rStore.filesDir, `${filed.id}.txt`)));
    assert.ok(rStore.get(waiting.id)!.extracted, 'documents waiting for staff are never purged');
    assert.strictEqual(rStore.purgeRecords(90), 0, 'idempotent');
    assert.strictEqual(audit.retentionDays(), 2190, 'audit log kept 6 years by default');
    ok('retention: filed intake records drop names, DOBs, text and file names after INTAKE_RECORD_RETENTION_DAYS (IDs, hash, history stay; waiting items untouched); audit default 6 years');

    // 8. HIPAA & Compliance in the staff portal is "Your part" (staff duties only; Ali, Oct 18): signed-in only,
    // plain language. The full checklist goes to the admin dashboard as docs/drawbridge/hipaa-safeguards.json.
    const out = await fetch(`${url}/app/compliance`, { redirect: 'manual' });
    assert.ok(out.status === 302 && /\/app\/login\?next=%2Fapp%2Fcompliance/.test(out.headers.get('location') || ''), 'signed out → sign-in page');
    const cp = await get(pat, '/app/compliance');
    assert.strictEqual(cp.status, 200);
    const chtml = await cp.text();
    const body = chtml.split('<main>')[1] || '';
    assert.ok(body.includes('<h2 style="margin-top:4px">Your part</h2>') && chtml.includes('HIPAA &amp; Compliance</a>'), 'page heading "Your part" and the nav item');
    for (const want of ['Use only your own sign-in', 'authenticator code', 'Sign out when you step away', `after ${shell.idleMinutes()} minutes without activity`, 'Keep patient details out of email and chat', 'Report anything that looks wrong', 'help@moatit.com', '(208) 900-6628', 'Emergency access is for emergencies only']) {
      assert.ok(body.includes(shell.esc(want)), `page lacks "${want}"`);
    }
    for (const s of safeguards.SAFEGUARDS) assert.ok(!body.includes(shell.esc(s.citation)), `no checklist row ${s.citation} on the staff page`);
    for (const o of safeguards.ORGANIZATIONAL_SAFEGUARDS) assert.ok(!body.includes(shell.esc(o)), `no MOATiT item on the staff page: ${o}`);
    assert.ok(!/Last security checks|In place|Organizational/.test(body), 'no checklist badges or security checks on the staff page');
    const visible = body.replace(/<[^>]+>/g, ' ');
    assert.ok(!/\b(mcp|fhir|unity)\b/i.test(visible), 'client-facing words only (Veradigm® EHR / PM, never MCP, FHIR or Unity)');
    assert.ok(!/src\/|\.ts\b|DRAWBRIDGE_|INTAKE_|AUDIT_|NODE_ENV|localhost|127\.0\.0\.1|\.internal\b|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(visible), 'no code paths, settings, host names or IPs');
    l = await lines();
    assert.ok(l.some((x) => x.kind === 'view' && x.tool === 'compliance_view' && x.user === 'pat.staff'), 'page view audited like every staff screen');
    const hipaaDoc = fs.readFileSync(path.join(process.cwd(), 'docs', 'drawbridge', 'HIPAA_TECHNICAL_SAFEGUARDS.md'), 'utf8');
    assert.strictEqual(safeguards.checklistInDoc(hipaaDoc), safeguards.checklistMarkdown(), 'HIPAA_TECHNICAL_SAFEGUARDS.md is out of date: run npm run docs:hipaa');
    const jsonFile = fs.readFileSync(path.join(process.cwd(), safeguards.CHECKLIST_JSON), 'utf8').replace(/\r\n/g, '\n');
    assert.strictEqual(jsonFile, safeguards.checklistJson(), `${safeguards.CHECKLIST_JSON} is out of date: run npm run docs:hipaa`);
    const exported = JSON.parse(jsonFile);
    assert.strictEqual(exported.safeguards.length, safeguards.SAFEGUARDS.length);
    assert.ok(exported.safeguards.every((s: any, i: number) => s.citation === safeguards.SAFEGUARDS[i].citation && s.plain === safeguards.SAFEGUARDS[i].plain && s.status_label));
    assert.deepStrictEqual(exported.organizational_safeguards, safeguards.ORGANIZATIONAL_SAFEGUARDS);
    const c = safeguards.statusCounts();
    assert.strictEqual(c.PASS + c.FIXED + c.DEPLOYMENT + c.ORGANIZATIONAL, safeguards.SAFEGUARDS.length);
    ok(`HIPAA & Compliance: the staff page is "Your part" (signed-in only, five staff duties, help-desk contact, no checklist or MOATiT items, plain language); the document and the admin JSON match the same list (${safeguards.SAFEGUARDS.length} rows: ${c.PASS} PASS, ${c.FIXED} FIXED, ${c.DEPLOYMENT} DEPLOYMENT, ${c.ORGANIZATIONAL} ORGANIZATIONAL)`);
  } finally {
    await new Promise((r) => setTimeout(r, 300)); // last responses finish, then their audit lines are written
    await audit.flushAudit();
    server.close();
    delete process.env.INTAKE_FILING;
    delete process.env.INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED;
    console.warn = quiet.warn;
    console.error = quiet.error;
    console.log = quiet.log;
  }
  console.log(`\n${passed} checks passed`);
}

main()
  .catch((e) => {
    console.log('FAIL', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
