/**
 * Offline checks for the v7 voice work (no Veradigm, no Retell, no e-mail leaves the machine):
 *  1. System status: DOWN after N failed probes, overall up/degraded/down, de-duplicated help-desk alerts
 *     (down once, reminder, recovered once, retry of a failed send), messages counted, no PHI, events,
 *     state survives a restart without a second down alert.
 *  2. Help-desk transports: webhook JSON + HMAC signature; SMTP never sends without TLS.
 *  3. Health checker: error classes ("GetToken: Access is denied"), probe timeout, default 15 minutes with a
 *     2-minute floor, per-system floor guard (last probe or real answer), start-up order, early probe.
 *  4. Token keep-warm: renews only with recent activity and only when the token is due; failed renewals back off.
 *  5. Agent edge: RECORDS_UNAVAILABLE fail-fast text, upcoming visits with a verified match (minimum necessary,
 *     budget, never on a spelling variant), success-empty wording, slot IDs for booking.
 *  6. Retell inbound-call webhook: signature check, dynamic variables, HTTP end to end.
 *  7. drawbridge_take_message: call record, unverified identity kept as stated, counted while down.
 *  8. First-name spelling variant in unity_search_patients ("Theodoro" heard, "Teodoro" on file).
 *  9. Agent tool list and prompt: compact (about 4k tokens with the prompt), fillers, safety lines kept,
 *     no FHIR fallback instruction, coordinator bugs covered.
 *
 *   npm run smoke:voice
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-voice-'));
process.env.CALL_RECORDS_DIR = TMP;
process.env.AUDIT_DIR = TMP;
for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD', 'CLIENT_ID', 'CLIENT_SECRET']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
for (const k of ['HELPDESK_SMTP_URL', 'HELPDESK_WEBHOOK_URL', 'HELPDESK_WEBHOOK_SECRET', 'RETELL_WEBHOOK_SECRET', 'RETELL_API_KEY', 'RETELL_WEBHOOK_API_KEY', 'UNITY_HEALTH_CHECK_MIN', 'UNITY_KEEP_WARM_MINUTES', 'DRAWBRIDGE_FHIR_TOOLS']) delete process.env[k];
process.env.CLINIC_NAME = 'Sagebrush Kidney Care';

import assert from 'assert';
import { createHmac } from 'crypto';
import * as http from 'http';
import * as net from 'net';
import type { AlertMessage, AlertTransport } from '../platform/helpdesk';

async function main(): Promise<void> {
  const { SystemStatus, setSystemStatus } = await import('../platform/system-status');
  const helpdesk = await import('../platform/helpdesk');
  const health = await import('../unity/services/unity-health');
  const edge = await import('../unity/agent-edge');
  const { toVoiceSummary } = await import('../utils/response-formatter');
  const inbound = await import('../platform/modules/activity/retell-inbound');
  const { OnCallTools } = await import('../unity/oncall/oncall.tools');
  const { callRecords } = await import('../unity/oncall/call-records');
  const { UnityPatientTools } = await import('../unity/tools/patient.tools');
  const { compactAgentTools, AGENT_TOOLS } = await import('../platform/agent-tools');
  const { statusBanner, statusCard } = await import('../platform/status-ui');

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const e = console.error, w = console.warn, l = console.log;
    console.error = console.warn = console.log = () => undefined;
    try {
      return await fn();
    } finally {
      console.error = e;
      console.warn = w;
      console.log = l;
    }
  };

  // ── 1. System status + de-duplicated alerts ────────────────────────────────
  let now = Date.parse('2026-10-15T20:02:00Z');
  const sent: AlertMessage[] = [];
  let failNext = 0;
  const fakeTransport: AlertTransport = {
    name: 'fake',
    async send(m) {
      if (failNext > 0) {
        failNext--;
        throw Object.assign(new Error('mail server down'), { code: 'ECONNREFUSED' });
      }
      sent.push(m);
    },
  };
  const events: string[] = [];
  const mk = (dir = path.join(TMP, 'status')) =>
    new SystemStatus({
      targets: () => ['PM', 'EHR'],
      notifier: new helpdesk.HelpdeskNotifier(() => [fakeTransport]),
      now: () => now,
      dir,
      log: () => undefined,
      event: (n, code) => events.push(`${n}:${code}`),
    });
  const st = mk();
  st.recordProbe('PM', true);
  st.recordProbe('EHR', true);
  assert.strictEqual(st.overall(), 'up');
  st.recordProbe('PM', false, 'AUTH_ERROR', 'GetToken: Access is denied');
  assert.strictEqual(st.snapshot().components[0].state, 'up', 'one failed probe is not DOWN');
  st.recordProbe('EHR', false, 'AUTH_ERROR', 'GetToken: Access is denied');
  now += 120_000;
  st.recordProbe('PM', false, 'AUTH_ERROR', 'GetToken: Access is denied');
  assert.strictEqual(st.overall(), 'degraded');
  st.recordProbe('EHR', false, 'AUTH_ERROR', 'GetToken: Access is denied');
  await st.flush();
  assert.strictEqual(st.overall(), 'down');
  assert.ok(st.isDown());
  assert.strictEqual(sent.length, 1, 'one alert for the outage (degraded then down)');
  // The alert is built when it is sent, so it reports the state at that moment (here already DOWN).
  assert.ok(/(DEGRADED|DOWN) since/.test(sent[0].subject) && /Sagebrush Kidney Care/.test(sent[0].subject), sent[0].subject);
  assert.ok(sent[0].text.includes('GetToken: Access is denied') && sent[0].text.includes('No patient information'), sent[0].text);
  assert.ok(events.includes('system_down:AUTH_ERROR') && events.includes('helpdesk_alert:DOWN'));
  // More failures: no new alert
  for (let i = 0; i < 5; i++) {
    now += 120_000;
    st.recordProbe('PM', false, 'TIMEOUT_ERROR', 'GetToken: timed out');
    st.recordProbe('EHR', false, 'TIMEOUT_ERROR', 'GetToken: timed out');
    await st.tick();
  }
  await st.flush();
  assert.strictEqual(sent.length, 1, 'no repeat while down before the reminder time');
  assert.strictEqual(st.noteMessageTaken(), 1);
  assert.strictEqual(st.noteMessageTaken(), 2);
  // Restart: same outage, no second down alert
  const st2 = mk();
  assert.strictEqual(st2.overall(), 'down');
  await st2.tick();
  await st2.flush();
  assert.strictEqual(sent.length, 1, 'restart keeps the outage and does not re-alert');
  // Reminder after HELPDESK_REMINDER_HOURS (4)
  now += 4 * 3_600_000;
  await st2.tick();
  await st2.flush();
  assert.strictEqual(sent.length, 2);
  assert.ok(/reminder: still down/.test(sent[1].subject) && sent[1].text.includes('while the system was down: 2'), sent[1].text);
  await st2.tick();
  await st2.flush();
  assert.strictEqual(sent.length, 2, 'one reminder per window');
  // Recovery: a real call success brings PM up (degraded), a probe brings EHR up -> one recovered alert
  st2.recordPassive('PM', true);
  assert.strictEqual(st2.overall(), 'degraded');
  st2.recordProbe('EHR', true);
  await st2.flush();
  assert.strictEqual(st2.overall(), 'up');
  assert.strictEqual(sent.length, 3);
  assert.ok(/RECOVERED after \d+ min/.test(sent[2].subject) && sent[2].text.includes('while the system was down: 2'), sent[2].subject);
  assert.ok(events.includes('system_recovered:RECOVERED') && events.includes('helpdesk_alert:RECOVERED'));
  assert.strictEqual(st2.noteMessageTaken(), 0, 'no outage, nothing counted');
  // A failed send is retried at the next check after 5 minutes, then sent once
  failNext = 1;
  for (const t of ['PM', 'EHR']) for (let i = 0; i < 2; i++) st2.recordProbe(t, false, 'NETWORK_ERROR', 'GetToken: unreachable');
  await st2.flush();
  assert.strictEqual(sent.length, 3);
  assert.ok(events.includes('helpdesk_alert_failed:ECONNREFUSED'), events.join(','));
  await st2.tick();
  await st2.flush();
  assert.strictEqual(sent.length, 3, 'no retry within 5 minutes');
  now += 5 * 60_000;
  await st2.tick();
  await st2.flush();
  assert.strictEqual(sent.length, 4, 'retried after 5 minutes');
  // No PHI shape in any alert: no digits that look like a DOB, no patient words
  for (const m of sent) assert.ok(!/\d{1,2}\/\d{1,2}\/\d{4}|patientId|DOB/i.test(m.text + JSON.stringify(m.json)), m.text);
  assert.strictEqual(st2.agentStatus(), 'DOWN');
  const banner = statusBanner(st2);
  assert.ok(banner.includes('SYSTEM STATUS') && banner.includes('Veradigm® PM: DOWN since') && !/Unity/.test(banner), banner);
  assert.ok(statusCard(st2, true).includes('Status history'));
  ok('system status: DOWN after 2 failed probes, degraded/down/up, one down alert, 4-hour reminder, one recovered alert, messages counted, failed send retried after 5 min, restart-safe, no PHI, staff banner');

  // ── 2. Transports ──────────────────────────────────────────────────────────
  const got: Array<{ sig: string; body: string }> = [];
  const hookServer = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got.push({ sig: String(req.headers['x-drawbridge-signature'] || ''), body: b });
      res.statusCode = got.length === 1 ? 200 : 500;
      res.end();
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', () => r()));
  const hookUrl = `http://127.0.0.1:${(hookServer.address() as net.AddressInfo).port}/hook`;
  const hook = helpdesk.webhookTransport(hookUrl, 'hook-secret');
  const msg = helpdesk.buildAlert({ kind: 'down', system: 'Veradigm Unity (Veradigm EHR/PM)', overall: 'down', since: new Date(now).toISOString(), components: [], messages_taken: 0, at: new Date(now).toISOString() });
  await hook.send(msg);
  assert.strictEqual(got[0].sig, `sha256=${createHmac('sha256', 'hook-secret').update(got[0].body).digest('hex')}`);
  assert.strictEqual(JSON.parse(got[0].body).event, 'system_down');
  assert.strictEqual(JSON.parse(got[0].body).phi, false);
  await assert.rejects(hook.send(msg), /HTTP 500/);
  hookServer.close();
  // SMTP: a server without STARTTLS gets nothing (requireTLS on smtp://)
  const smtpLines: string[] = [];
  const smtpServer = net.createServer((s) => {
    s.write('220 fake ESMTP\r\n');
    s.on('data', (d) => {
      for (const line of String(d).split('\r\n').filter(Boolean)) {
        smtpLines.push(line);
        if (/^EHLO/i.test(line)) s.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^HELO/i.test(line)) s.write('250 fake\r\n');
        else if (/^QUIT/i.test(line)) s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((r) => smtpServer.listen(0, '127.0.0.1', () => r()));
  const smtpPort = (smtpServer.address() as net.AddressInfo).port;
  const smtp = helpdesk.smtpTransport(`smtp://alerts:pw@127.0.0.1:${smtpPort}`, ['help@moatit.com'], 'drawbridge-alerts@moatit.com');
  await assert.rejects(smtp.send(msg));
  assert.ok(!smtpLines.some((l) => /^(AUTH|MAIL FROM|DATA)/i.test(l)), `no credentials or mail in clear text: ${smtpLines.join(' | ')}`);
  smtpServer.close();
  process.env.HELPDESK_SMTP_URL = `smtps://alerts:pw@127.0.0.1:${smtpPort}`;
  process.env.HELPDESK_WEBHOOK_URL = 'http://example.com/hook';
  const ts = helpdesk.transportsFromEnv();
  assert.deepStrictEqual(ts.map((t) => t.name), ['smtp'], 'non-https webhook ignored');
  process.env.HELPDESK_WEBHOOK_URL = 'https://tickets.example.com/hook';
  assert.deepStrictEqual(helpdesk.transportsFromEnv().map((t) => t.name), ['smtp', 'webhook']);
  assert.deepStrictEqual(helpdesk.helpdeskSummary(), { transports: ['e-mail', 'webhook'], to: 'help@moatit.com' });
  delete process.env.HELPDESK_SMTP_URL;
  delete process.env.HELPDESK_WEBHOOK_URL;
  const none = await new helpdesk.HelpdeskNotifier(() => []).send({ kind: 'down', system: 's', overall: 'down', since: '', components: [], messages_taken: 0, at: '' });
  assert.deepStrictEqual(none, { ok: false, sent: [], failed: [{ transport: 'none', code: 'NO_TRANSPORT' }] });
  ok('help desk: webhook JSON with HMAC signature, HTTP errors are failures, SMTP never sends without TLS, https-only webhook, nothing configured = NO_TRANSPORT');

  // ── 3. Health checker ──────────────────────────────────────────────────────
  assert.deepStrictEqual(health.classifyProbeError('GetToken', new Error('Unity authentication failed: Access is denied')), { error_class: 'AUTH_ERROR', detail: 'GetToken: Access is denied' });
  assert.strictEqual(health.classifyProbeError('GetServerInfo', Object.assign(new Error('x'), { code: 'TIMEOUT_ERROR' })).error_class, 'TIMEOUT_ERROR');
  assert.strictEqual(health.classifyProbeError('GetToken', new Error('connect ECONNREFUSED 10.0.0.1:443')).error_class, 'NETWORK_ERROR');
  assert.ok(!health.classifyProbeError('GetToken', new Error('Unity authentication failed: bad user VHCP001PM:PMGA02^8^svcuser')).detail.includes('svcuser'), 'service account masked');
  assert.strictEqual(health.healthIntervalMs({ UNITY_HEALTH_CHECK_MIN: '1' } as any), 120_000, '2-minute floor');
  assert.strictEqual(health.healthIntervalMs({ UNITY_HEALTH_CHECK_MIN: '5' } as any), 300_000);
  assert.strictEqual(health.healthIntervalMs({ UNITY_HEALTH_CHECK_MIN: 'off' } as any), 0);
  assert.strictEqual(health.healthIntervalMs({ UNITY_HEALTH_CHECK_MIN: '0.5' } as any), 120_000, 'fractions below 2 are raised to the floor');
  assert.strictEqual(health.healthIntervalMs({} as any), 900_000, 'default every 15 minutes');
  assert.strictEqual(health.healthIntervalMs({ UNITY_HEALTH_CHECK_MIN: 'abc' } as any), 900_000, 'unreadable value: the default');
  let hnow = 1_000_000;
  const hst = new SystemStatus({ targets: () => ['EHR'], notifier: new helpdesk.HelpdeskNotifier(() => [fakeTransport]), now: () => hnow, dir: '', log: () => undefined, event: () => undefined });
  let mode: 'deny' | 'ok' | 'hang' = 'deny';
  const actions: string[] = [];
  const checker = new health.UnityHealthChecker({
    auth: {
      getSecurityToken: async () => {
        if (mode === 'deny') throw new Error('Unity authentication failed: Access is denied');
        if (mode === 'hang') return new Promise<string>(() => undefined);
        return 'tok';
      },
      getAuthenticatedSession: async () => ({}),
    },
    unity: { executeAction: async (a: string) => (actions.push(a), { success: true, data: [] }) },
    status: hst,
    targets: () => ['EHR'],
    now: () => hnow,
    log: () => undefined,
  });
  const r1 = await quiet(() => checker.runOnce());
  assert.deepStrictEqual([r1[0].ok, r1[0].error_class, r1[0].detail], [false, 'AUTH_ERROR', 'GetToken: Access is denied']);
  assert.strictEqual(checker.requestEarlyProbe(), false, 'no early probe within 2 minutes');
  hnow += 120_000;
  assert.strictEqual(checker.requestEarlyProbe(), true);
  await quiet(() => checker.runOnce());
  assert.strictEqual(hst.overall(), 'down');
  mode = 'hang';
  process.env.UNITY_HEALTH_TIMEOUT_SEC = '2';
  hnow += 120_000;
  const r3 = await quiet(() => checker.runOnce());
  assert.deepStrictEqual([r3[0].error_class, r3[0].detail.startsWith('GetToken:')], ['TIMEOUT_ERROR', true], JSON.stringify(r3));
  delete process.env.UNITY_HEALTH_TIMEOUT_SEC;
  mode = 'ok';
  hnow += 120_000;
  const r4 = await quiet(() => checker.runOnce());
  assert.ok(r4[0].ok && actions.includes('GetServerInfo'), 'cheap read GetServerInfo');
  assert.strictEqual(hst.overall(), 'up');
  // passive: an infrastructure failure asks for an early probe; validation answers count as "answering"
  checker.onActionOutcome('GetPatient', 'EHR', true, 'UNITY_ANSWERED');
  checker.onActionOutcome('GetPatient', 'PM', false, 'TIMEOUT_ERROR'); // PM not configured: ignored
  // Floor guard in runOnce itself (interval tick, start-up, early probe): never within 2 minutes of the last
  // probe or of a real call that got an answer.
  const t4 = hnow;
  const probesBefore = actions.length;
  hnow = t4 + 30_000;
  assert.deepStrictEqual(await quiet(() => checker.runOnce()), [], 'probe 30 s after the last one: skipped');
  hnow = t4 + 100_000;
  checker.onActionOutcome('GetSchedule', 'EHR', true, '');
  hnow = t4 + 150_000;
  assert.deepStrictEqual(await quiet(() => checker.runOnce()), [], '2.5 min after the probe but 50 s after a real answer: skipped');
  assert.strictEqual(actions.length, probesBefore, 'nothing sent to Veradigm by the skipped probes');
  hnow = t4 + 220_000;
  const r5 = await quiet(() => checker.runOnce());
  assert.ok(r5.length === 1 && r5[0].ok && actions.length === probesBefore + 1, 'probe again once 2 minutes passed');
  checker.onActionOutcome('GetPatient', 'EHR', false, 'TIMEOUT_ERROR');
  assert.strictEqual(actions.length, probesBefore + 1, 'a failed real call 10 s later does not probe early');
  // Start-up: the first probe waits for the start-up GetServerInfo and skips a system that just answered.
  const startActions: string[] = [];
  const starter = new health.UnityHealthChecker({
    auth: { getSecurityToken: async () => 'tok', getAuthenticatedSession: async () => ({}) },
    unity: { executeAction: async (a: string) => (startActions.push(a), { success: true, data: [] }) },
    status: hst,
    targets: () => ['EHR'],
    now: () => hnow,
    log: () => undefined,
  });
  let firstCheckDone!: () => void;
  const stopStarter = starter.start(new Promise<void>((r) => (firstCheckDone = r)));
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(startActions.length, 0, 'no probe before the start-up GetServerInfo is done');
  starter.onActionOutcome('GetServerInfo', 'EHR', true, '');
  firstCheckDone();
  await new Promise((r) => setTimeout(r, 20));
  stopStarter();
  assert.strictEqual(startActions.length, 0, 'start-up: one GetServerInfo per system, not two');
  ok('health checker: GetToken "Access is denied" -> AUTH_ERROR, timeout, network, service account masked, default 15 min with a 2-minute floor, early probe, floor guard per system (last probe or real answer), start-up probe after GetServerInfo, GetServerInfo read, DOWN then UP');

  // ── 4. Keep-warm ───────────────────────────────────────────────────────────
  let know = 1_000_000;
  const left: Record<string, number | undefined> = { PM: 500, EHR: 60 };
  const refreshed: string[] = [];
  const kw = new health.TokenKeepWarm(
    { tokenSecondsLeft: (t) => left[t], refreshSession: async (t) => (refreshed.push(t), true), getAuthenticatedSession: async () => ({}) },
    () => ['PM', 'EHR'],
    { now: () => know, log: () => undefined }
  );
  assert.strictEqual(await kw.tick(), 0, 'no activity, no refresh');
  kw.noteActivity();
  assert.strictEqual(await kw.tick(), 1);
  assert.deepStrictEqual(refreshed, ['EHR'], 'only the token due within 120 s');
  left.PM = undefined;
  await kw.tick();
  assert.deepStrictEqual(refreshed, ['EHR', 'PM', 'EHR'], 'a missing token is fetched while active');
  know += 31 * 60_000;
  assert.strictEqual(await kw.tick(), 0, 'idle for 30+ minutes: tokens left to expire');
  // Backoff: a missing token whose renewal keeps failing is retried after 2, 4, 8, 16, then every 30 minutes
  // (ticks are every 30 s), and a success resets it.
  let bnow = 5_000_000;
  let failing = true;
  let haveToken = false;
  const tries: number[] = [];
  const kwb = new health.TokenKeepWarm(
    {
      tokenSecondsLeft: () => (haveToken ? 600 : undefined),
      refreshSession: async () => {
        tries.push(bnow);
        if (failing) throw new Error('Unity authentication failed: connect ECONNREFUSED');
        return (haveToken = true);
      },
      getAuthenticatedSession: async () => ({}),
    },
    () => ['EHR'],
    { now: () => bnow, log: () => undefined }
  );
  const tickFor = async (minutes: number) => {
    for (let i = 0; i < minutes * 2; i++) {
      bnow += 30_000;
      kwb.noteActivity();
      await kwb.tick();
    }
  };
  kwb.noteActivity();
  await kwb.tick();
  await tickFor(65);
  assert.deepStrictEqual(tries.slice(1).map((t, i) => (t - tries[i]) / 60_000), [2, 4, 8, 16, 30], 'backoff 2, 4, 8, 16, 30 minutes');
  failing = false;
  await tickFor(30);
  assert.strictEqual(kwb.refreshed, 1, 'renewed once the backoff ran out');
  assert.strictEqual((tries[tries.length - 1] - tries[0]) / 60_000, 90, 'the success came at the 90-minute try');
  failing = true;
  haveToken = false;
  const n = tries.length;
  const flipAt = bnow;
  await tickFor(3);
  assert.strictEqual(tries[n], flipAt + 30_000, 'token missing again: tried at the next tick');
  assert.strictEqual(tries.length, n + 2, 'success reset the backoff: next try 2 minutes later (not 30, not every tick)');
  ok('keep-warm: renews a token due within 120 s (or missing) only while a call was active in the last 30 min; failed renewals back off 2 to 30 minutes, reset on success');

  // ── 5. Agent edge + wording ────────────────────────────────────────────────
  assert.ok(edge.needsVeradigm('unity_search_patients') && edge.needsVeradigm('drawbridge_previsit_check') && !edge.needsVeradigm('drawbridge_take_message') && !edge.needsVeradigm('drawbridge_get_call_mode'));
  const down = toVoiceSummary('unity_get_patient_appointments', edge.recordsUnavailable('unity_get_patient_appointments'));
  assert.ok(down.startsWith('TOOL_ERROR (RECORDS_UNAVAILABLE') && down.includes("can't reach our records system") && down.includes('drawbridge_take_message'), down);
  const args = { firstName: 'Teodoro', lastName: 'Brightwater', dateOfBirth: '02/17/1949' };
  const match = { patients: [{ firstName: 'Teodoro', lastName: 'Brightwater', dateOfBirth: '02/17/1949', patientId: '51389', chartPatientId: '81069' }], total: 1, message: 'Found 1' };
  const appts = { appointments: [1, 2, 3, 4].map((i) => ({ id: `90${i}`, date: `10/2${i}/2026`, time: '9:00 AM', providerName: 'Lee, Andrew', appointmentType: 'Follow Up', status: 'Scheduled', patientId: '51389', notes: 'secret note', locationName: 'Boise' })), total: 4 };
  const asked: string[] = [];
  const withVisits = await edge.attachUpcomingVisits(args, match, async (pid) => (asked.push(pid), appts), 1000);
  assert.deepStrictEqual(asked, ['51389']);
  assert.strictEqual(withVisits.upcomingVisits.length, 3);
  assert.strictEqual(withVisits.upcomingTotal, 4);
  assert.ok(!JSON.stringify(withVisits.upcomingVisits).includes('secret note') && !('patientId' in withVisits.upcomingVisits[0]), 'minimum necessary fields only');
  const spoken = toVoiceSummary('unity_search_patients', withVisits);
  assert.ok(spoken.includes('Upcoming visits (4, soonest first): 10/21/2026 9:00 AM with Lee, Andrew') && spoken.includes('[appointmentId 901]'), spoken);
  assert.strictEqual(await edge.attachUpcomingVisits(args, { ...match, note: 'Matched on a spelling variant' }, async () => appts, 1000).then((r: any) => r.upcomingVisits), undefined, 'not before the caller confirms a spelling variant');
  assert.strictEqual(await edge.attachUpcomingVisits({ lastName: 'Brightwater', firstName: 'Teodoro' }, match, async () => appts, 1000).then((r: any) => r.upcomingVisits), undefined, 'not without a date of birth');
  assert.strictEqual(await edge.attachUpcomingVisits(args, { ...match, patients: [...match.patients, ...match.patients], total: 2 }, async () => appts, 1000).then((r: any) => r.upcomingVisits), undefined, 'not with two matches');
  const slow = await edge.attachUpcomingVisits(args, match, () => new Promise((r) => setTimeout(() => r(appts), 300)), 50);
  assert.strictEqual(slow.upcomingVisits, undefined, 'late: left out, never "none"');
  const failed = await edge.attachUpcomingVisits(args, match, async () => ({ success: false, error_code: 'TIMEOUT_ERROR' }), 1000);
  assert.strictEqual(failed.upcomingVisits, undefined, 'failed: left out, never "none"');
  const noneVisits = await edge.attachUpcomingVisits(args, match, async () => ({ appointments: [], total: 0 }), 1000);
  assert.ok(toVoiceSummary('unity_search_patients', noneVisits).includes('Upcoming visits: SUCCESS, none scheduled'));
  assert.strictEqual(edge.visitsBudgetMs({ UNITY_SEARCH_VISITS_BUDGET_MS: '0' } as any), 0);
  // Coordinator bug 1: a successful empty answer must not read like a failure
  const empty = toVoiceSummary('unity_get_patient_appointments', { appointments: [], total: 0 });
  assert.ok(empty.startsWith('SUCCESS:') && /not an error/.test(empty) && !/TOOL_ERROR|trouble/.test(empty), empty);
  assert.ok(toVoiceSummary('unity_get_open_slots', { slots: [], total: 0 }).startsWith('SUCCESS:'));
  assert.ok(toVoiceSummary('unity_get_patient_allergies', { success: true, allergies: [] }).startsWith('SUCCESS: no allergies on file.'));
  assert.ok(toVoiceSummary('unity_search_patients', { patients: [], total: 0, message: 'No patient matched that name and date of birth.' }).startsWith('NO MATCH (the search worked; not an error)'));
  const slots = toVoiceSummary('unity_get_open_slots', { slots: [{ date: '10/19/2026', time: '9:00 AM', duration: 15, providerId: '7', providerName: 'Lee, Andrew', locationId: '3', departmentId: '12' }], total: 1 });
  assert.ok(slots.includes('[providerId 7, locationId 3, departmentId 12]') && slots.includes('pass the providerId, locationId and departmentId'), slots);
  ok('agent edge: RECORDS_UNAVAILABLE text, upcoming visits only for one verified match (max 3, minimum fields, budget, never on failure), "SUCCESS:" empty answers, NO MATCH wording, slot IDs for booking');

  // ── 6. Inbound webhook ─────────────────────────────────────────────────────
  const body = JSON.stringify({ event: 'call_inbound', call_inbound: { call_id: 'call_abc', from_number: '+12085550101', to_number: '+12089043641' } });
  const key = 'key_test_retell';
  const t = Date.now();
  const sig = `v=${t},d=${createHmac('sha256', key).update(body + t).digest('hex')}`;
  assert.ok(inbound.verifyRetellSignature(body, key, sig, t));
  assert.ok(!inbound.verifyRetellSignature(body + ' ', key, sig, t), 'tampered body');
  assert.ok(!inbound.verifyRetellSignature(body, key, sig, t + 6 * 60_000), 'old timestamp');
  assert.ok(!inbound.verifyRetellSignature(body, 'other', sig, t));
  assert.strictEqual(inbound.verifyInbound(body, {}).status, 503, 'closed when unconfigured');
  process.env.RETELL_API_KEY = key;
  assert.ok(inbound.verifyInbound(body, { 'x-retell-signature': sig }).ok);
  assert.strictEqual(inbound.verifyInbound(body, { 'x-retell-signature': 'v=1,d=00' }).status, 401);
  setSystemStatus(st2);
  const out = inbound.inboundResponse(JSON.parse(body)) as any;
  assert.strictEqual(out.status, 200);
  const vars = out.json.call_inbound.dynamic_variables;
  assert.ok(['BUSINESS_HOURS', 'AFTER_HOURS'].includes(vars.call_mode) && vars.records_status === 'DOWN' && vars.fhir_tools === 'OFF', JSON.stringify(vars));
  assert.ok(!JSON.stringify(out.json).includes('2085550101'), 'no caller number in the answer');
  assert.strictEqual(inbound.inboundResponse({ event: 'call_started' }).status, 204);
  // End to end over HTTP
  const express = (await import('express')).default;
  const app = express();
  let warmed = 0;
  inbound.mountRetellInbound(app, () => warmed++);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/webhooks/retell-inbound`;
  const res = await quiet(() => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-retell-signature': sig }, body }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(((await res.json()) as any).call_inbound.dynamic_variables.records_status, 'DOWN');
  assert.strictEqual(warmed, 1, 'call start warms the Veradigm sessions');
  const bad = await quiet(() => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-retell-signature': sig }, body: body.replace('abc', 'xyz') }));
  assert.strictEqual(bad.status, 401);
  // Live failure Oct 15: Retell signs with the webhook-badged key, not RETELL_API_KEY. RETELL_WEBHOOK_API_KEY wins.
  process.env.RETELL_API_KEY = 'key_test_api_calls_only';
  const rejected = await quiet(() => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-retell-signature': sig }, body }));
  assert.strictEqual(rejected.status, 401, 'signed with another key than RETELL_API_KEY: 401');
  process.env.RETELL_WEBHOOK_API_KEY = key;
  const accepted = await quiet(() => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-retell-signature': sig }, body }));
  assert.strictEqual(accepted.status, 200, 'RETELL_WEBHOOK_API_KEY verifies');
  srv.close();
  delete process.env.RETELL_API_KEY;
  delete process.env.RETELL_WEBHOOK_API_KEY;
  ok('inbound-call webhook: Retell signature (HMAC over body+timestamp, 5-minute window) with RETELL_WEBHOOK_API_KEY else RETELL_API_KEY, 503 unconfigured, 401 tampered, call_mode/records_status/fhir_tools variables, no caller number, warms sessions');

  // ── 7. drawbridge_take_message ─────────────────────────────────────────────
  const tools = new OnCallTools();
  const before = st2.snapshot().outage?.messages_taken || 0;
  const saved = tools.takeMessage({ callerName: 'Teodoro Brightwater', dateOfBirth: '02/17/1949', callbackPhone: '208-555-0103', message: 'Please call me about my prescription.', urgency: 'routine' }, 'call_msg_1', '+12085550103');
  assert.ok(saved.success && saved.message.startsWith('SUCCESS'));
  const rec = callRecords.get('call_msg_1')!;
  assert.deepStrictEqual([rec.kind, rec.verified, rec.records_down, rec.caller_stated?.name, rec.patient_name], ['message', false, true, 'Teodoro Brightwater', '']);
  assert.strictEqual(st2.snapshot().outage?.messages_taken, before + 1, 'counted for the help-desk alert');
  assert.throws(() => tools.takeMessage({ callerName: 'x', callbackPhone: '1', message: ' ' }, 'call_msg_2'), /message is required/);
  assert.ok(tools.getCallMode().message.includes('Records system: DOWN'));
  setSystemStatus(null);
  ok('take_message: Drawbridge call record (kind message, identity as stated and unverified), counted while records are down, message required');

  // ── 8. First-name spelling variant ─────────────────────────────────────────
  const row = { ID: '51389', lastname: 'Brightwater', firstname: 'Teodoro', dateofbirth: '02/17/1949', MRN: '17806' };
  const searchUnity = {
    searchPatients: async (c: any) => {
      const first = String(c.firstName || '').toLowerCase();
      const last = String(c.lastName || '').toLowerCase();
      const hit = 'brightwater'.startsWith(last) && (!first || 'teodoro'.startsWith(first));
      return { success: true, data: [{ searchpatientsinfo: hit ? [row] : [] }] };
    },
  };
  const variant = await quiet(() => new UnityPatientTools(searchUnity as any).searchPatients({ firstName: 'Theodoro', lastName: 'Brightwater', dateOfBirth: '02/17/1949' }));
  assert.strictEqual(variant.patients.length, 1);
  assert.ok(variant.note?.includes('T-E-O-D-O-R-O') && /get a yes/.test(variant.note || ''), variant.note);
  const wrongDob = await quiet(() => new UnityPatientTools(searchUnity as any).searchPatients({ firstName: 'Theodoro', lastName: 'Brightwater', dateOfBirth: '02/18/1949' }));
  assert.strictEqual(wrongDob.patients.length, 0, 'exact DOB still required');
  const unlike = await quiet(() => new UnityPatientTools(searchUnity as any).searchPatients({ firstName: 'Marcus', lastName: 'Brightwater', dateOfBirth: '02/17/1949' }));
  assert.strictEqual(unlike.patients.length, 0, 'a different first name is not a variant');
  ok('search: "Theodoro" heard finds Teodoro (same DOB, same last name, sounds alike) as a spelling variant that needs a yes; wrong DOB or another name finds nobody');

  // ── 9. Tool list and prompt ────────────────────────────────────────────────
  const { UnityAuthService } = await import('../unity/services/unity-auth.service');
  const { UnityService } = await import('../unity/services/unity.service');
  const { UnityAppointmentTools } = await import('../unity/tools/appointment.tools');
  const { UnityClinicalTools } = await import('../unity/tools/clinical.tools');
  const { UnityBillingTools } = await import('../unity/tools/billing.tools');
  const { UnityTaskTools } = await import('../unity/tools/task.tools');
  const { loadPlatformModules } = await import('../platform/modules');
  const { platformTools } = await import('../platform/registry');
  const { FHIRService } = await import('../services/fhir.service');
  const { AuthService } = await import('../services/auth.service');
  const { PatientTools } = await import('../tools/patient.tools');
  const { MedicationTools } = await import('../tools/medication.tools');
  const { ClinicalTools } = await import('../tools/clinical.tools');
  const u = new UnityService(new UnityAuthService());
  loadPlatformModules();
  const f = new FHIRService(new AuthService());
  const defs = {
    unity: [...new UnityAppointmentTools(u).getTools(), ...new UnityPatientTools(u).getTools(), ...new UnityClinicalTools(u).getTools(), ...new UnityBillingTools(u).getTools(), ...new UnityTaskTools(u).getTools(), ...platformTools()],
    fhir: [...new PatientTools(f).getTools(), ...new MedicationTools(f).getTools(), ...new ClinicalTools(f).getTools()],
  } as any;
  const compact = compactAgentTools(defs);
  const toolChars = compact.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length, 0);
  const prompt = fs.readFileSync(path.join(__dirname, '..', '..', 'retell-prompts', 'unity-healthcare-agent.md'), 'utf8');
  const approxTokens = Math.round((toolChars + prompt.length) / 4);
  assert.ok(approxTokens <= 4200, `prompt + tools about ${approxTokens} tokens`);
  assert.strictEqual(compact.length, Object.keys(AGENT_TOOLS).length);
  for (const n of ['verify_patient_identity', 'get_allergies', 'check_refill_status', 'drawbridge_take_message', 'drawbridge_get_call_mode']) assert.ok(compact.some((t) => t.name === n), `${n} kept`);
  for (const n of ['unity_search_patients', 'unity_get_patient_appointments', 'unity_get_open_slots', 'unity_get_account_balance']) assert.ok(compact.find((t) => t.name === n)!.filler, `${n} has a filler`);
  assert.deepStrictEqual(Object.keys(compact.find((t) => t.name === 'unity_save_appointment')!.parameters.properties).slice(4, 7), ['providerId', 'locationId', 'departmentId']);
  assert.throws(() => compactAgentTools({ unity: [], fhir: [] }), /not defined/);
  for (const line of [
    'If this is an emergency, please hang up and call 911 now.',
    "I can't give medical advice, but I can connect you with our staff or send them a message.",
    'full name AND date of birth',
    'Read back before every change',
    'providerId, locationId and departmentId',
    '{{call_mode}}',
    '{{records_status}}',
    '{{current_time_America/Boise}}',
    'T-E-O-D-O-R-O',
    'After two searches without a match, stop guessing',
    'It is NOT an error',
    'web_call',
    'never as a fallback',
    '"NOT BOOKED" = nothing was saved',
    'Never pick a type just to get the booking through',
  ]) {
    assert.ok(prompt.includes(line), `prompt keeps: ${line}`);
  }
  assert.ok(!/try the matching FHIR tool|backup: get_/i.test(prompt), 'no "fall back to FHIR" instruction');
  ok(`agent tools + prompt: ${compact.length} tools, about ${approxTokens} tokens with the prompt (v6 about 6,400), fillers on lookups, FHIR tools kept but gated, safety lines and coordinator fixes in the prompt`);

  console.log(`\n${passed} voice checks passed.`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
