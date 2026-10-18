/**
 * Offline checks for the Drawbridge voice harness (src/platform/modules/voice) with fake providers and a fake gateway:
 * no PBX, no OpenAI, no ElevenLabs, no Veradigm. Synthetic patients only.
 *
 *  1. Gateway link auth: HMAC header, stale timestamp, replay, wrong key, frames; the WebSocket server refuses a
 *     connection without the header (401) and accepts a signed one.
 *  2. Agent configuration: defaults valid; secrets, forbidden star codes (*0 intercom, *72 forwarding, ...),
 *     external numbers, unknown tools and a disabled say_script are refused.
 *  3. Tool routing and call binding: tools run through the same gate as /api/retell (withCallBinding) under the call
 *     ID the harness minted; a model-supplied call ID is ignored; a tool not enabled on the agent is refused and
 *     audited; a patient tool before verification is NOT_VERIFIED; after an exact search it runs.
 *  4. Scripted lines: say_script plays the exact clip bytes and only then returns to the model; safety clips are not
 *     cut off by barge-in; the emergency backstop plays EMERGENCY_911 on "chest pain" without a tool call.
 *  5. Transcript labels: caller / agent / staff:<ext> / far_end by leg, cut-off agent speech, tool entries without
 *     results, the calls index with the last 4 digits only, no transcript text in the server log.
 *  6. Warm transfer: hold -> dial (allow-list) -> staff answers -> the model hears only staff -> DTMF 1 -> resume +
 *     conference + agent leaves; ring failure and hold timeout bring the caller back with STAFF_UNAVAILABLE;
 *     a caller hang-up during the consult hangs up staff.
 *  7. The model never hears itself: agent audio is never sent to the provider; with the agent muted in a conference
 *     the provider gets the mix of the two human legs only and no agent audio goes out.
 *  8. Call admission: no SRTP, provider without BAA, no key, missing clips -> refused; otherwise accepted with a
 *     minted voice_<uuid> call ID and the provider's PCM rate.
 *  9. OpenAI Realtime adapter against a fake server: session.update shape, audio and tool events, tool results.
 * 10. Prompt: Retell variables filled, the voice-line addendum present.
 *
 *   npm run smoke:voice-harness
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-voiceh-'));
process.env.CALL_RECORDS_DIR = TMP;
process.env.AUDIT_DIR = TMP;
process.env.CLINIC_NAME = 'Sagebrush Kidney Care';
process.env.SIP_REALM = 'pbx.example.test';
for (const k of ['DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS', 'DRAWBRIDGE_CALL_MAX_SEARCHES', 'VOICE_AGENT_ID', 'VOICE_FRONT_DESK_EXT', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY']) delete process.env[k];

import assert from 'assert';
import { randomBytes } from 'crypto';
import * as http from 'http';
import WebSocket, { WebSocketServer } from 'ws';

const SECRET = 'k'.repeat(48);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Fakes ──────────────────────────────────────────────────────────────────────────────────────────────────────

class FakeProvider {
  readonly name = 'fake' as const;
  constructor(readonly pcmRate = 24000) {}
  ev: any = null;
  audioIn: Buffer[] = [];
  results: Array<{ id: string; output: string; respond: boolean }> = [];
  assistant: string[] = [];
  notes: Array<{ text: string; respond: boolean }> = [];
  truncated: Array<{ id: string; ms: number }> = [];
  closed = false;
  cancels = 0;
  init: any = null;
  async connect(init: any, ev: any) {
    this.init = init;
    this.ev = ev;
  }
  sendAudio(p: Buffer) {
    this.audioIn.push(Buffer.from(p));
  }
  sendToolResult(id: string, output: string, respond: boolean) {
    this.results.push({ id, output, respond });
  }
  addAssistantText(t: string) {
    this.assistant.push(t);
  }
  addSystemNote(text: string, respond: boolean) {
    this.notes.push({ text, respond });
  }
  truncate(id: string, ms: number) {
    this.truncated.push({ id, ms });
  }
  cancelResponse() {
    this.cancels++;
  }
  requestResponse() {}
  close() {
    this.closed = true;
  }
}

class FakeGw {
  cmds: any[] = [];
  audio: Array<{ leg: number; pcm: Buffer }> = [];
  send = (c: any) => {
    this.cmds.push(c);
  };
  sendAudio = (leg: number, pcm: Buffer) => {
    this.audio.push({ leg, pcm: Buffer.from(pcm) });
  };
  last(type: string) {
    return [...this.cmds].reverse().find((c) => c.type === type);
  }
  all(type: string) {
    return this.cmds.filter((c) => c.type === type);
  }
  /** Bytes sent on a segment (between its segment command and the next segment on that leg). */
  bytesOf(seg: string): Buffer {
    const i = this.cmds.findIndex((c) => c.type === 'segment' && c.segment === seg);
    assert.ok(i >= 0, `segment ${seg} started`);
    return Buffer.concat(this.audio.filter((a: any) => a.seg === seg).map((a) => a.pcm));
  }
}

class ManualTimers {
  fns: Array<{ fn: () => void; ms: number; dead: boolean }> = [];
  set = (fn: () => void, ms: number) => {
    const h = { fn, ms, dead: false };
    this.fns.push(h);
    return h;
  };
  clear = (h: any) => {
    if (h) h.dead = true;
  };
  fire() {
    for (const h of this.fns.splice(0)) if (!h.dead) h.fn();
  }
}

/** Tag each audio chunk with the segment that was open on its leg (so tests can check exact clip bytes). */
function trackSegments(gw: FakeGw) {
  const open = new Map<number, string>();
  const send = gw.send;
  gw.send = (c: any) => {
    if (c.type === 'segment') open.set(c.leg, c.segment);
    send(c);
  };
  const sendAudio = gw.sendAudio;
  gw.sendAudio = (leg: number, pcm: Buffer) => {
    sendAudio(leg, pcm);
    (gw.audio[gw.audio.length - 1] as any).seg = open.get(leg);
  };
}

function pcm(ms: number, rate: number, value = 1000): Buffer {
  const n = Math.round((ms * rate) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(value, i * 2);
  return b;
}

async function main(): Promise<void> {
  const protocol = await import('../platform/modules/voice/protocol');
  const config = await import('../platform/modules/voice/config');
  const scripts = await import('../platform/modules/voice/scripts');
  const { CallSession } = await import('../platform/modules/voice/session');
  const { CallTranscript, readVoiceCall } = await import('../platform/modules/voice/transcript');
  const tools = await import('../platform/modules/voice/tools');
  const { VoiceHarness } = await import('../platform/modules/voice/gw-server');
  const { OpenAiRealtime } = await import('../platform/modules/voice/providers/openai-realtime');
  const cb = await import('../platform/call-binding');
  const audit = await import('../platform/audit');
  const { readCallsIndex } = await import('../platform/modules/activity/retell-events');
  const { emergencyDetected } = await import('../platform/modules/voice/guard');

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // Server-log capture: transcript text must never appear there.
  const logLines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const capture = (...a: any[]) => logLines.push(a.map(String).join(' '));

  // ── 1. Gateway link auth ────────────────────────────────────────────────────────────────────────────────
  {
    const n = new protocol.NonceCache();
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    const nonce = randomBytes(16).toString('hex');
    const good = protocol.authToken(SECRET, 'call', ts, nonce);
    assert.deepStrictEqual(protocol.verifyAuth(good, SECRET, n, now), { ok: true, kind: 'call' });
    assert.strictEqual((protocol.verifyAuth(good, SECRET, n, now) as any).reason, 'replay');
    const n2 = randomBytes(16).toString('hex');
    assert.strictEqual((protocol.verifyAuth(protocol.authToken(SECRET, 'call', ts - 120, n2), SECRET, n, now) as any).reason, 'stale');
    assert.strictEqual((protocol.verifyAuth(protocol.authToken('x'.repeat(48), 'call', ts, randomBytes(16).toString('hex')), SECRET, n, now) as any).reason, 'mac');
    assert.strictEqual((protocol.verifyAuth(undefined, SECRET, n, now) as any).reason, 'missing');
    assert.strictEqual((protocol.verifyAuth(good, 'short', n, now) as any).reason, 'not_configured');
    const tampered = protocol.authToken(SECRET, 'call', ts, randomBytes(16).toString('hex')).replace('kind=call', 'kind=control');
    assert.strictEqual((protocol.verifyAuth(tampered, SECRET, n, now) as any).reason, 'mac');
    const f = protocol.encodeFrame(3, pcm(20, 24000));
    const d = protocol.decodeFrame(f)!;
    assert.strictEqual(d.leg, 3);
    assert.strictEqual(d.pcm.length, 960);
    assert.strictEqual(protocol.decodeFrame(Buffer.from([1, 2])), null);
    ok('gateway link: HMAC header verified, replay/stale/wrong key/tampered kind refused; leg-tagged frames');

    // Real WebSocket server: unsigned refused, signed accepted.
    const env = { VOICE_GW_SECRET: SECRET, VOICE_ENABLED: 'on', CALL_RECORDS_DIR: TMP } as any;
    const h = new VoiceHarness({ runAgentTool: async () => ({}), toVoiceSummary: () => '', toolDefinitions: () => [], callStartVariables: () => ({}) }, env, { tts: () => null });
    console.log = capture;
    const port = await h.start(0, '127.0.0.1');
    console.log = origLog;
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-gw`);
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode || 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => undefined);
    });
    assert.strictEqual(status, 401);
    const opened = await new Promise<boolean>((resolve) => {
      const tok = protocol.authToken(SECRET, 'control', Math.floor(Date.now() / 1000), randomBytes(16).toString('hex'));
      const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-gw`, { headers: { [protocol.AUTH_HEADER]: tok } });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'status', registered: true, proxy: 'p', transport: 'tls', tls_version: 'TLS 1.2', tls_cipher: 'x', tls_verified_name: 'n', public_ip: '', seen_as: '', expires_sec: 300, last_error: '', registered_at: '', updated_at: '', active_calls: 0, media_rule: 'srtp-required', mode: 'harness' }));
        setTimeout(() => {
          ws.close();
          resolve(true);
        }, 100);
      });
      ws.on('error', () => resolve(false));
    });
    assert.ok(opened);
    assert.strictEqual(h.status?.registered, true);
    h.close();
    const noSecret = new VoiceHarness({} as any, { VOICE_ENABLED: 'on' } as any);
    console.warn = capture;
    assert.strictEqual(await noSecret.start(0, '127.0.0.1'), 0);
    console.warn = origWarn;
    ok('gateway link server: 401 without the HMAC header, control link accepted with it, status recorded; no secret = not listening');
  }

  // ── 2. Agent configuration ──────────────────────────────────────────────────────────────────────────────
  const base = { ...config.defaultAgent({ VOICE_FRONT_DESK_EXT: '4500' } as any) };
  {
    const v = config.validateAgent(base);
    assert.ok(v.ok, JSON.stringify(v));
    assert.deepStrictEqual(base.handoffs.map((h) => h.target), ['4500', '**4500']);
    const bad = (patch: any, frag: string) => {
      const r = config.validateAgent({ ...base, ...patch });
      assert.ok(!r.ok, `should refuse: ${frag}`);
      assert.ok((r as any).errors.join(' ').includes(frag), `${frag} in ${(r as any).errors}`);
    };
    bad({ custom_prompt: 'x', prompt_source: 'custom' }, 'too short');
    bad({ voice: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV' }, 'looks like a key');
    bad({ name: 'agent sk-proj-abcdefghijklmnopqrstuvwxyz0123' }, 'looks like a key');
    bad({ handoffs: [{ id: 'icom', label: 'Intercom', kind: 'transfer', target: '*0101', description: '' }] }, 'not allowed');
    bad({ handoffs: [{ id: 'fwd', label: 'Forward', kind: 'park', target: '*72', description: '' }] }, 'not allowed');
    bad({ handoffs: [{ id: 'ext', label: 'Cell', kind: 'transfer', target: '12085551234', description: '' }] }, 'must also be on the dial allow-list');
    bad({ dial_allow: ['9005551234'] }, 'premium');
    bad({ dial_allow: ['011442071234567'] }, 'international');
    bad({ dial_allow: ['8765551234'] }, 'outside the US');
    bad({ dial_allow: ['911'] }, 'emergency');
    bad({ dial_allow: ['*72'] }, 'star codes');
    bad({ max_dials_per_call: 50 }, 'dials per call');
    bad({ handoffs: [{ id: 'vm', label: 'VM', kind: 'voicemail', target: '4500', description: '' }] }, 'not allowed');
    bad({ enabled_tools: [...base.enabled_tools, 'unity_save_patient'] }, 'unknown tool');
    bad({ enabled_tools: base.enabled_tools.filter((t) => t !== 'say_script') }, 'say_script');
    bad({ provider: 'retell' }, 'provider');
    const park = config.validateAgent({ ...base, handoffs: [...base.handoffs, { id: 'park', label: 'Park', kind: 'park', target: '*3', description: 'x' }, { id: 'valet', label: 'Valet', kind: 'valet_park', target: '*4', description: 'x' }] });
    assert.ok(park.ok);
    const saved = config.saveAgent((park as any).config, 'admin1', true);
    assert.strictEqual(saved.active, 'default');
    assert.strictEqual(fs.statSync(path.join(TMP, 'voice', 'agents.json')).mode & 0o077, process.platform === 'win32' ? fs.statSync(path.join(TMP, 'voice', 'agents.json')).mode & 0o077 : 0);
    assert.strictEqual(config.activeAgent().handoffs.length, 4);
    ok('config: defaults valid; keys, *0 intercom, *72 forwarding, external/international numbers, unknown tools and a disabled say_script refused; park *3 / valet *4 allowed');
  }

  // ── Session factory ─────────────────────────────────────────────────────────────────────────────────────
  const texts = { ...scripts.scriptTexts('Sagebrush Kidney Care'), 'FILLER:One moment while I pull that up.': 'One moment while I pull that up.' };
  const clipBytes = new Map<string, Buffer>();
  for (const [id, t] of Object.entries(texts)) clipBytes.set(t, Buffer.from(randomBytes(4800 + (id.length % 7) * 2)));
  const ROSTER = [{ firstName: 'Lucius', lastName: 'Marchetti', dateOfBirth: '03/03/1960', patientId: '7001', chartPatientId: '8001' }];
  const ran: Array<{ name: string; args: any; callId: string }> = [];

  /** The same gate /api/retell uses, with a fake Veradigm behind it. */
  async function runAgentTool(name: string, args: any, callId: string): Promise<any> {
    ran.push({ name, args, callId });
    return cb.withCallBinding(name, args, { server: 'unity', callId, channel: 'voice' }, async (checked) => {
      if (name === 'unity_search_patients') {
        const hits = ROSTER.filter((p) => p.lastName === checked.lastName);
        return { success: true, patients: hits, total: hits.length };
      }
      if (name === 'unity_get_patient_appointments') return { success: true, appointments: [], patientId: checked.patientId };
      return { success: true };
    });
  }

  function makeSession(agentPatch: any = {}, opts: any = {}) {
    const agent = { ...(config.activeAgent() as any), ...agentPatch };
    const provider = new FakeProvider(24000);
    const gw = new FakeGw();
    trackSegments(gw);
    const timers = new ManualTimers();
    const callId = `voice_test_${randomBytes(4).toString('hex')}`;
    const transcript = new CallTranscript({ call_id: callId, agent_id: agent.id, provider: 'fake', model: 'm', voice: 'v', caller_last4: '0199', mode: 'business_hours', media: { transport: 'tls', codec: '', srtp: true } });
    const { AGENT_TOOLS } = require('../platform/agent-tools');
    const defs: any[] = Object.keys(AGENT_TOOLS)
      .filter((n: string) => AGENT_TOOLS[n].server === 'unity')
      .map((n: string) => ({
        name: n,
        inputSchema: { type: 'object', properties: Object.fromEntries(Object.keys(AGENT_TOOLS[n].p).map((p: string) => [p, { type: 'string' }])), required: [] },
      }));
    const specs = tools.agentToolSpecs(agent, defs);
    const transcribed: Array<{ leg: number; chunks: number }> = [];
    const transcriberFactory = opts.transcriber
      ? (rate: number, onText: (t: string) => void) => {
          const rec = { leg: -1, chunks: 0, onText };
          transcribed.push(rec as any);
          return { send: () => void rec.chunks++, close: () => undefined, onText } as any;
        }
      : undefined;
    const s = new CallSession({
      callId,
      start: { type: 'call_start', call_ref: 'gw1', from: '+12085550199', from_name: '', to: '4515', srtp: true, codecs: ['G722'], media_rule: 'srtp-required', registered: true },
      agent,
      provider: provider as any,
      link: gw,
      deps: { runAgentTool: (n, a, c) => runAgentTool(n, a, c), toVoiceSummary: (n, r) => JSON.stringify(r).slice(0, 300) },
      transcript,
      scripts: texts,
      clip: (t) => (clipBytes.has(t) ? { id: 'x', text: t, pcm: clipBytes.get(t)!, rate: 24000, sha256: '' } : undefined),
      allowedTools: tools.allowedToolNames(agent, specs),
      realm: 'pbx.example.test',
      afterHours: false,
      transcriber: transcriberFactory as any,
      timers,
      log: capture,
    });
    const ev = s.events();
    const segDone = (seg: string, played = 1000) => s.onGwEvent({ type: 'segment_done', at: 0, leg: 0, segment: seg, played_ms: played });
    return { s, ev, provider, gw, timers, callId, transcript, specs, transcribed, segDone };
  }

  // ── 3. Tool routing and binding ─────────────────────────────────────────────────────────────────────────
  {
    const { s, ev, provider, gw, callId, segDone } = makeSession();
    s.onGwEvent({ type: 'answered', at: 0, leg: 0, codec: 'G722', srtp: true });
    const greet = gw.last('segment');
    assert.ok(gw.bytesOf(greet.segment).equals(clipBytes.get(texts.GREETING)!), 'greeting clip byte for byte');
    assert.deepStrictEqual(provider.assistant, [texts.GREETING]);
    segDone(greet.segment);

    ev.toolCall({ id: 't1', name: 'unity_get_patient_appointments', args: { patientId: '7001', call_id: 'attacker-chosen' } });
    await sleep(20);
    assert.strictEqual(ran[ran.length - 1].callId, callId, 'runs under the minted call ID');
    assert.ok(!('call_id' in ran[ran.length - 1].args), 'model-supplied call_id stripped');
    assert.ok(provider.results.find((r) => r.id === 't1')!.output.includes('NOT_VERIFIED'), 'patient tool before verification refused');

    ev.toolCall({ id: 't2', name: 'unity_search_patients', args: { firstName: 'Lucius', lastName: 'Marchetti', dateOfBirth: '03/03/1960' } });
    await sleep(20);
    assert.deepStrictEqual(cb.callBindings.verified(callId).map((p) => p.pm), ['7001']);
    ev.toolCall({ id: 't3', name: 'unity_get_patient_appointments', args: { patientId: '7001' } });
    await sleep(20);
    assert.ok(provider.results.find((r) => r.id === 't3')!.output.includes('"success":true'));
    assert.ok(provider.results.find((r) => r.id === 't3')!.respond);

    ev.toolCall({ id: 't4', name: 'unity_get_day_schedule', args: {} });
    await sleep(10);
    assert.ok(provider.results.find((r) => r.id === 't4')!.output.includes('TOOL_NOT_ENABLED'));
    assert.ok(!ran.some((r) => r.name === 'unity_get_day_schedule'), 'not-enabled tool never ran');
    await audit.flushAudit();
    const lines = fs.readFileSync(path.join(TMP, 'audit', `${audit.dayKey()}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.tool === 'unity_get_day_schedule' && l.error_code === 'TOOL_NOT_ENABLED' && l.call_id === callId && l.channel === 'voice'));
    assert.ok(lines.some((l) => l.tool === 'unity_get_patient_appointments' && l.error_code === 'NOT_VERIFIED' && l.call_id === callId));
    // Filler clip played for a lookup tool while nothing else was playing.
    assert.ok(gw.audio.some((a: any) => a.pcm.equals(clipBytes.get('One moment while I pull that up.')!.subarray(0, a.pcm.length))));
    s.finish('test');
    assert.strictEqual(cb.callBindings.verified(callId).length, 0, 'binding forgotten at the end of the call');
    assert.ok(provider.closed);
    ok('tools: same gate as /api/retell under the minted call ID; model call_id ignored; NOT_VERIFIED before the exact search, runs after; not-enabled tool refused + audited; binding forgotten at hang-up');
  }

  // ── 4. Scripted lines and the emergency backstop ────────────────────────────────────────────────────────
  {
    const { s, ev, provider, gw, segDone } = makeSession();
    s.onGwEvent({ type: 'answered', at: 0, leg: 0, codec: 'G722', srtp: true });
    segDone(gw.last('segment').segment);
    ev.toolCall({ id: 'e1', name: 'say_script', args: { id: 'EMERGENCY_911' } });
    const seg = gw.last('segment').segment;
    assert.strictEqual(gw.cmds[gw.cmds.length - 3]?.type === 'clear' || gw.all('clear').length > 0, true, 'queue cleared before the emergency line');
    assert.ok(gw.bytesOf(seg).equals(clipBytes.get(texts.EMERGENCY_911)!), 'EMERGENCY_911 byte for byte');
    assert.ok(!provider.results.some((r) => r.id === 'e1'), 'no result before the clip finished');
    // Barge-in during the safety line: nothing is cleared.
    const clearsBefore = gw.all('clear').length;
    s.onGwEvent({ type: 'playout_started', at: 0, leg: 0 });
    ev.speechStarted();
    assert.strictEqual(gw.all('clear').length, clearsBefore, 'safety line not interrupted');
    segDone(seg, 3200);
    const r = provider.results.find((x) => x.id === 'e1')!;
    assert.ok(r.output.includes(texts.EMERGENCY_911) && r.respond);
    ev.toolCall({ id: 'e2', name: 'say_script', args: { id: 'MAKE_SOMETHING_UP' } });
    assert.ok(provider.results.find((x) => x.id === 'e2')!.output.includes('UNKNOWN_SCRIPT'));
    s.finish('test');

    const b = makeSession();
    b.s.onGwEvent({ type: 'answered', at: 0, leg: 0, codec: 'PCMU', srtp: true });
    b.segDone(b.gw.last('segment').segment);
    b.ev.callerTranscript('my husband has chest pain and is sweating');
    const bseg = b.gw.last('segment').segment;
    assert.ok(b.gw.bytesOf(bseg).equals(clipBytes.get(texts.EMERGENCY_911)!), 'backstop played the exact emergency clip');
    assert.ok(b.provider.cancels >= 1);
    b.segDone(bseg);
    assert.ok(b.provider.notes.some((n) => n.text.includes('Offer to transfer') && n.respond));
    const segCount = b.gw.all('segment').length;
    b.ev.callerTranscript('the chest pain is still there');
    assert.strictEqual(b.gw.all('segment').length, segCount, 'not repeated within 60 s');
    assert.ok(emergencyDetected("I can't breathe") && emergencyDetected('I want to kill myself') && !emergencyDetected('I need to reschedule my appointment'));
    b.s.finish('test');
    ok('scripts: exact clip bytes, result only after the clip played, safety line not cut by barge-in; emergency backstop on "chest pain" without a tool call, once per minute');
  }

  // ── 5. Transcript labels ────────────────────────────────────────────────────────────────────────────────
  {
    console.log = capture;
    const { s, ev, gw, callId, segDone, provider } = makeSession();
    s.onGwEvent({ type: 'answered', at: 0, leg: 0, codec: 'G722', srtp: true });
    segDone(gw.last('segment').segment);
    ev.speechStopped();
    ev.callerTranscript('I need my appointment time for Lucius Marchetti');
    ev.responseStarted('r1');
    ev.audio(pcm(400, 24000), 'r1');
    ev.agentTranscript('Your next visit is on Tuesday at nine.', true, 'r1');
    ev.responseDone('r1', 'completed');
    const seg1 = gw.last('segment').segment;
    s.onGwEvent({ type: 'playout_started', at: 0, leg: 0, latency_ms: 870 });
    segDone(seg1, 400);
    ev.responseStarted('r2');
    ev.audio(pcm(400, 24000), 'r2');
    ev.agentTranscript('Is there anything else I can help you with today?', true, 'r2');
    const seg2 = gw.last('segment').segment;
    ev.speechStarted(); // caller barges in
    assert.strictEqual(gw.last('clear').leg, 0);
    s.onGwEvent({ type: 'cleared', at: 0, leg: 0, segment: seg2, played_ms: 150 });
    assert.deepStrictEqual(provider.truncated, [{ id: 'r2', ms: 150 }]);
    ev.audio(pcm(100, 24000), 'r2'); // late audio of the cut response is dropped
    assert.ok(!gw.audio.slice(-1)[0].pcm.equals(pcm(100, 24000)));
    s.onGwEvent({ type: 'media_update', at: 0, leg: 0 });
    ev.callerTranscript('also my wife wants to ask something');
    s.onGwEvent({ type: 'hangup', at: 0, leg: 0, by: 'remote' });
    console.log = origLog;
    const rec = readVoiceCall(callId)!;
    const speech = rec.entries.filter((e) => e.kind === 'speech').map((e) => `${e.speaker}${e.truncated ? '(cut)' : ''}`);
    assert.deepStrictEqual(speech, ['caller', 'agent', 'agent(cut)', 'far_end']);
    assert.deepStrictEqual(rec.entries.filter((e) => e.kind === 'script').map((e) => e.script), ['GREETING']);
    assert.strictEqual(rec.turns[0].e2e_ms, 870);
    assert.strictEqual(rec.end_reason, 'caller_hangup');
    const idx = readCallsIndex().find((r) => r.call_id === callId)!;
    assert.strictEqual(idx.from_last4, '0199');
    assert.ok(!JSON.stringify(readCallsIndex()).includes('2085550199'));
    const logText = logLines.join('\n');
    for (const phrase of ['appointment time', 'Tuesday at nine', 'Marchetti', 'wife wants']) assert.ok(!logText.includes(phrase), `"${phrase}" leaked into the server log`);
    assert.ok(/turn kind=plain e2e_ms=870/.test(logText), 'latency is logged (metadata only)');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(TMP, 'voice', 'calls', `${callId}.json`)).mode & 0o077, 0);
    ok('transcript: caller / agent / cut-off agent / far_end by leg, scripts by ID, turn latency, calls index last 4 only, no transcript text in the server log');
  }

  // ── 6. Warm transfer ────────────────────────────────────────────────────────────────────────────────────
  {
    console.log = capture;
    const { s, ev, provider, gw, timers, callId, segDone, transcribed } = makeSession({}, { transcriber: true });
    s.onGwEvent({ type: 'answered', at: 0, leg: 0, codec: 'G722', srtp: true });
    segDone(gw.last('segment').segment);
    ev.toolCall({ id: 'w0', name: 'warm_transfer', args: { destination: 'nope', reason: 'billing' } });
    assert.ok(provider.results.find((r) => r.id === 'w0')!.output.includes('NOT_ALLOWED'), 'extension outside the allow-list refused');
    assert.ok(!gw.last('dial'));
    ev.toolCall({ id: 'w1', name: 'warm_transfer', args: { destination: 'front_desk', reason: 'question about a bill', caller_name: 'Lucius Marchetti' } });
    const holdSeg = gw.last('segment').segment;
    assert.ok(gw.bytesOf(holdSeg).equals(clipBytes.get(texts.HOLD)!));
    segDone(holdSeg);
    assert.strictEqual(gw.last('hold').leg, 0);
    const dial = gw.last('dial');
    assert.strictEqual(dial.target, 'sip:4500@pbx.example.test');
    assert.deepStrictEqual(s.state().modelIn, [], 'caller on hold: nothing to the model');
    s.onGwEvent({ type: 'leg_answered', at: 0, leg: 1, request_id: dial.request_id, codec: 'PCMU', srtp: true });
    assert.deepStrictEqual(s.state().modelIn, [1]);
    assert.strictEqual(s.state().agentOut, 1);
    const brief = provider.notes[provider.notes.length - 1];
    assert.ok(brief.respond && brief.text.includes('NOT verified') && !brief.text.includes('Marchetti'), 'unverified caller: no name in the brief');
    s.onGwAudio(0, pcm(20, 24000, 111));
    s.onGwAudio(1, pcm(20, 24000, 222));
    assert.ok(provider.audioIn.every((b) => b.readInt16LE(0) === 222), 'only the staff leg reaches the model during the consult');
    s.onGwEvent({ type: 'dtmf', at: 0, leg: 1, digit: '1' });
    assert.strictEqual(gw.last('resume').leg, 0);
    assert.deepStrictEqual(gw.last('conference').legs, [0, 1]);
    assert.strictEqual(s.state().agentPresent, false);
    assert.ok(provider.closed, 'agent left the conference');
    await audit.flushAudit();
    const lines = fs.readFileSync(path.join(TMP, 'audit', `${audit.dayKey()}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.call_id === callId);
    for (const t of ['voice_dial', 'voice_conference_join', 'voice_conference_leave']) assert.ok(lines.some((l) => l.tool === t), `${t} audited`);
    assert.ok(lines.some((l) => l.tool === 'voice_dial' && l.success === false), 'refused dial audited');
    assert.ok(transcribed.length >= 1);
    s.onGwEvent({ type: 'leg_hangup', at: 0, leg: 1, by: 'remote' });
    assert.deepStrictEqual(gw.last('hangup'), { type: 'hangup', leg: 0 }, 'staff left after the hand-off: call over');
    s.finish('test');
    timers.fire();

    // No answer -> caller back, STAFF_UNAVAILABLE, voicemail offered.
    const n = makeSession();
    n.s.onGwEvent({ type: 'answered', at: 0, leg: 0, codec: 'G722', srtp: true });
    n.segDone(n.gw.last('segment').segment);
    n.ev.toolCall({ id: 'w2', name: 'warm_transfer', args: { destination: 'front_desk', reason: 'refill' } });
    n.segDone(n.gw.last('segment').segment);
    const d2 = n.gw.last('dial');
    n.s.onGwEvent({ type: 'leg_failed', at: 0, leg: 1, request_id: d2.request_id, code: 0, reason: 'no_answer' });
    assert.strictEqual(n.gw.last('resume').leg, 0);
    const back = n.gw.last('segment').segment;
    assert.ok(n.gw.bytesOf(back).equals(clipBytes.get(texts.STAFF_UNAVAILABLE)!));
    n.segDone(back);
    assert.ok(n.provider.notes.slice(-1)[0].text.includes('voicemail'));
    assert.deepStrictEqual(n.s.state().modelIn, [0]);
    n.s.finish('test');

    // Hold timeout while staff talks: staff hung up, caller back.
    const t = makeSession();
    t.s.onGwEvent({ type: 'answered', at: 0, leg: 0, codec: 'G722', srtp: true });
    t.segDone(t.gw.last('segment').segment);
    t.ev.toolCall({ id: 'w3', name: 'warm_transfer', args: { destination: 'front_desk', reason: 'refill' } });
    t.segDone(t.gw.last('segment').segment);
    const d3 = t.gw.last('dial');
    t.s.onGwEvent({ type: 'leg_answered', at: 0, leg: 1, request_id: d3.request_id });
    t.timers.fire(); // hold timeout
    assert.deepStrictEqual(t.gw.last('hangup'), { type: 'hangup', leg: 1 });
    assert.strictEqual(t.gw.last('resume').leg, 0);
    assert.strictEqual(t.s.state().warm, null);
    t.s.finish('test');

    // Caller hangs up during the consult: staff leg hung up too.
    const c = makeSession();
    c.s.onGwEvent({ type: 'answered', at: 0, leg: 0, codec: 'G722', srtp: true });
    c.segDone(c.gw.last('segment').segment);
    c.ev.toolCall({ id: 'w4', name: 'warm_transfer', args: { destination: 'front_desk', reason: 'x' } });
    c.segDone(c.gw.last('segment').segment);
    const d4 = c.gw.last('dial');
    c.s.onGwEvent({ type: 'leg_answered', at: 0, leg: 1, request_id: d4.request_id });
    c.s.onGwEvent({ type: 'leg_hangup', at: 0, leg: 0, by: 'remote' });
    assert.deepStrictEqual(c.gw.last('hangup'), { type: 'hangup', leg: 1 });
    c.s.finish('test');
    console.log = origLog;
    ok('warm transfer: allow-list, hold line + hold + dial, model hears only staff, DTMF 1 -> resume + conference + agent leaves (audited); no answer and hold timeout bring the caller back; caller hang-up drops staff');
  }

  // ── 6b. Outside numbers: allow-list, guardrails, dial limits, masking ──────────────────────────────────
  {
    const dp = await import('../platform/modules/voice/dialplan');
    dp.resetRateLimits();
    const cls = (t: string) => dp.classifyTarget(t);
    assert.deepStrictEqual(cls('+1 (208) 555-0123'), { ok: true, kind: 'external', dial: '2085550123', masked: '...0123' });
    assert.strictEqual((cls('4501') as any).kind, 'internal');
    assert.strictEqual((cls('**4500') as any).kind, 'voicemail');
    for (const bad of ['911', '411', '9005551234', '2089761234', '0114420712345', '+442071234567', '8095551234', '5005551234', '*0101', '*72', '5551234']) {
      assert.ok(!cls(bad).ok, `${bad} must be refused`);
    }
    // Agent with the owner's test targets: an outside number and an internal extension (synthetic test numbers here).
    const cellAgent = {
      handoffs: [
        { id: 'owner_cell', label: 'Owner cell (test)', kind: 'transfer', target: '2085550123', description: 'Owner test' },
        { id: 'owner_desk', label: 'Owner desk', kind: 'transfer', target: '4501', description: 'Owner desk' },
        { id: 'stranger', label: 'Not allow-listed', kind: 'transfer', target: '4999', description: '' },
      ],
      dial_allow: ['2085550123', '4501'],
      max_dials_per_call: 2,
      max_dials_per_hour: 3,
      warm_transfer: { ...config.activeAgent().warm_transfer, enabled: true },
    };
    const v = config.validateAgent({ ...config.activeAgent(), ...cellAgent });
    assert.ok(v.ok, JSON.stringify(v));
    const tw = tools.warmDestinations((v as any).config).map((h: any) => h.id);
    assert.deepStrictEqual(tw, ['owner_cell', 'owner_desk'], 'warm transfer only to allow-listed destinations');
    const spec = tools.harnessToolSpecs((v as any).config).find((t) => t.name === 'warm_transfer')!;
    assert.ok(!JSON.stringify(spec).includes('2085550123'), 'the model sees destination IDs, never the numbers');

    console.log = capture;
    const a = makeSession((v as any).config);
    a.s.onGwEvent({ type: 'answered', at: 0, leg: 0, codec: 'PCMU', srtp: true });
    a.segDone(a.gw.last('segment').segment);
    a.ev.toolCall({ id: 'x1', name: 'warm_transfer', args: { destination: 'owner_cell', reason: 'test transfer' } });
    a.segDone(a.gw.last('segment').segment);
    assert.strictEqual(a.gw.last('dial').target, 'sip:2085550123@pbx.example.test');
    a.s.onGwEvent({ type: 'leg_failed', at: 0, leg: 1, request_id: a.gw.last('dial').request_id, code: 486, reason: 'rejected_486' });
    a.segDone(a.gw.last('segment').segment);
    a.ev.toolCall({ id: 'x2', name: 'warm_transfer', args: { destination: 'owner_desk', reason: 'test transfer' } });
    a.segDone(a.gw.last('segment').segment);
    assert.strictEqual(a.gw.last('dial').target, 'sip:4501@pbx.example.test');
    a.s.onGwEvent({ type: 'leg_failed', at: 0, leg: 2, request_id: a.gw.last('dial').request_id, code: 0, reason: 'no_answer' });
    a.segDone(a.gw.last('segment').segment);
    const dialsBefore = a.gw.all('dial').length;
    a.ev.toolCall({ id: 'x3', name: 'warm_transfer', args: { destination: 'owner_cell', reason: 'third try' } });
    assert.strictEqual(a.gw.all('dial').length, dialsBefore, 'third dial on one call refused');
    assert.ok(a.provider.results.find((r) => r.id === 'x3')!.output.includes('DIAL_LIMIT_CALL'));
    a.ev.toolCall({ id: 'x4', name: 'warm_transfer', args: { destination: 'stranger', reason: 'x' } });
    assert.ok(a.provider.results.find((r) => r.id === 'x4')!.output.includes('NOT_ALLOWED'));
    a.s.finish('test');
    // Hourly limit across calls: 2 used above, 1 left of 3.
    const b = makeSession((v as any).config);
    b.s.onGwEvent({ type: 'answered', at: 0, leg: 0, codec: 'PCMU', srtp: true });
    b.segDone(b.gw.last('segment').segment);
    b.ev.toolCall({ id: 'y1', name: 'transfer_to_staff', args: { destination: 'owner_cell' } });
    b.segDone(b.gw.last('segment').segment);
    assert.strictEqual(b.gw.last('transfer').target, 'sip:2085550123@pbx.example.test');
    b.s.finish('test');
    const c2 = makeSession((v as any).config);
    c2.s.onGwEvent({ type: 'answered', at: 0, leg: 0, codec: 'PCMU', srtp: true });
    c2.segDone(c2.gw.last('segment').segment);
    c2.ev.toolCall({ id: 'z1', name: 'transfer_to_staff', args: { destination: 'owner_cell' } });
    assert.ok(c2.provider.results.find((r) => r.id === 'z1')!.output.includes('DIAL_LIMIT_HOUR'));
    assert.ok(!c2.gw.last('transfer'));
    c2.ev.toolCall({ id: 'z2', name: 'transfer_to_staff', args: { destination: 'owner_desk' } });
    c2.segDone(c2.gw.last('segment').segment);
    assert.strictEqual(c2.gw.last('transfer').target, 'sip:4501@pbx.example.test', 'internal transfers are not outside dials');
    c2.s.finish('test');
    console.log = origLog;
    await audit.flushAudit();
    const auditText = fs.readFileSync(path.join(TMP, 'audit', `${audit.dayKey()}.jsonl`), 'utf8');
    assert.ok(!auditText.includes('2085550123'), 'full outside number never in the audit');
    assert.ok(auditText.includes('pstn:...0123') && auditText.includes('voice_dial_limit') && auditText.includes('DIAL_LIMIT_CALL'));
    assert.ok(!logLines.join('\n').includes('2085550123'), 'full outside number never in the server log');
    const rec = readVoiceCall(a.callId)!;
    assert.ok(!JSON.stringify(rec).includes('2085550123'), 'transcript keeps the last 4 digits only');
    dp.resetRateLimits();
    ok('outside numbers: NANP only (never international, premium, Caribbean, N11, 911, star codes), allow-list, model sees IDs not numbers, 2 dials per call, hourly cap with security event, last 4 digits only in audit/log/transcript');
  }

  // ── 7. The model never hears itself ────────────────────────────────────────────────────────────────────
  {
    console.log = capture;
    const { s, ev, provider, gw, segDone } = makeSession({ warm_transfer: { ...config.activeAgent().warm_transfer, agent_after_join: 'stay_muted' } }, { transcriber: true });
    s.onGwEvent({ type: 'answered', at: 0, leg: 0, codec: 'G722', srtp: true });
    segDone(gw.last('segment').segment);
    ev.responseStarted('r9');
    ev.audio(pcm(200, 24000, 999), 'r9');
    assert.ok(!provider.audioIn.some((b) => b.includes(pcm(20, 24000, 999))), 'agent audio never goes back to the model');
    ev.responseDone('r9', 'completed');
    ev.toolCall({ id: 'm1', name: 'warm_transfer', args: { destination: 'front_desk', reason: 'x' } });
    segDone(gw.last('segment').segment);
    const d = gw.last('dial');
    s.onGwEvent({ type: 'leg_answered', at: 0, leg: 1, request_id: d.request_id });
    ev.toolCall({ id: 'm2', name: 'connect_caller', args: {} });
    assert.deepStrictEqual(s.state().modelIn.sort(), [0, 1]);
    assert.strictEqual(s.state().agentMuted, true);
    provider.audioIn = [];
    s.onGwAudio(1, pcm(20, 24000, 300));
    s.onGwAudio(0, pcm(20, 24000, 100));
    assert.strictEqual(provider.audioIn.length, 1);
    assert.strictEqual(provider.audioIn[0].readInt16LE(0), 400, 'model gets caller + staff mixed');
    const before = gw.audio.length;
    ev.responseStarted('r10');
    ev.audio(pcm(100, 24000, 5), 'r10');
    assert.strictEqual(gw.audio.length, before, 'muted agent sends nothing');
    s.finish('test');
    console.log = origLog;
    ok('echo control: agent audio never fed back to the model; muted agent in a conference hears the two human legs mixed and sends nothing');
  }

  // ── 8. Call admission ───────────────────────────────────────────────────────────────────────────────────
  {
    console.warn = capture;
    console.log = capture;
    const { AGENT_TOOLS: AT } = require('../platform/agent-tools');
    const unityDefs = Object.keys(AT)
      .filter((n: string) => AT[n].server === 'unity')
      .map((n: string) => ({ name: n, inputSchema: { type: 'object', properties: Object.fromEntries(Object.keys(AT[n].p).map((p: string) => [p, { type: 'string' }])), required: [] } }));
    const deps = { runAgentTool: async () => ({}), toVoiceSummary: () => '', toolDefinitions: () => unityDefs as any, callStartVariables: () => ({ call_mode: 'BUSINESS_HOURS', records_status: 'UP', fhir_tools: 'OFF' }) };
    const promptFile = path.join(TMP, 'prompt.md');
    fs.writeFileSync(promptFile, 'Now: {{current_time_America/Boise}}. Line mode: {{call_mode}}. Records: {{records_status}}. Backup: {{fhir_tools}}. Type: {{call_type}}.');
    const start: any = { type: 'call_start', call_ref: 'gw9', from: '+12085550142', from_name: '', to: '4515', srtp: true, codecs: ['G722'], media_rule: 'srtp-required', registered: true };
    const allClips = (h: any) => (_a: any) => async (text: string) => Buffer.alloc(9600, 1);
    const mk = (env: any, provider: any) => {
      const h: any = new VoiceHarness(deps as any, { VOICE_ENABLED: 'on', VOICE_GW_SECRET: SECRET, CALL_RECORDS_DIR: TMP, SIP_REALM: 'pbx.example.test', VOICE_PROMPT_FILE: promptFile, ...env }, {
        provider: () => provider,
        tts: allClips(null) as any,
        transcriber: () => undefined,
      });
      return h;
    };
    const sent: any[] = [];
    const send = (c: any) => sent.push(c);
    let h = mk({}, new FakeProvider());
    assert.strictEqual(await h.admit({ ...start, srtp: false }, send), null);
    assert.deepStrictEqual(sent.pop(), { type: 'reject', code: 503, reason: 'no_srtp' });
    h = mk({}, null);
    assert.strictEqual(await h.admit(start, send), null);
    assert.strictEqual(sent.pop().reason, 'provider_not_configured');
    h = mk({}, new FakeProvider());
    h.deps = { ...deps, toolDefinitions: () => [] };
    h.clips = new scripts.ClipStore(path.join(TMP, 'clips-ok'));
    assert.strictEqual(await h.admit(start, send), null);
    assert.strictEqual(sent.pop().reason, 'tool_schema_drift');
    h = mk({}, new FakeProvider());
    h.factories.tts = () => async () => {
      throw new Error('tts down');
    };
    h.clips = new scripts.ClipStore(path.join(TMP, 'clips-empty'));
    assert.strictEqual(await h.admit(start, send), null);
    assert.strictEqual(sent.pop().reason, 'clips_missing');
    config.saveAgent({ ...config.activeAgent(), provider: 'elevenlabs', voice: 'abcdefgh1234', elevenlabs_agent_id: 'agent_12345678' } as any, 'admin1', true);
    h = mk({}, new FakeProvider(16000));
    assert.strictEqual(await h.admit(start, send), null);
    assert.strictEqual(sent.pop().reason, 'provider_without_baa');
    config.saveAgent({ ...config.activeAgent(), provider: 'openai', voice: 'marin', elevenlabs_agent_id: '' } as any, 'admin1', true);
    const fp = new FakeProvider();
    h = mk({}, fp);
    const sess = await h.admit({ ...start, srtp: false }, send).catch(() => null);
    assert.strictEqual(sess, null, 'still no SRTP');
    sent.length = 0;
    h = mk({ VOICE_ALLOW_PLAIN_RTP: 'synthetic-only' }, fp);
    const ok2 = await h.admit({ ...start, srtp: false }, send);
    assert.ok(ok2);
    const acc = sent.pop();
    assert.strictEqual(acc.type, 'accept');
    assert.ok(/^voice_[0-9a-f-]{36}$/.test(acc.call_id) && cb.normalizeCallId(acc.call_id) === acc.call_id);
    assert.strictEqual(acc.pcm_rate, 24000);
    assert.ok(!/\{\{/.test(fp.init.instructions) && fp.init.instructions.includes('Line mode: BUSINESS_HOURS') && fp.init.instructions.includes('Type: phone_call'));
    assert.ok(fp.init.instructions.includes('# THIS PHONE LINE'));
    assert.ok(fp.init.tools.some((t: any) => t.name === 'say_script'));
    ok2.finish('test');
    console.warn = origWarn;
    console.log = origLog;
    ok('admission: no SRTP, no key, missing clips, ElevenLabs without BAA refused; accepted calls get voice_<uuid> and the provider rate; prompt variables filled + voice-line rules');
  }

  // ── 9. OpenAI Realtime adapter (fake server) ────────────────────────────────────────────────────────────
  {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const got: any[] = [];
    let auth = '';
    wss.on('connection', (ws, req) => {
      auth = String(req.headers.authorization || '');
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        got.push(m);
        if (m.type === 'session.update') {
          ws.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));
          ws.send(JSON.stringify({ type: 'response.output_item.added', response_id: 'resp_1', item: { id: 'item_1', type: 'message' } }));
          ws.send(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: Buffer.alloc(480).toString('base64') }));
          ws.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call_x', name: 'unity_search_patients', arguments: '{"firstName":"Lucius"}' }));
          ws.send(JSON.stringify({ type: 'response.done', response: { id: 'resp_1', status: 'completed', output: [{ type: 'function_call', call_id: 'call_x', name: 'unity_search_patients', arguments: '{}' }] } }));
          ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello there' }));
          ws.send(JSON.stringify({ type: 'error', error: { code: 'invalid_value', message: 'quote of the patient said something' } }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    const a = new OpenAiRealtime('sk-test-not-real', `ws://127.0.0.1:${port}/v1/realtime`);
    const seen: any = { audio: 0, tools: [] as any[], caller: [] as string[], errors: [] as string[], done: [] as string[] };
    await a.connect(
      { model: 'gpt-realtime-2.1', voice: 'marin', instructions: 'hi', tools: [{ name: 'say_script', description: 'd', parameters: { type: 'object', properties: {} } }], language: 'en', turn: { vad: 'semantic_vad', eagerness: 'auto', silence_ms: 500 }, vars: {} },
      {
        audio: (b) => (seen.audio += b.length),
        agentTranscript: () => undefined,
        callerTranscript: (t) => seen.caller.push(t),
        speechStarted: () => undefined,
        speechStopped: () => undefined,
        toolCall: (c) => seen.tools.push(c),
        responseStarted: () => undefined,
        responseDone: (id) => seen.done.push(id),
        error: (code) => seen.errors.push(code),
        closed: () => undefined,
      }
    );
    await sleep(150);
    const su = got.find((m) => m.type === 'session.update').session;
    assert.strictEqual(auth, 'Bearer sk-test-not-real');
    assert.strictEqual(su.type, 'realtime');
    assert.deepStrictEqual(su.audio.input.format, { type: 'audio/pcm', rate: 24000 });
    assert.deepStrictEqual(su.audio.output.format, { type: 'audio/pcm', rate: 24000 });
    assert.strictEqual(su.audio.output.voice, 'marin');
    assert.strictEqual(su.audio.input.turn_detection.type, 'semantic_vad');
    assert.strictEqual(su.audio.input.turn_detection.interrupt_response, true);
    assert.strictEqual(su.tools[0].type, 'function');
    assert.strictEqual(seen.audio, 480);
    assert.strictEqual(seen.tools.length, 1, 'tool call reported once (done + response.done de-duplicated)');
    assert.deepStrictEqual(seen.tools[0].args, { firstName: 'Lucius' });
    assert.deepStrictEqual(seen.caller, ['hello there']);
    assert.deepStrictEqual(seen.errors, ['invalid_value'], 'error code only');
    a.sendToolResult('call_x', 'RESULT', true);
    a.truncate('resp_1', 640);
    a.addSystemNote('ORCHESTRATOR: note', false);
    a.sendAudio(Buffer.alloc(960));
    await sleep(100);
    const types = got.map((m) => m.type);
    assert.ok(types.includes('conversation.item.create') && types.includes('response.create') && types.includes('input_audio_buffer.append'));
    assert.deepStrictEqual(got.find((m) => m.type === 'conversation.item.truncate'), { type: 'conversation.item.truncate', item_id: 'item_1', content_index: 0, audio_end_ms: 640 });
    assert.ok(got.some((m) => m.type === 'conversation.item.create' && m.item.type === 'function_call_output' && m.item.call_id === 'call_x'));
    assert.ok(got.some((m) => m.type === 'conversation.item.create' && m.item.role === 'system'));
    a.close();
    wss.close();
    server.close();
    ok('OpenAI Realtime adapter: bearer header, session.update (24 kHz PCM, voice, semantic VAD with barge-in, function tools), audio/tool/transcript events, tool result + truncate + system note');
  }

  // ── 10. Prompt ─────────────────────────────────────────────────────────────────────────────────────────
  {
    const real = fs.readFileSync(path.join(process.cwd(), 'retell-prompts', 'unity-healthcare-agent.md'), 'utf8');
    const out = tools.renderPrompt(real + tools.VOICE_ADDENDUM, { 'current_time_America/Boise': 'Sunday, October 18, 2026 at 2:00 PM', call_mode: 'AFTER_HOURS', records_status: 'UP', fhir_tools: 'OFF', call_type: 'phone_call' });
    assert.ok(!/\{\{/.test(out));
    assert.ok(out.includes('Line mode: AFTER_HOURS') && out.includes('say_script EMERGENCY_911') && out.includes('Identity before information'));
    ok('prompt: the phone agent prompt with Retell variables filled and the voice-line rules appended');
  }

  console.log(`\nsmoke:voice-harness ${passed} checks passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((e) => {
  console.log = (console as any).__proto__.log;
  console.error('FAIL', e?.stack || e);
  process.exit(1);
});
