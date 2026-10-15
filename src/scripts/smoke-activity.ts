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

import assert from 'assert';
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
  const keys = ['ts', 'server', 'call_id', 'tool', 'patient_id', 'success', 'error_code', 'latency_ms', 'channel'];
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

  // 5. Webhook verification
  const body = '{"event":"call_started","call":{"call_id":"x"}}';
  const fakeSdk = (b: string, key: string, sig: string) => b === body && key === 'test-key' && sig === 'good-sig';
  assert.strictEqual((await events.verifyWebhook(body, {}, { sdkVerify: null })).status, 503, 'closed when unconfigured');
  process.env.RETELL_WEBHOOK_SECRET = 'test-webhook-secret';
  assert.ok((await events.verifyWebhook(body, { 'x-drawbridge-webhook-secret': 'test-webhook-secret' }, { sdkVerify: null })).ok);
  assert.strictEqual((await events.verifyWebhook(body, { 'x-drawbridge-webhook-secret': 'wrong' }, { sdkVerify: null })).status, 401);
  assert.strictEqual((await events.verifyWebhook(body, {}, { sdkVerify: null })).status, 401);
  assert.strictEqual((await events.verifyWebhook(body, { 'x-retell-signature': 'good-sig' }, { sdkVerify: null })).status, 401, 'signature ignored without sdk');
  delete process.env.RETELL_WEBHOOK_SECRET;
  process.env.RETELL_API_KEY = 'test-key';
  assert.ok((await events.verifyWebhook(body, { 'x-retell-signature': 'good-sig' }, { sdkVerify: fakeSdk })).ok);
  assert.strictEqual((await events.verifyWebhook(body, { 'x-retell-signature': 'bad-sig' }, { sdkVerify: fakeSdk })).status, 401);
  assert.strictEqual((await events.verifyWebhook(body + ' ', { 'x-retell-signature': 'good-sig' }, { sdkVerify: fakeSdk })).status, 401, 'tampered body');
  assert.strictEqual((await events.verifyWebhook(body, { 'x-retell-signature': 'good-sig' }, { sdkVerify: null })).status, 503, 'api key alone is not enough without sdk');
  delete process.env.RETELL_API_KEY;
  ok('webhook: shared secret and Retell signature accept/reject, closed when unconfigured');

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
  try {
    assert.strictEqual(await post({}), 503);
    process.env.RETELL_WEBHOOK_SECRET = 'test-webhook-secret';
    assert.strictEqual(await post({ 'x-drawbridge-webhook-secret': 'nope' }), 401);
    assert.strictEqual(await post({ 'x-drawbridge-webhook-secret': 'test-webhook-secret' }), 204);
    assert.ok(events.readCallsIndex().some((r) => r.call_id === 'call_http1'));
  } finally {
    delete process.env.RETELL_WEBHOOK_SECRET;
    server.close();
  }
  ok('POST /webhooks/retell: 503 unconfigured, 401 wrong secret, 204 accepted');

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
