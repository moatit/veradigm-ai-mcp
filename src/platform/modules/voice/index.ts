import { Router } from 'express';
import { PlatformModule } from '../../registry';
import { APP_BASE, esc, page, requireAdmin } from '../../shell';
import { startDailyRetention } from '../../retention';
import { AgentConfig, ENABLEABLE_TOOLS, HandoffAction, loadAgents, saveAgent, validateAgent } from './config';
import { getVoiceHarness } from './gw-server';
import { listVoiceCalls, pruneVoiceCalls, readVoiceCall } from './transcript';

export { startVoiceHarness } from './gw-server';

/**
 * Phone agent (voice harness) screens, administrators only (privacy or security officer, users file role=admin):
 *  - gateway status (registration, TLS, media rule), the agent configuration form (no secrets: keys stay in .env),
 *  - recent voice calls with turn latency, and one call's transcript (PHI: every view is in the access audit).
 */
const BASE = `${APP_BASE}/voice`;

function handoffLines(h: HandoffAction[]): string {
  return h.map((a) => [a.id, a.label, a.kind, a.target, a.description].join(' | ')).join('\n');
}

function parseHandoffs(text: string): any[] {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, label, kind, target, ...rest] = l.split('|').map((x) => x.trim());
      return { id, label, kind, target, description: rest.join(' | ') };
    });
}

function statusCard(): string {
  const h = getVoiceHarness();
  if (!h) return '<div class="card">Voice harness is off on this server (VOICE_ENABLED is not on).</div>';
  const s = h.status;
  if (!s) return '<div class="card">Voice harness is on; no status from the gateway yet.</div>';
  const age = Math.round((Date.now() - h.statusAt) / 1000);
  return `<div class="card"><strong>Extension: ${s.registered ? 'registered' : 'NOT registered'}</strong>
  <div class="muted" style="font-size:13px">Signalling ${esc(s.transport.toUpperCase())} ${esc(s.tls_version)} (${esc(s.tls_cipher)}), certificate name ${esc(s.tls_verified_name)};
  media rule ${esc(s.media_rule)}; calls in progress ${h.activeCalls()}; ${s.last_error ? `last error ${esc(s.last_error)}; ` : ''}updated ${age} s ago.</div></div>`;
}

function form(a: AgentConfig, errors: string[] = []): string {
  const tools = ENABLEABLE_TOOLS.map(
    (t) => `<label style="display:inline-block;min-width:260px"><input type="checkbox" name="tool" value="${esc(t)}" ${a.enabled_tools.includes(t) ? 'checked' : ''}> ${esc(t)}</label>`
  ).join('');
  const opt = (v: string, cur: string, label = v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  return `<form method="post" action="${BASE}/agent" class="card">
  <h3 style="margin-top:0">Agent configuration</h3>
  ${errors.length ? `<div class="card" style="border-color:#c00"><strong>Not saved:</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
  <input type="hidden" name="id" value="${esc(a.id)}">
  <label>Name <input name="name" value="${esc(a.name)}"></label>
  <label>Provider <select name="provider">${opt('openai', a.provider, 'OpenAI Realtime')}${opt('elevenlabs', a.provider, 'ElevenLabs Conversational AI (no BAA: synthetic tests only)')}</select></label>
  <label>Model <input name="model" value="${esc(a.model)}"></label>
  <label>Voice <input name="voice" value="${esc(a.voice)}"></label>
  <label>ElevenLabs agent ID <input name="elevenlabs_agent_id" value="${esc(a.elevenlabs_agent_id)}"></label>
  <label>Prompt <select name="prompt_source">${opt('default', a.prompt_source, 'Default (phone agent prompt + voice line rules)')}${opt('custom', a.prompt_source, 'Custom')}</select></label>
  <label>Custom prompt (only with "Custom"; must keep the safety rules)<textarea name="custom_prompt" rows="6" style="width:100%">${esc(a.custom_prompt)}</textarea></label>
  <fieldset><legend>Tools</legend>${tools}</fieldset>
  <label>Handoff actions, one per line: id | label | kind (transfer, voicemail, park, valet_park) | target (4500, **4500, *3, *4) | when to use
  <textarea name="handoffs" rows="4" style="width:100%;font-family:monospace">${esc(handoffLines(a.handoffs))}</textarea></label>
  <label>Warm transfer: extensions the agent may dial (comma-separated, internal only) <input name="dial_allow" value="${esc(a.dial_allow.join(', '))}"></label>
  <label><input type="checkbox" name="warm_enabled" ${a.warm_transfer.enabled ? 'checked' : ''}> Warm transfer enabled</label>
  <label>Mode <select name="warm_mode">${opt('conference', a.warm_transfer.mode, 'Local conference')}${opt('attended_refer', a.warm_transfer.mode, 'Attended transfer (REFER/Replaces), conference if refused')}</select></label>
  <label>Ring timeout (s) <input name="ring_timeout_s" value="${a.warm_transfer.ring_timeout_s}" size="4"></label>
  <label>Hold timeout (s) <input name="hold_timeout_s" value="${a.warm_transfer.hold_timeout_s}" size="4"></label>
  <label>After staff joins <select name="agent_after_join">${opt('leave', a.warm_transfer.agent_after_join, 'Agent leaves')}${opt('stay_muted', a.warm_transfer.agent_after_join, 'Agent stays, muted')}</select></label>
  <label><input type="checkbox" name="transcribe_after" ${a.warm_transfer.transcribe_after_agent_leaves ? 'checked' : ''}> Keep transcribing after the agent leaves</label>
  <label>Turn detection <select name="vad">${opt('semantic_vad', a.turn.vad)}${opt('server_vad', a.turn.vad)}</select></label>
  <label>Eagerness <select name="eagerness">${['auto', 'low', 'medium', 'high'].map((e) => opt(e, a.turn.eagerness)).join('')}</select></label>
  <label>Silence (ms, server_vad) <input name="silence_ms" value="${a.turn.silence_ms}" size="5"></label>
  <p class="muted" style="font-size:12px">No keys or passwords here: provider keys, SIP credentials and the gateway secret live in the server environment only. Last saved ${esc(a.updated_at || 'never')} ${a.updated_by ? `by ${esc(a.updated_by)}` : ''}.</p>
  <button type="submit">Save and make active</button>
</form>`;
}

function fromForm(b: any, prev: AgentConfig): any {
  const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  return {
    ...prev,
    id: prev.id,
    name: b.name,
    provider: b.provider,
    model: b.model,
    voice: b.voice,
    elevenlabs_agent_id: b.elevenlabs_agent_id || '',
    prompt_source: b.prompt_source,
    custom_prompt: b.custom_prompt || '',
    enabled_tools: list(b.tool),
    handoffs: parseHandoffs(b.handoffs),
    dial_allow: String(b.dial_allow || '').split(',').map((x) => x.trim()).filter(Boolean),
    warm_transfer: {
      enabled: !!b.warm_enabled,
      mode: b.warm_mode,
      ring_timeout_s: b.ring_timeout_s,
      hold_timeout_s: b.hold_timeout_s,
      agent_after_join: b.agent_after_join,
      transcribe_after_agent_leaves: !!b.transcribe_after,
    },
    turn: { vad: b.vad, eagerness: b.eagerness, silence_ms: b.silence_ms },
  };
}

function callsTable(): string {
  const rows = listVoiceCalls(50);
  if (!rows.length) return '<div class="card muted">No voice calls yet.</div>';
  return `<div class="card"><h3 style="margin-top:0">Recent voice calls</h3><table><tr><th>Started</th><th>Caller</th><th>Provider</th><th>Turns</th><th>p50 reply (ms)</th><th>Ended</th><th></th></tr>
${rows
  .map(
    (r) => `<tr><td>${esc(r.started_at.replace('T', ' ').slice(0, 19))}</td><td>...${esc(r.caller_last4)}</td><td>${esc(r.provider)}</td><td>${r.turns}</td><td>${r.p50_ms ?? '-'}</td><td>${esc(r.end_reason || 'in progress')}</td>
<td><a href="${BASE}/calls/${encodeURIComponent(r.call_id)}">Transcript</a></td></tr>`
  )
  .join('')}</table></div>`;
}

export const voiceModule: PlatformModule = {
  name: 'voice',
  nav: { path: '/voice', label: 'Phone agent (voice)', order: 70 },
  appRouter() {
    const router = Router();
    router.use(requireAdmin);
    router.get('/', (req, res) => {
      const store = loadAgents();
      const a = store.agents.find((x) => x.id === store.active) || store.agents[0];
      res.send(page('Phone agent · Drawbridge', `<h2>Phone agent (voice harness)</h2>${statusCard()}${form(a)}${callsTable()}`, { user: (req as any).drawbridgeUser, active: '/voice' }));
    });
    router.post('/agent', (req, res) => {
      const store = loadAgents();
      const prev = store.agents.find((x) => x.id === store.active) || store.agents[0];
      const next = fromForm(req.body || {}, prev);
      const v = validateAgent(next);
      if (!v.ok) {
        res.status(400).send(page('Phone agent · Drawbridge', `<h2>Phone agent (voice harness)</h2>${form({ ...prev, ...next }, v.errors)}`, { user: (req as any).drawbridgeUser, active: '/voice' }));
        return;
      }
      saveAgent(v.config, String((req as any).drawbridgeUser || ''), true);
      const h = getVoiceHarness();
      if (h) void h.prepareClips(v.config);
      res.redirect(303, BASE);
    });
    router.get('/calls/:id', (req, res) => {
      const rec = readVoiceCall(req.params.id);
      if (!rec) {
        res.status(404).send(page('Not found · Drawbridge', '<div class="card">No such voice call.</div>', { user: (req as any).drawbridgeUser }));
        return;
      }
      res.locals.auditObject = `voice_call:${rec.call_id}`;
      const lines = rec.entries
        .map((e) => {
          const who = e.kind === 'tool' ? `tool ${esc(e.tool || '')}` : e.kind === 'event' ? 'event' : esc(e.speaker);
          const body = e.kind === 'tool' ? (e.ok ? 'ok' : `failed ${esc(e.text)}`) : esc(e.text);
          return `<tr><td class="muted">${(e.ms / 1000).toFixed(1)} s</td><td><strong>${who}</strong>${e.script ? ` <span class="muted">[${esc(e.script)}]</span>` : ''}${e.truncated ? ' <span class="muted">(cut off)</span>' : ''}</td><td>${body}</td></tr>`;
        })
        .join('');
      const lat = rec.turns.map(
        (t) =>
          `${t.kind}: first audio ${t.e2e_ms ?? '-'} ms (model ${t.provider_ms ?? '-'} ms)${typeof t.answer_ms === 'number' ? `, answer ${t.answer_ms} ms` : ''}${t.tools.length ? ` [${t.tools.map((x) => `${esc(x.name)} ${x.ms} ms`).join(', ')}]` : ''}`
      );
      res.send(
        page(
          'Voice call · Drawbridge',
          `<h2>Voice call ${esc(rec.call_id)}</h2>
<div class="card">Caller ...${esc(rec.caller_last4)} · ${esc(rec.provider)} ${esc(rec.model)} (${esc(rec.voice)}) · media ${esc(rec.media.codec)} ${rec.media.srtp ? 'SRTP' : '<strong>unencrypted RTP</strong>'} · ${esc(rec.started_at)} to ${esc(rec.ended_at || 'now')} · ${esc(rec.end_reason)}</div>
<div class="card"><h3 style="margin-top:0">Transcript</h3><table>${lines}</table></div>
<div class="card"><h3 style="margin-top:0">Turn latency (caller end of speech to first agent audio)</h3>${lat.length ? `<ul>${lat.map((l) => `<li>${l}</li>`).join('')}</ul>` : '<span class="muted">none</span>'}</div>`,
          { user: (req as any).drawbridgeUser, active: '/voice' }
        )
      );
    });
    return router;
  },
  start() {
    startDailyRetention('voice calls', () => pruneVoiceCalls());
  },
};
