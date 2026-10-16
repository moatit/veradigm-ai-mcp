/**
 * Offline checks for the activity module (no network beyond 127.0.0.1, no credentials).
 * Audit lines carry no arguments or PHI, metrics math, retention, webhook verification,
 * and Retell events only touching call records that already exist.
 *
 *   npm run smoke:activity
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-activity-'));
process.env.AUDIT_DIR = TMP;
process.env.CALL_RECORDS_DIR = TMP;
process.env.CLINIC_TIMEZONE = 'America/Boise';
delete process.env.RETELL_WEBHOOK_SECRET;
delete process.env.RETELL_API_KEY;
delete process.env.RETELL_WEBHOOK_API_KEY;

import assert from 'assert';
import { createHmac } from 'crypto';
import type { AddressInfo } from 'net';

async function main(): Promise<void> {
  const audit = await import('../platform/audit');
  const events = await import('../platform/modules/activity/retell-events');
  const { mountRetellWebhook, toolLabel, systemLabel } = await import('../platform/modules/activity');
  const { callRecords } = await import('../unity/oncall/call-records');
  const express = (await import('express')).default;

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // 1. Audit lines: metadata only, never arguments, names, DOBs or results
  const phi = { patientId: '56500', firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '1950-02-03', reason: 'chest pain' };
  audit.auditToolCall({ server: 'unity', tool: 'unity_get_patient_appointments', args: phi, callId: 'call_abc123', success: true, latencyMs: 412.6, channel: 'retell' });
  audit.auditToolCall({ server: 'fhir', tool: 'search_patient', args: { patient: 'Zelda Quixote', birthdate: '1950-02-03' }, success: false, errorCode: 'AUTH_ERROR', latencyMs: 90, channel: 'RETELL' });
  audit.auditToolCall({ server: 'unity', tool: 'unity_get_account_balance', args: { patient: 77 }, callId: 'Zelda Quixote', success: false, latencyMs: 5 });
  await audit.flushAudit();
  const day = audit.dayKey();
  const file = path.join(TMP, 'audit', `${day}.jsonl`);
  const text = fs.readFileSync(file, 'utf8');
  for (const bad of ['Zelda', 'Quixote', '1950', 'chest', 'dateOfBirth', 'firstName', 'birthdate']) {
    assert.ok(!text.includes(bad), `audit line leaks "${bad}"`);
  }
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 3);
  const keys = ['ts', 'server', 'kind', 'call_id', 'tool', 'patient_id', 'success', 'error_code', 'latency_ms', 'channel', 'prev', 'hash'];
  for (const l of lines) assert.deepStrictEqual(Object.keys(l).sort(), [...keys].sort());
  assert.strictEqual(lines[0].patient_id, '56500');
  assert.strictEqual(lines[0].latency_ms, 413);
  assert.strictEqual(lines[0].call_id, 'call_abc123');
  assert.strictEqual(lines[1].patient_id, '', 'a name in "patient" is not an ID');
  assert.strictEqual(lines[1].error_code, 'AUTH_ERROR');
  assert.strictEqual(lines[1].channel, 'retell');
  assert.strictEqual(lines[2].patient_id, '77');
  assert.strictEqual(lines[2].call_id, '', 'non-ID call id dropped');
  assert.strictEqual(lines[2].error_code, 'UNKNOWN_ERROR');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  ok('audit lines hold IDs and outcomes only (no args, names, DOBs)');

  // 2. auditToolCall never throws, even on junk input
  assert.doesNotThrow(() => audit.auditToolCall(null as any));
  assert.doesNotThrow(() => audit.auditToolCall({ server: 'unity', tool: undefined as any, success: true, latencyMs: NaN }));
  await audit.flushAudit();
  ok('audit write never throws into the request path');

  // 2b. Tamper evidence: hash chain per server, verified per day file
  const v1 = await audit.verifyAuditDay(day);
  assert.ok(v1.ok, JSON.stringify(v1.errors));
  assert.deepStrictEqual([v1.lines, v1.chained, v1.unchained], [3, 3, 0]);
  assert.strictEqual(lines[0].prev, audit.genesisHash(day, 'unity'));
  assert.strictEqual(lines[1].prev, audit.genesisHash(day, 'fhir'), 'fhir has its own chain in the shared file');
  assert.strictEqual(lines[2].prev, lines[0].hash, 'unity line 2 chains to unity line 1');
  const raw = text.trim().split('\n');
  const copy = (rows: string[]) => {
    const f = path.join(TMP, 'tamper', `${day}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, rows.join('\n') + '\n');
    return audit.verifyAuditDay(f);
  };
  assert.ok((await copy(raw)).ok, 'an untouched copy verifies');
  const edited = [...raw];
  edited[0] = edited[0].replace('"success":true', '"success":false');
  assert.ok(/edited/.test((await copy(edited)).errors[0]?.reason || ''), 'edited line detected');
  assert.ok((await copy([raw[0], raw[1]])).ok, 'dropping the last lines is not detectable by the chain alone (documented)');
  assert.ok(/chain broken/.test((await copy([raw[1], raw[2]])).errors[0]?.reason || ''), 'deleted line detected');
  assert.ok(!(await copy([raw[2], raw[1], raw[0]])).ok, 'reordered lines detected');
  assert.ok(!(await copy([raw[0], '{"ts":"x","server":"unity","tool":"y"}', raw[1], raw[2]])).ok, 'inserted unchained line detected');
  const legacy = await copy(['{"ts":"2026-10-15T00:00:00Z","server":"unity","tool":"old"}', ...raw]);
  assert.ok(legacy.ok && legacy.unchained === 1, 'lines written before the chain existed are counted, not failed');
  assert.ok(!(await audit.verifyAuditDay('1999-01-01')).ok, 'missing file fails');
  // A restart picks the chain up from the file
  const before = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  audit.auditToolCall({ server: 'unity', tool: 'unity_get_patient', args: { patientId: '1' }, success: true, latencyMs: 1 });
  await audit.flushAudit();
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, before + 1);
  assert.ok((await audit.verifyAuditDay(day)).ok);
  ok('audit hash chain: per-server SHA-256 chain verifies; edited, deleted, reordered and inserted lines are caught');

  // 2c. Direct Veradigm actions from modules are audited (kind "action")
  const { auditedUnity } = await import('../platform/audited-unity');
  const fakeUnity: any = {
    executeAction: async (action: string, _p: any, pid: string) => {
      if (action === 'GetDocumentImage') throw Object.assign(new Error('x'), { code: 'TIMEOUT_ERROR' });
      return action === 'SaveTask' ? { success: false, error: 'Magic Error' } : { success: true, data: [{ pid }] };
    },
    async helper(this: any) {
      return this.executeAction('GetProviders', {}, '', 'EHR');
    },
  };
  const view = auditedUnity(fakeUnity, 'intake');
  await view.executeAction('SaveScanDocument', { Data: 'BASE64PDF' }, '56500', 'EHR');
  await view.executeAction('SaveTask', { Parameter1: 'Lab review for Zelda' }, '56500', 'EHR');
  await assert.rejects(view.executeAction('GetDocumentImage', {}, '', 'EHR'));
  await view.helper();
  await audit.flushAudit();
  const actionLines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.kind === 'action');
  assert.deepStrictEqual(actionLines.map((l) => [l.tool, l.patient_id, l.success, l.error_code, l.channel]), [
    ['SaveScanDocument', '56500', true, '', 'intake'],
    ['SaveTask', '56500', false, 'UNITY_ERROR', 'intake'],
    ['GetDocumentImage', '', false, 'TIMEOUT_ERROR', 'intake'],
    ['GetProviders', '', true, '', 'intake'],
  ]);
  const all = fs.readFileSync(file, 'utf8');
  assert.ok(!all.includes('BASE64PDF') && !all.includes('Zelda'), 'action parameters never stored');
  assert.ok((await audit.verifyAuditDay(day)).ok);
  ok('module Veradigm actions (SaveScanDocument, SaveTask, reads) audited with action, patient ID, outcome, latency');

  // 3. Metrics math
  const mk = (tool: string, latency: number, success = true): any => ({ ts: '', server: 'unity', call_id: '', tool, patient_id: '', success, error_code: '', latency_ms: latency, channel: '' });
  const entries = [
    ...Array.from({ length: 20 }, (_, i) => mk('a', (i + 1) * 10, i % 4 !== 0)), // 10..200 ms, 5 failures
    mk('b', 7),
  ];
  const m = audit.toolMetrics(entries);
  assert.strictEqual(m[0].tool, 'a');
  assert.strictEqual(m[0].count, 20);
  assert.strictEqual(m[0].errors, 5);
  assert.strictEqual(m[0].error_rate, 0.25);
  assert.strictEqual(m[0].p50_ms, 100);
  assert.strictEqual(m[0].p95_ms, 190);
  assert.deepStrictEqual([m[1].p50_ms, m[1].p95_ms, m[1].error_rate], [7, 7, 0]);
  assert.strictEqual(audit.percentile([], 95), 0);
  assert.strictEqual(audit.percentile([1, 2, 3, 4], 50), 2);
  ok('metrics: count, error rate, p50/p95 (nearest rank)');

  // 4. Retention
  fs.writeFileSync(path.join(TMP, 'audit', '2020-01-01.jsonl'), '');
  const removed = await audit.pruneAudit();
  assert.strictEqual(removed, 1);
  assert.ok(fs.existsSync(file) && !fs.existsSync(path.join(TMP, 'audit', '2020-01-01.jsonl')));
  ok('retention removes day files older than AUDIT_RETENTION_DAYS');

  // 5. Webhook verification (retell-signature.ts)
  const sigmod = await import('../platform/modules/activity/retell-signature');
  // Known vector, computed independently (Python hmac): HMAC-SHA256(body + "1760000000000", key).
  const VKEY = 'key_TEST_webhook_badge_0001';
  const VBODY = '{"event":"call_started","call":{"call_id":"call_vector1"}}';
  const VTS = 1760000000000;
  const VSIG = `v=${VTS},d=2a1419aa278fd3f8ff1171f8124098e0f1b3f5e84a6e47be7d0a39fd10b4a8d4`;
  assert.deepStrictEqual(sigmod.checkRetellSignature(VBODY, VKEY, VSIG, VTS + 1000), { ok: true });
  assert.ok(sigmod.verifyRetellSignature(Buffer.from(VBODY, 'utf8'), VKEY, VSIG, VTS), 'raw Buffer body');
  // Non-ASCII body: the bytes as received (UTF-8), second independent vector.
  const VBODY2 = Buffer.from('{"event":"call_inbound","call_inbound":{"call_id":"call_vec2","note":"José"}}', 'utf8');
  assert.ok(sigmod.verifyRetellSignature(VBODY2, VKEY, `v=${VTS},d=daa6b240968f4fae66ebf160078573f787f54e1b8baf9af32c09fc4d305fd378`, VTS));
  assert.ok(sigmod.verifyRetellSignature(VBODY, VKEY, `v=${VTS},d=${VSIG.split('d=')[1].toUpperCase()}`, VTS), 'hex case-insensitive');
  const reason = (b: string, k: string, h: string, now = VTS) => {
    const c = sigmod.checkRetellSignature(b, k, h, now);
    return c.ok ? 'ok' : c.reason;
  };
  assert.strictEqual(reason(VBODY + ' ', VKEY, VSIG), 'digest mismatch', 'one extra byte');
  assert.strictEqual(reason(JSON.stringify(JSON.parse(VBODY), null, 1), VKEY, VSIG), 'digest mismatch', 're-serialized JSON is not the raw body');
  assert.strictEqual(reason(VBODY, 'key_other', VSIG), 'digest mismatch', 'wrong key');
  assert.strictEqual(reason(VBODY, VKEY, VSIG, VTS + 5 * 60_000 + 1), 'stale timestamp');
  assert.strictEqual(reason(VBODY, VKEY, VSIG, VTS - 5 * 60_000 - 1), 'stale timestamp', 'future timestamp');
  assert.strictEqual(reason(VBODY, VKEY, VSIG, VTS + 5 * 60_000), 'ok', 'exactly 5 minutes still accepted');
  assert.strictEqual(reason(VBODY, VKEY, ''), 'missing signature');
  for (const bad of ['garbage', 'v=abc,d=00', `v=${VTS}`, `v=${VTS},d=zz`, `v=${VTS},d=2a14`]) assert.strictEqual(reason(VBODY, VKEY, bad), 'bad signature format', bad);
  assert.strictEqual(reason(VBODY, '', VSIG), 'no key');

  // Which key verifies: RETELL_WEBHOOK_API_KEY first, else RETELL_API_KEY.
  assert.deepStrictEqual(sigmod.retellWebhookKey({}), { key: '', source: '' });
  assert.strictEqual(sigmod.retellWebhookKey({ RETELL_API_KEY: 'a' }).source, 'RETELL_API_KEY');
  assert.strictEqual(sigmod.retellWebhookKey({ RETELL_API_KEY: 'a', RETELL_WEBHOOK_API_KEY: ' b ' }).key, 'b');
  const H = { 'x-retell-signature': VSIG };
  const vw = (env: NodeJS.ProcessEnv, h: Record<string, string> = H) => sigmod.verifyRetellWebhook(VBODY, h, VTS, env);
  assert.strictEqual(vw({}).status, 503, 'closed when unconfigured');
  assert.ok(vw({ RETELL_WEBHOOK_API_KEY: VKEY }).ok, 'webhook-badged key');
  assert.ok(vw({ RETELL_API_KEY: VKEY }).ok, 'falls back to RETELL_API_KEY');
  const live = vw({ RETELL_API_KEY: 'key_api_calls', RETELL_WEBHOOK_API_KEY: VKEY });
  assert.ok(live.ok && /RETELL_WEBHOOK_API_KEY/.test(live.reason), 'the webhook key wins over the API key (the live 401)');
  const wrong = vw({ RETELL_API_KEY: 'key_api_calls' });
  assert.strictEqual(wrong.status, 401);
  assert.ok(/digest mismatch/.test(wrong.reason) && /RETELL_API_KEY/.test(wrong.reason) && /webhook/.test(wrong.reason), wrong.reason);
  assert.ok(!wrong.reason.includes('key_api_calls') && !wrong.reason.includes(VBODY) && !wrong.reason.includes('2a1419aa'), 'reason has no key, body or digest');
  assert.ok(/stale timestamp \(\d+s off/.test(sigmod.verifyRetellWebhook(VBODY, H, VTS + 10 * 60_000, { RETELL_WEBHOOK_API_KEY: VKEY }).reason));
  assert.strictEqual(vw({ RETELL_WEBHOOK_API_KEY: VKEY }, { 'x-retell-signature': 'nope' }).reason, 'bad signature format');
  assert.strictEqual(vw({ RETELL_WEBHOOK_API_KEY: VKEY }, {}).reason, 'missing signature');

  // Shared secret (relays, tests) through the module's verifyWebhook
  const body = '{"event":"call_started","call":{"call_id":"x"}}';
  assert.strictEqual((await events.verifyWebhook(body, {})).status, 503, 'closed when unconfigured');
  process.env.RETELL_WEBHOOK_SECRET = 'test-webhook-secret';
  assert.ok((await events.verifyWebhook(body, { 'x-drawbridge-webhook-secret': 'test-webhook-secret' })).ok);
  assert.strictEqual((await events.verifyWebhook(body, { 'x-drawbridge-webhook-secret': 'wrong' })).reason, 'shared secret mismatch');
  assert.strictEqual((await events.verifyWebhook(body, {})).status, 401);
  assert.strictEqual((await events.verifyWebhook(body, { 'x-retell-signature': VSIG })).status, 401, 'no key: a signature alone is not accepted');
  delete process.env.RETELL_WEBHOOK_SECRET;
  process.env.RETELL_WEBHOOK_API_KEY = VKEY;
  assert.ok((await events.verifyWebhook(VBODY, H, VTS)).ok);
  assert.strictEqual((await events.verifyWebhook(VBODY + ' ', H, VTS)).status, 401, 'tampered body');
  delete process.env.RETELL_WEBHOOK_API_KEY;
  ok('webhook: Retell signature known vectors (raw bytes, UTF-8), 5-minute window, bad format / stale / mismatch reasons without key or body, RETELL_WEBHOOK_API_KEY then RETELL_API_KEY, shared secret, closed when unconfigured');

  // 6. Events: index always, call record only when it already exists
  const t0 = Date.now() - 5 * 60_000;
  const transcript = 'Agent: Hello Zelda Quixote, born 1950-02-03';
  const r1 = events.handleRetellEvent({
    event: 'call_ended',
    call: { call_id: 'call_noRecord1', agent_id: 'agent_1', direction: 'inbound', from_number: '+12085550147', to_number: '+12089043641', start_timestamp: t0, end_timestamp: t0 + 125_000, disconnection_reason: 'user_hangup', transcript },
  });
  assert.strictEqual(r1.record_updated, false);
  assert.strictEqual(callRecords.get('call_noRecord1'), undefined, 'events never create call records');

  callRecords.upsert('call_withRecord', 'after_hours', { reason_verbatim: 'test message' });
  const longSummary = 'S'.repeat(1500);
  events.handleRetellEvent({ event: 'call_started', call: { call_id: 'call_withRecord', from_number: '+12085550199', start_timestamp: t0 } });
  const r2 = events.handleRetellEvent({
    event: 'call_analyzed',
    call: { call_id: 'call_withRecord', start_timestamp: t0, end_timestamp: t0 + 61_000, disconnection_reason: 'agent_hangup', transcript, call_analysis: { call_summary: longSummary } },
  });
  assert.strictEqual(r2.record_updated, true);
  const rec = callRecords.get('call_withRecord')!;
  assert.strictEqual(rec.transcript_ref, 'retell:call_withRecord');
  assert.strictEqual(rec.call_meta?.duration_ms, 61_000);
  assert.strictEqual(rec.call_meta?.disconnection_reason, 'agent_hangup');
  assert.strictEqual(rec.call_meta?.summary?.length, 1000);
  assert.strictEqual(rec.reason_verbatim, 'test message', 'existing fields kept');
  assert.ok(!JSON.stringify(rec).includes('Zelda'), 'no transcript in call record');

  const idxText = fs.readFileSync(path.join(TMP, 'calls.json'), 'utf8');
  for (const bad of ['Zelda', '5550147', '9043641', 'SSSS', 'transcript']) assert.ok(!idxText.includes(bad), `calls index leaks "${bad}"`);
  const idx = events.readCallsIndex();
  const a = idx.find((r) => r.call_id === 'call_noRecord1')!;
  assert.deepStrictEqual([a.from_last4, a.to_last4, a.direction, a.disconnection_reason, a.summary_present], ['0147', '3641', 'inbound', 'user_hangup', false]);
  const b = idx.find((r) => r.call_id === 'call_withRecord')!;
  assert.deepStrictEqual([b.from_last4, b.summary_present, !!b.end], ['0199', true, true]);
  assert.strictEqual(events.handleRetellEvent({ event: 'call_ended', call: {} }).status, 400);
  assert.strictEqual(events.handleRetellEvent({ event: 'transcript_updated', call: { call_id: 'x' } }).record_updated, false);
  ok('events: calls index (last 4 only, no transcript/summary text); records updated only when they exist');

  // 7. Webhook route end to end on 127.0.0.1 (raw body survives the app-wide JSON parser)
  const app = express();
  mountRetellWebhook(app);
  app.use(express.json());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/retell`;
  const payload = JSON.stringify({ event: 'call_ended', call: { call_id: 'call_http1', start_timestamp: t0, end_timestamp: t0 + 1000 } });
  const post = (headers: Record<string, string>) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload }).then((r) => r.status);
  const sign = (key: string, raw: string, t = Date.now()) => `v=${t},d=${createHmac('sha256', key).update(raw + t).digest('hex')}`;
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(' '));
  try {
    assert.strictEqual(await post({}), 503);
    process.env.RETELL_WEBHOOK_SECRET = 'test-webhook-secret';
    assert.strictEqual(await post({ 'x-drawbridge-webhook-secret': 'nope' }), 401);
    assert.strictEqual(await post({ 'x-drawbridge-webhook-secret': 'test-webhook-secret' }), 204);
    assert.ok(events.readCallsIndex().some((r) => r.call_id === 'call_http1'));
    delete process.env.RETELL_WEBHOOK_SECRET;
    // Retell signs with the webhook-badged key; RETELL_API_KEY is a different key (the live 401).
    process.env.RETELL_API_KEY = 'key_TEST_api_calls';
    assert.strictEqual(await post({ 'x-retell-signature': sign(VKEY, payload) }), 401, 'API key alone: rejected');
    assert.ok(warnings.some((w) => /digest mismatch/.test(w)), 'reason logged');
    assert.ok(!warnings.some((w) => w.includes(VKEY) || w.includes('key_TEST_api_calls') || w.includes('call_http1')), 'no key or body in the log');
    process.env.RETELL_WEBHOOK_API_KEY = VKEY;
    assert.strictEqual(await post({ 'x-retell-signature': sign(VKEY, payload) }), 204, 'webhook key: accepted over the raw bytes');
    assert.strictEqual(await post({ 'x-retell-signature': sign(VKEY, payload, Date.now() - 6 * 60_000) }), 401, 'stale');
    assert.ok(warnings.some((w) => /stale timestamp/.test(w)));
  } finally {
    console.warn = warn;
    delete process.env.RETELL_WEBHOOK_SECRET;
    delete process.env.RETELL_WEBHOOK_API_KEY;
    delete process.env.RETELL_API_KEY;
    server.close();
  }
  ok('POST /webhooks/retell: 503 unconfigured, 401 wrong secret, 204 accepted; signature with RETELL_WEBHOOK_API_KEY over the raw bytes, 401 with only the API key, reasons logged');

  // 8. Client-facing labels
  assert.strictEqual(toolLabel('unity_get_open_slots'), 'get open slots');
  assert.ok(!/unity|fhir|mcp/i.test(systemLabel({ server: 'fhir', tool: 'get_allergies' }) + systemLabel({ server: 'unity', tool: 'unity_x' })));
  ok('screen labels never say Unity/FHIR/MCP');

  console.log(`\n${passed} checks passed`);
}

main()
  .catch((e) => {
    console.error('FAIL', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
