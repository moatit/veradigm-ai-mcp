/**
 * Offline checks for call analytics records (no network beyond 127.0.0.1, no credentials, synthetic data).
 * The record is allow-listed (no transcript, summary, free text or phone number in any form), carries a
 * keyed call reference instead of the vendor call ID and only the start hour, enums (including the
 * disconnection reason) are enforced, repeat-caller counts stay in the stack, tools come from the audit
 * log, private files are 0600 in 0700 directories, production needs the hash key and https (or an
 * explicit http host list), and the forwarder queues, retries, drops invalid records and sends nothing
 * when it is off.
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
delete process.env.CALL_ANALYTICS_HTTP_HOSTS;
process.env.NODE_ENV = 'test';

import assert from 'assert';
import type { AddressInfo } from 'net';

const NUMBER = '+12085550142';
const T0 = Date.parse('2026-10-14T16:00:00Z');

function analyzedCall(id: string, over: Record<string, unknown> = {}, custom: Record<string, unknown> = {}): any {
  return {
    call_id: id,
    agent_id: 'agent_5a1e5a1e5a1e5a1e5a1e5a1e5a',
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
  assert.ok(!json.includes('call_syn001'), 'the vendor call ID is not in the record');
  assert.match(r!.call_id, /^cr_[0-9a-f]{32}$/);
  assert.strictEqual(r!.call_id, ca.callRef('call_syn001'), 'the reference is stable per call');
  assert.notStrictEqual(ca.callRef('call_syn001'), ca.callRef('call_syn002'));
  assert.strictEqual(r!.practice_id, 'sagebrush-kidney');
  assert.strictEqual(r!.started_at, '2026-10-14T10:00:00-06:00', '16:00:00Z is the 10:00 hour in Boise (MDT)');
  assert.strictEqual(r!.duration_s, 185);
  assert.strictEqual(r!.direction, 'inbound');
  assert.strictEqual(r!.agent_version, 7);
  assert.deepStrictEqual(
    [r!.call_reason, r!.request_category, r!.resolved, r!.transferred_to_staff, r!.caller_sentiment, r!.call_successful, r!.in_voicemail],
    ['prescription_refill', 'action_request', true, false, 'negative', true, false]
  );
  ok('record holds only allow-listed fields: no vendor call ID, exact time, transcript, summary, free text, phone number or patient ID');

  // 1b. Start hour in clinic local time (M3), across offsets and DST
  assert.strictEqual(ca.hourStartLocal(Date.parse('2026-10-14T16:59:59.999Z'), 'America/Boise'), '2026-10-14T10:00:00-06:00');
  assert.strictEqual(ca.hourStartLocal(Date.parse('2026-12-01T16:30:00Z'), 'America/Boise'), '2026-12-01T09:00:00-07:00', 'MST in winter');
  assert.strictEqual(ca.hourStartLocal(Date.parse('2026-10-14T16:10:00Z'), 'Asia/Kolkata'), '2026-10-14T21:00:00+05:30', 'half-hour offset');
  assert.strictEqual(ca.hourStartLocal(Date.parse('2026-10-14T23:45:00Z'), 'UTC'), '2026-10-14T23:00:00+00:00');
  for (const v of ['2026-10-14T10:00:00-06:00', '2026-10-14T21:00:00+05:30']) {
    assert.ok(!Number.isNaN(Date.parse(v)), 'parses as a date');
  }
  assert.strictEqual(Date.parse('2026-10-14T10:00:00-06:00'), Date.parse('2026-10-14T16:00:00Z'), 'same instant as the UTC hour start');
  ok('start time is coarsened to the hour in clinic local time, with the offset');

  // 1c. Wire formats pinned to the admin schema
  assert.match(r!.call_id, /^cr_[0-9a-f]{32}$/);
  assert.match(r!.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00[+-]\d{2}:\d{2}$/);
  assert.strictEqual(r!.agent_id, 'agent_5a1e5a1e5a1e5a1e5a1e5a1e5a');
  for (const t of r!.tools) assert.match(t.name, /^[a-z][a-z0-9_]{0,48}$/);
  const oddAgent = await ca.buildCallRecord('call_analyzed', analyzedCall('call_syn007', { agent_id: 'Agent Zelda 2085550142' }));
  assert.strictEqual(oddAgent!.agent_id, '', 'an agent ID outside the vendor format is left empty');
  const shortAgent = await ca.buildCallRecord('call_analyzed', analyzedCall('call_syn008', { agent_id: 'agent_synthetic01' }));
  assert.strictEqual(shortAgent!.agent_id, '');
  audit.auditToolCall({ server: 'unity', tool: 'Weird.Tool:Name', callId: 'call_syn009', success: true, latencyMs: 1, channel: 'retell' });
  audit.auditToolCall({ server: 'unity', tool: 'unity_get_patient', callId: 'call_syn009', success: true, latencyMs: 1, channel: 'retell' });
  await audit.flushAudit();
  const toolRec = await ca.buildCallRecord('call_analyzed', analyzedCall('call_syn009'));
  assert.deepStrictEqual(toolRec!.tools.map((t) => t.name), ['unity_get_patient'], 'a tool name outside the registry format is left out');
  ok('wire formats match the admin schema: call reference, hour start, agent ID, tool names');

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
  assert.strictEqual(ca.disconnectionReason('user_hangup'), 'user_hangup');
  assert.strictEqual(ca.disconnectionReason('Call_Transfer'), 'call_transfer', 'case-insensitive');
  assert.strictEqual(ca.disconnectionReason('error_llm_websocket_open'), 'error_llm_websocket_open');
  assert.strictEqual(ca.disconnectionReason('error_new_thing_2027'), 'other', 'undocumented reason');
  assert.strictEqual(ca.disconnectionReason('Zelda hung up 5550142'), 'other', 'free text');
  assert.strictEqual(ca.disconnectionReason(''), '');
  assert.strictEqual(ca.disconnectionReason(42), '');
  const weird = await ca.buildCallRecord('call_analyzed', analyzedCall('call_syn006', { disconnection_reason: 'hangup_by_Zelda_0142' }));
  assert.strictEqual(weird!.disconnection_reason, 'other');
  assertNoPhi(JSON.stringify(weird), 'record with an odd disconnection reason');
  ok('analysis values are fixed enums and booleans; the disconnection reason is allow-listed; anything else becomes "other" or null');

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
  assert.ok(!fs.existsSync(path.join(TMP, 'caller-history.json.tmp')), 'no temp file left behind');
  assert.strictEqual(ca.pruneCallerHistory(new Date(T0 + 40 * 86_400_000)), 4, 'history older than 8 days pruned');
  ok('repeat-caller counts computed in the stack from keyed hashes; no number or hash in the record');

  // 6. Forwarder: off by default; https only (http just for localhost)
  assert.strictEqual(fw.forwardConfig(), null, 'off without CALL_ANALYTICS_FORWARD');
  process.env.CALL_ANALYTICS_FORWARD = 'on';
  process.env.ADMIN_API_KEY = 'vdm_synthetic_smoke_key';
  process.env.ADMIN_PORTAL_URL = 'http://admin.example.test';
  assert.strictEqual(fw.forwardConfig(), null, 'plain http to a remote host refused');
  process.env.ADMIN_PORTAL_URL = 'http://admin:5001';
  assert.strictEqual(fw.forwardConfig(), null, 'a single-label host is not trusted over http by default');
  assert.deepStrictEqual(fw.forwardStatus(), { ok: false, reason: 'insecure url' });
  process.env.CALL_ANALYTICS_HTTP_HOSTS = 'admin, metrics';
  assert.strictEqual(fw.forwardConfig()?.url, 'http://admin:5001/api/call-records', 'http to a host on the explicit list');
  process.env.ADMIN_PORTAL_URL = 'http://other:5001';
  assert.strictEqual(fw.forwardConfig(), null, 'a host not on the list');
  process.env.ADMIN_PORTAL_URL = 'http://admin.evil.example:5001';
  assert.strictEqual(fw.forwardConfig(), null, 'exact names only, no suffix match');
  process.env.ADMIN_PORTAL_URL = 'http://127.0.0.1:5001';
  assert.ok(fw.forwardConfig(), 'loopback is always allowed');
  process.env.NODE_ENV = 'production';
  process.env.CALL_ANALYTICS_HASH_KEY = 'synthetic-smoke-hash-key-0123456789abcdef';
  process.env.ADMIN_PORTAL_URL = 'http://admin:5001';
  assert.ok(fw.forwardConfig(), 'production: http only to a listed host');
  process.env.ADMIN_PORTAL_URL = 'http://admin.example.test';
  assert.strictEqual(fw.forwardConfig(), null, 'production: plain http to anything else refused');
  delete process.env.CALL_ANALYTICS_HTTP_HOSTS;
  process.env.ADMIN_PORTAL_URL = 'http://admin:5001';
  assert.strictEqual(fw.forwardConfig(), null, 'production: no list, no http');
  process.env.NODE_ENV = 'test';
  delete process.env.CALL_ANALYTICS_HASH_KEY;
  process.env.ADMIN_PORTAL_URL = 'https://admin.example.test/';
  assert.strictEqual(fw.forwardConfig()?.url, 'https://admin.example.test/api/call-records');
  delete process.env.CALL_ANALYTICS_FORWARD;
  await fw.forwardCallEvent('call_analyzed', analyzedCall('call_off'));
  assert.ok(!fs.existsSync(path.join(TMP, 'call-records-outbox.json')), 'nothing queued when off');
  ok('forwarding is off by default and needs https (http only to loopback or hosts in CALL_ANALYTICS_HTTP_HOSTS)');

  // 6b. Production requires CALL_ANALYTICS_HASH_KEY: no key file is generated, forwarding refuses to start (L4)
  const PROD = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-call-records-prod-'));
  process.env.AUDIT_DIR = PROD;
  process.env.NODE_ENV = 'production';
  process.env.CALL_ANALYTICS_FORWARD = 'on';
  assert.deepStrictEqual(fw.forwardStatus(), { ok: false, reason: 'hash key required in production' });
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(' '));
  try {
    fw.startForwarder();
  } finally {
    console.error = origError;
  }
  assert.ok(errors.some((e) => /forwarding refused: hash key required in production/.test(e)), 'refusal is logged');
  assert.ok(!errors.some((e) => /vdm_|synthetic-smoke/.test(e)), 'the log carries no key');
  await fw.forwardCallEvent('call_analyzed', analyzedCall('call_prod1'));
  assert.throws(() => ca.callRef('call_prod1'), /CALL_ANALYTICS_HASH_KEY is required in production/);
  await assert.rejects(ca.buildCallRecord('call_analyzed', analyzedCall('call_prod2')), /required in production/);
  assert.ok(!fs.existsSync(path.join(PROD, 'caller-history.key')), 'no key generated next to the hashes');
  assert.ok(!fs.existsSync(path.join(PROD, 'call-records-outbox.json')), 'nothing queued');
  process.env.CALL_ANALYTICS_HASH_KEY = 'short';
  assert.strictEqual(fw.forwardStatus().ok, false, 'a key under 32 characters does not count');
  process.env.CALL_ANALYTICS_HASH_KEY = 'synthetic-smoke-hash-key-0123456789abcdef';
  assert.strictEqual(fw.forwardStatus().ok, true);
  const prodRec = await ca.buildCallRecord('call_analyzed', analyzedCall('call_prod3'));
  assert.match(prodRec!.call_id, /^cr_[0-9a-f]{32}$/);
  assert.ok(!fs.existsSync(path.join(PROD, 'caller-history.key')), 'the env key is used; still no key file');
  process.env.CALL_ANALYTICS_HASH_KEY = 'another-synthetic-hash-key-0123456789abcd';
  assert.notStrictEqual(ca.callRef('call_prod3'), prodRec!.call_id, 'the reference depends on the stack key');
  delete process.env.CALL_ANALYTICS_HASH_KEY;
  delete process.env.CALL_ANALYTICS_FORWARD;
  process.env.NODE_ENV = 'test';
  process.env.AUDIT_DIR = TMP;
  fs.rmSync(PROD, { recursive: true, force: true });
  ok('production: no hash key means no forwarding, no generated key file and no record');

  // 6c. Private files: a stale loose temp file never leaks its mode; new directories are 0700 (L3)
  const L3 = path.join(TMP, 'l3', 'nested');
  const target = path.join(L3, 'private.json');
  fs.mkdirSync(L3, { recursive: true });
  fs.writeFileSync(`${target}.tmp`, 'stale', { mode: 0o644 });
  if (process.platform !== 'win32') fs.chmodSync(`${target}.tmp`, 0o644);
  ca.writePrivateFile(target, '{"a":1}');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"a":1}');
  assert.ok(!fs.existsSync(`${target}.tmp`));
  const fresh = path.join(TMP, 'l3-new', 'deep', 'f.json');
  const oldMask = process.platform !== 'win32' ? process.umask(0) : 0;
  try {
    ca.writePrivateFile(fresh, 'x');
  } finally {
    if (process.platform !== 'win32') process.umask(oldMask);
  }
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600, 'stale 0644 temp file did not leak its mode');
    assert.strictEqual(fs.statSync(fresh).mode & 0o777, 0o600, '0600 even with umask 0');
    assert.strictEqual(fs.statSync(path.dirname(fresh)).mode & 0o777, 0o700, 'new directory is 0700 even with umask 0');
    assert.strictEqual(fs.statSync(path.join(TMP, 'l3-new')).mode & 0o777, 0o700);
  } else {
    console.log('  (file modes are not checked on Windows; run this smoke on Linux for the mode assertions)');
  }
  ok('private files are written 0600 via a fresh temp file, in 0700 directories');

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
  assert.strictEqual(received[0].body.call_id, ca.callRef('call_fw1'));
  assert.ok(!JSON.stringify(received[0].body).includes('call_fw1'), 'no vendor call ID in the forwarded body');
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(TMP, 'call-records-outbox.json.tmp'), 'stale', { mode: 0o644 });
    fs.chmodSync(path.join(TMP, 'call-records-outbox.json.tmp'), 0o644);
  }
  mode = 'bad';
  await fw.forwardCallEvent('call_analyzed', analyzedCall('call_fw2'));
  assert.strictEqual(fw.outboxSize(), 0, 'a record the admin app rejects as invalid is dropped');
  const outboxText = fs.readFileSync(path.join(TMP, 'call-records-outbox.json'), 'utf8');
  assertNoPhi(outboxText, 'outbox');
  assert.ok(!outboxText.includes('call_fw2'), 'no vendor call ID in the outbox');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(path.join(TMP, 'call-records-outbox.json')).mode & 0o777, 0o600, 'outbox stays 0600 over a stale temp file');
  }
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
  assert.strictEqual(received[0].body.call_id, ca.callRef('call_e2e'));
  assert.ok(!JSON.stringify(received[0].body).includes('call_e2e'), 'vendor call ID never forwarded');
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
