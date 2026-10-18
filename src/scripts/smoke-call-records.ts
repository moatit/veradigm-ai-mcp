/**
 * Offline checks for call analytics records (no network beyond 127.0.0.1, no credentials, synthetic data).
 * The record is allow-listed (no transcript, summary, free text or phone number in any form), enums are
 * enforced, repeat-caller counts stay in the stack, tools come from the audit log, and the forwarder
 * queues, retries, drops invalid records and sends nothing when it is off.
 *
 *   npm run smoke:call-records
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-call-records-'));
process.env.AUDIT_DIR = TMP;
process.env.CALL_RECORDS_DIR = TMP;
process.env.CLINIC_TIMEZONE = 'America/Boise';
process.env.DRAWBRIDGE_PRACTICE_ID = 'sagebrush-kidney';
process.env.RETELL_WEBHOOK_SECRET = 'smoke-secret-not-real';
delete process.env.RETELL_API_KEY;
delete process.env.RETELL_WEBHOOK_API_KEY;
delete process.env.CALL_ANALYTICS_FORWARD;
delete process.env.CALL_ANALYTICS_HASH_KEY;

import assert from 'assert';
import type { AddressInfo } from 'net';

const NUMBER = '+12085550142';
const T0 = Date.parse('2026-10-14T16:00:00Z');

function analyzedCall(id: string, over: Record<string, unknown> = {}, custom: Record<string, unknown> = {}): any {
  return {
    call_id: id,
    agent_id: 'agent_synthetic01',
    agent_version: 7,
    call_type: 'phone_call',
    direction: 'inbound',
    from_number: NUMBER,
    to_number: '+12085550100',
    start_timestamp: T0,
    end_timestamp: T0 + 185_400,
    duration_ms: 185_400,
    disconnection_reason: 'user_hangup',
    transcript: 'Agent: Hello. User: This is Zelda Quixote, born 1950-02-03, I have chest pain.',
    transcript_object: [{ role: 'user', content: 'Zelda Quixote chest pain' }],
    recording_url: 'https://example.invalid/rec.wav',
    retell_llm_dynamic_variables: { patient_name: 'Zelda Quixote' },
    call_analysis: {
      call_summary: 'Zelda Quixote called about chest pain and a refill of lisinopril.',
      user_sentiment: 'Negative',
      call_successful: true,
      in_voicemail: false,
      custom_analysis_data: {
        call_reason: 'prescription_refill',
        request_category: 'action_request',
        resolved: true,
        transferred_to_staff: false,
        caller_notes: 'Zelda wants lisinopril 20mg',
        ...custom,
      },
    },
    ...over,
  };
}

const ALLOWED_KEYS = [
  'schema', 'call_id', 'practice_id', 'agent_id', 'agent_version', 'started_at', 'duration_s', 'direction',
  'disconnection_reason', 'analyzed', 'call_reason', 'request_category', 'resolved', 'transferred_to_staff',
  'caller_sentiment', 'call_successful', 'in_voicemail', 'prior_calls_24h', 'prior_calls_7d', 'tools',
].sort();

function assertNoPhi(text: string, label: string): void {
  for (const bad of ['Zelda', 'Quixote', '1950', 'chest', 'lisinopril', 'transcript', 'summary', 'recording', '5550142', '0142', '2085550', 'patient_name']) {
    assert.ok(!text.includes(bad), `${label} leaks "${bad}"`);
  }
}

async function main(): Promise<void> {
  const audit = await import('../platform/audit');
  const ca = await import('../platform/modules/activity/call-analytics');
  const fw = await import('../platform/modules/activity/call-forwarder');
  const { mountRetellWebhook } = await import('../platform/modules/activity');
  const express = (await import('express')).default;

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // Synthetic tool calls on the call, plus one on another call and one staff view
  audit.auditToolCall({ server: 'unity', tool: 'unity_get_patient_appointments', args: { patientId: '56500' }, callId: 'call_syn001', success: true, latencyMs: 300, channel: 'retell' });
  audit.auditToolCall({ server: 'unity', tool: 'unity_get_patient_appointments', args: { patientId: '56500' }, callId: 'call_syn001', success: false, errorCode: 'TIMEOUT_ERROR', latencyMs: 9000, channel: 'retell' });
  audit.auditToolCall({ server: 'unity', tool: 'drawbridge_create_staff_task', callId: 'call_syn001', success: true, latencyMs: 120, channel: 'retell' });
  audit.auditToolCall({ server: 'fhir', tool: 'search_patient', callId: 'call_other', success: true, latencyMs: 80, channel: 'retell' });
  await audit.flushAudit();

  // 1. Allow-listed record: no transcript, summary, free text, numbers or patient IDs
  const r = await ca.buildCallRecord('call_analyzed', analyzedCall('call_syn001'));
  assert.ok(r);
  assert.deepStrictEqual(Object.keys(r!).sort(), ALLOWED_KEYS);
  const json = JSON.stringify(r);
  assertNoPhi(json, 'record');
  assert.ok(!json.includes('56500'), 'no patient ID');
  assert.strictEqual(r!.practice_id, 'sagebrush-kidney');
  assert.strictEqual(r!.started_at, '2026-10-14T16:00:00.000Z');
  assert.strictEqual(r!.duration_s, 185);
  assert.strictEqual(r!.direction, 'inbound');
  assert.strictEqual(r!.agent_version, 7);
  assert.deepStrictEqual(
    [r!.call_reason, r!.request_category, r!.resolved, r!.transferred_to_staff, r!.caller_sentiment, r!.call_successful, r!.in_voicemail],
    ['prescription_refill', 'action_request', true, false, 'negative', true, false]
  );
  ok('record holds only allow-listed fields: no transcript, summary, free text, phone number or patient ID');

  // 2. Tools from the audit log, this call only
  assert.deepStrictEqual(r!.tools, [
    { name: 'unity_get_patient_appointments', calls: 2, failed: 1 },
    { name: 'drawbridge_create_staff_task', calls: 1, failed: 0 },
  ]);
  ok('tools used on the call come from the audit log with calls and failures');

  // 3. Enums enforced
  const free = await ca.buildCallRecord('call_analyzed', analyzedCall('call_syn002', {}, { call_reason: 'Zelda has chest pain', request_category: 'URGENT', resolved: 'maybe' }));
  assert.strictEqual(free!.call_reason, 'other', 'free text becomes "other"');
  assert.strictEqual(free!.request_category, 'urgent', 'case-insensitive enum');
  assert.strictEqual(free!.resolved, null, 'non-boolean becomes null');
  assertNoPhi(JSON.stringify(free), 'enum-checked record');
  const odd = await ca.buildCallRecord('call_analyzed', analyzedCall('call_syn003', { call_analysis: { user_sentiment: 'Furious', custom_analysis_data: { call_reason: 'Appointment New' } } }));
  assert.strictEqual(odd!.caller_sentiment, null, 'sentiment outside the list is null (no "other")');
  assert.strictEqual(odd!.call_reason, 'appointment_new', 'spaces normalized');
  const xfer = await ca.buildCallRecord('call_analyzed', analyzedCall('call_syn004', { disconnection_reason: 'call_transfer' }, { transferred_to_staff: undefined }));
  assert.strictEqual(xfer!.transferred_to_staff, true, 'a platform transfer counts when the field is empty');
  ok('analysis values are fixed enums and booleans; anything else becomes "other" or null');

  // 4. call_ended before analysis: no analysis values
  const ended = await ca.buildCallRecord('call_ended', analyzedCall('call_syn005'));
  assert.strictEqual(ended!.analyzed, false);
  assert.deepStrictEqual([ended!.call_reason, ended!.caller_sentiment, ended!.resolved], [null, null, null]);
  assert.strictEqual(await ca.buildCallRecord('call_ended', { call_id: 'Zelda Quixote' }), null, 'non-ID call id rejected');
  ok('call_ended records carry no analysis until call_analyzed arrives');

  // 5. Repeat callers counted in the stack; only counts leave it
  fs.rmSync(path.join(TMP, 'caller-history.json'), { force: true });
  const at = (id: string, ms: number, over: Record<string, unknown> = {}) =>
    ca.buildCallRecord('call_analyzed', analyzedCall(id, { start_timestamp: ms, end_timestamp: ms + 60_000, duration_ms: 60_000, ...over }), new Date(ms + 120_000));
  const a1 = await at('call_rep1', T0);
  const a2 = await at('call_rep2', T0 + 2 * 3_600_000);
  const a2again = await at('call_rep2', T0 + 2 * 3_600_000);
  const a3 = await at('call_rep3', T0 + 30 * 3_600_000);
  const other = await at('call_rep4', T0 + 31 * 3_600_000, { from_number: '+12085550199' });
  const outbound = await at('call_rep5', T0 + 32 * 3_600_000, { direction: 'outbound' });
  const web = await at('call_rep6', T0 + 33 * 3_600_000, { call_type: 'web_call', direction: undefined, from_number: undefined });
  assert.deepStrictEqual([a1!.prior_calls_24h, a1!.prior_calls_7d], [0, 0]);
  assert.deepStrictEqual([a2!.prior_calls_24h, a2!.prior_calls_7d], [1, 1]);
  assert.deepStrictEqual([a2again!.prior_calls_24h, a2again!.prior_calls_7d], [1, 1], 'same call twice is not a repeat');
  assert.deepStrictEqual([a3!.prior_calls_24h, a3!.prior_calls_7d], [0, 2], 'outside 24 h, inside 7 days');
  assert.deepStrictEqual([other!.prior_calls_24h, other!.prior_calls_7d], [0, 0]);
  assert.deepStrictEqual([outbound!.prior_calls_24h, web!.prior_calls_24h, web!.direction], [null, null, 'web']);
  const hist = fs.readFileSync(path.join(TMP, 'caller-history.json'), 'utf8');
  assert.ok(!/5550142|5550199|2085550/.test(hist), 'history holds keyed hashes, not numbers');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(path.join(TMP, 'caller-history.json')).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.join(TMP, 'caller-history.key')).mode & 0o777, 0o600);
  }
  assert.strictEqual(ca.pruneCallerHistory(new Date(T0 + 40 * 86_400_000)), 4, 'history older than 8 days pruned');
  ok('repeat-caller counts computed in the stack from keyed hashes; no number or hash in the record');

  // 6. Forwarder: off by default; https only (http just for localhost)
  assert.strictEqual(fw.forwardConfig(), null, 'off without CALL_ANALYTICS_FORWARD');
  process.env.CALL_ANALYTICS_FORWARD = 'on';
  process.env.ADMIN_API_KEY = 'vdm_synthetic_smoke_key';
  process.env.ADMIN_PORTAL_URL = 'http://admin.example.test';
  assert.strictEqual(fw.forwardConfig(), null, 'plain http to a remote host refused');
  process.env.ADMIN_PORTAL_URL = 'http://admin:5001';
  assert.strictEqual(fw.forwardConfig()?.url, 'http://admin:5001/api/call-records', 'http to a container on the stack network');
  process.env.ADMIN_PORTAL_URL = 'https://admin.example.test/';
  assert.strictEqual(fw.forwardConfig()?.url, 'https://admin.example.test/api/call-records');
  delete process.env.CALL_ANALYTICS_FORWARD;
  await fw.forwardCallEvent('call_analyzed', analyzedCall('call_off'));
  assert.ok(!fs.existsSync(path.join(TMP, 'call-records-outbox.json')), 'nothing queued when off');
  ok('forwarding is off by default and needs https (http only to localhost or the stack network)');

  // 7. Stub admin app on 127.0.0.1: queue, retry on 5xx, drop on 400, idempotent per call
  const received: { key: string; body: any }[] = [];
  let mode: 'ok' | 'down' | 'bad' = 'down';
  const stub = express();
  stub.use(express.json());
  stub.post('/api/call-records', (req, res) => {
    if (mode === 'down') res.status(503).json({ error: 'down' });
    else if (mode === 'bad') res.status(400).json({ error: 'invalid' });
    else {
      received.push({ key: String(req.headers['x-api-key']), body: req.body });
      res.status(201).json({ success: true });
    }
  });
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = stub.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  process.env.CALL_ANALYTICS_FORWARD = 'on';
  process.env.ADMIN_PORTAL_URL = `http://127.0.0.1:${port}`;

  await fw.forwardCallEvent('call_ended', analyzedCall('call_fw1'));
  assert.strictEqual(received.length, 0);
  assert.strictEqual(fw.outboxSize(), 1, 'kept in the outbox while the admin app is down');
  await fw.forwardCallEvent('call_analyzed', analyzedCall('call_fw1'));
  assert.strictEqual(fw.outboxSize(), 1, 'a later event replaces the queued record for the same call');
  mode = 'ok';
  let res = await fw.flushOutbox(Date.now() + 10 * 60_000);
  assert.deepStrictEqual(res, { sent: 1, failed: 0, dropped: 0 });
  assert.strictEqual(fw.outboxSize(), 0);
  assert.strictEqual(received[0].key, 'vdm_synthetic_smoke_key');
  assert.strictEqual(received[0].body.analyzed, true, 'the newest snapshot was sent');
  assertNoPhi(JSON.stringify(received[0].body), 'forwarded body');
  mode = 'bad';
  await fw.forwardCallEvent('call_analyzed', analyzedCall('call_fw2'));
  assert.strictEqual(fw.outboxSize(), 0, 'a record the admin app rejects as invalid is dropped');
  const outboxText = fs.readFileSync(path.join(TMP, 'call-records-outbox.json'), 'utf8');
  assertNoPhi(outboxText, 'outbox');
  ok('forwarder: outbox survives an outage, retries, replaces per call, drops invalid records');

  // 8. End to end through the verified webhook
  mode = 'ok';
  received.length = 0;
  const app = express();
  mountRetellWebhook(app);
  const hook = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const hookPort = (hook.address() as AddressInfo).port;
  const post = (body: unknown, secret = 'smoke-secret-not-real') =>
    fetch(`http://127.0.0.1:${hookPort}/webhooks/retell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-drawbridge-webhook-secret': secret },
      body: JSON.stringify(body),
    });
  assert.strictEqual((await post({ event: 'call_analyzed', call: analyzedCall('call_e2e') }, 'wrong')).status, 401);
  assert.strictEqual((await post({ event: 'call_started', call: analyzedCall('call_e2e') })).status, 204);
  assert.strictEqual((await post({ event: 'call_analyzed', call: analyzedCall('call_e2e') })).status, 204);
  for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(received.length, 1, 'only call_ended / call_analyzed are forwarded; a rejected webhook sends nothing');
  assert.strictEqual(received[0].body.call_id, 'call_e2e');
  assert.strictEqual(received[0].body.call_reason, 'prescription_refill');
  assertNoPhi(JSON.stringify(received[0].body), 'webhook-forwarded body');
  const index = fs.readFileSync(path.join(TMP, 'calls.json'), 'utf8');
  assert.ok(index.includes('call_e2e'), 'calls index still updated');
  ok('verified webhook forwards one record off the request path; the calls index is unchanged');

  fw.stopForwarder();
  server.close();
  hook.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
