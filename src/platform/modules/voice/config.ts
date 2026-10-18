import * as fs from 'fs';
import * as path from 'path';
import { AGENT_TOOLS } from '../../agent-tools';

/**
 * Voice agent configuration (staff app, administrators only). Stored on the data volume next to the call records
 * (<CALL_RECORDS_DIR>/voice/agents.json, mode 0600). It never holds secrets: provider keys, SIP credentials and the
 * gateway secret stay in the environment (.env / SSM). Validation refuses anything that looks like a key.
 *
 * Handoff actions (Titan PBX, verified codes; owner Oct 18 2026). The agent can only use the actions listed on its
 * configuration, each one a fixed target:
 *   transfer     blind transfer (SIP REFER) to an extension, ring group or queue      target "4500"
 *   voicemail    straight to a voicemail box                                         target "**4500"
 *   park         park the caller for staff to pick up (*5 retrieves)                 target "*3"
 *   valet_park   valet park (the PBX assigns and announces a slot)                   target "*4"
 * Never available to the agent: *0 intercom (auto-answers a staff phone), *72/*73/*74/*56 call forwarding,
 * *67 privacy, *2 dynamic caller ID, *11/*12/*13 hot desking, *5 retrieve (staff side). No agent may change PBX
 * settings. Warm transfer dials only the internal extensions on `dial_allow` (2 to 8 digits, no star codes,
 * no external or international numbers).
 */
export type ProviderName = 'openai' | 'elevenlabs';
export type HandoffKind = 'transfer' | 'voicemail' | 'park' | 'valet_park';

export interface HandoffAction {
  id: string;
  label: string;
  kind: HandoffKind;
  target: string;
  /** When the model should use it (goes into the tool description). */
  description: string;
}

export interface WarmTransferConfig {
  enabled: boolean;
  /** conference: local 3-way in our gateway, then the agent leaves; attended_refer: REFER with Replaces (falls back to conference). */
  mode: 'conference' | 'attended_refer';
  ring_timeout_s: number;
  hold_timeout_s: number;
  agent_after_join: 'leave' | 'stay_muted';
  /** Keep transcribing the human legs after the agent left the conference (default off). */
  transcribe_after_agent_leaves: boolean;
}

export interface AgentConfig {
  id: string;
  name: string;
  provider: ProviderName;
  model: string;
  voice: string;
  language: string;
  /** 'default' = retell-prompts/unity-healthcare-agent.md + the harness addendum. */
  prompt_source: 'default' | 'custom';
  custom_prompt: string;
  enabled_tools: string[];
  handoffs: HandoffAction[];
  dial_allow: string[];
  warm_transfer: WarmTransferConfig;
  turn: { vad: 'semantic_vad' | 'server_vad'; eagerness: 'low' | 'medium' | 'high' | 'auto'; silence_ms: number };
  /** ElevenLabs Conversational AI agent that carries this configuration (non-secret ID). */
  elevenlabs_agent_id: string;
  updated_at: string;
  updated_by: string;
}

export interface AgentStore {
  active: string;
  agents: AgentConfig[];
}

/** Harness-only tools (run by the orchestrator, not by Veradigm). */
export const HARNESS_TOOLS = ['say_script', 'transfer_to_staff', 'warm_transfer', 'end_call'] as const;

/** The phone tools a voice agent may enable: the Retell agent's Unity tools (FHIR backups need the FHIR process). */
export const ENABLEABLE_TOOLS: string[] = [
  ...Object.entries(AGENT_TOOLS)
    .filter(([, t]) => t.server === 'unity')
    .map(([n]) => n),
  ...HARNESS_TOOLS,
];

/** Star codes that are never allowed as agent targets (PBX settings or staff-side features). */
export const FORBIDDEN_CODES = ['*0', '*2', '*5', '*11', '*12', '*13', '*56', '*67', '*72', '*73', '*74'];

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const EXT_RE = /^\d{2,8}$/;

const TARGET_RULES: Record<HandoffKind, RegExp> = {
  transfer: /^\d{2,8}$/,
  voicemail: /^\*\*\d{2,8}$/,
  park: /^\*3$/,
  valet_park: /^\*4$/,
};

/** Anything that looks like an API key or token: refused in every field. */
export function looksLikeSecret(v: string): boolean {
  return (
    /\bsk-[A-Za-z0-9_-]{16,}/.test(v) ||
    /\bsk_[A-Za-z0-9]{16,}/.test(v) ||
    /\bxi-api-key\b/i.test(v) ||
    /\b(api[_-]?key|password|secret|bearer)\s*[:=]\s*\S{8,}/i.test(v) ||
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(v)
  );
}

export function defaultAgent(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const front = String(env.VOICE_FRONT_DESK_EXT || '').trim();
  const handoffs: HandoffAction[] = [];
  if (EXT_RE.test(front)) {
    handoffs.push({ id: 'front_desk', label: 'Front desk', kind: 'transfer', target: front, description: 'A person at the front desk (default transfer).' });
    handoffs.push({ id: 'front_desk_voicemail', label: 'Front desk voicemail', kind: 'voicemail', target: `**${front}`, description: 'The caller wants to leave a voicemail for the front desk, or nobody can answer.' });
  }
  return {
    id: 'default',
    name: 'Phone assistant (voice harness)',
    provider: 'openai',
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    language: 'en',
    prompt_source: 'default',
    custom_prompt: '',
    enabled_tools: [...ENABLEABLE_TOOLS],
    handoffs,
    dial_allow: EXT_RE.test(front) ? [front] : [],
    warm_transfer: { enabled: EXT_RE.test(front), mode: 'conference', ring_timeout_s: 25, hold_timeout_s: 90, agent_after_join: 'leave', transcribe_after_agent_leaves: false },
    turn: { vad: 'semantic_vad', eagerness: 'auto', silence_ms: 500 },
    elevenlabs_agent_id: '',
    updated_at: '',
    updated_by: '',
  };
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 'on' || v === '1';
const int = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : d;
};

export type ValidationResult = { ok: true; config: AgentConfig } | { ok: false; errors: string[] };

/** Validate and normalise a configuration (from the admin form or the file). Fails closed. */
export function validateAgent(input: any): ValidationResult {
  const e: string[] = [];
  const c: any = input && typeof input === 'object' ? input : {};
  const out: AgentConfig = {
    id: str(c.id, 40).toLowerCase(),
    name: str(c.name, 80),
    provider: c.provider,
    model: str(c.model, 64),
    voice: str(c.voice, 64),
    language: str(c.language, 8) || 'en',
    prompt_source: c.prompt_source === 'custom' ? 'custom' : 'default',
    custom_prompt: typeof c.custom_prompt === 'string' ? c.custom_prompt.slice(0, 20_000) : '',
    enabled_tools: Array.isArray(c.enabled_tools) ? c.enabled_tools.map((t: unknown) => str(t, 64)).filter(Boolean) : [],
    handoffs: [],
    dial_allow: Array.isArray(c.dial_allow) ? c.dial_allow.map((x: unknown) => str(x, 12)).filter(Boolean) : [],
    warm_transfer: {
      enabled: bool(c.warm_transfer?.enabled),
      mode: c.warm_transfer?.mode === 'attended_refer' ? 'attended_refer' : 'conference',
      ring_timeout_s: int(c.warm_transfer?.ring_timeout_s, 25),
      hold_timeout_s: int(c.warm_transfer?.hold_timeout_s, 90),
      agent_after_join: c.warm_transfer?.agent_after_join === 'stay_muted' ? 'stay_muted' : 'leave',
      transcribe_after_agent_leaves: bool(c.warm_transfer?.transcribe_after_agent_leaves),
    },
    turn: {
      vad: c.turn?.vad === 'server_vad' ? 'server_vad' : 'semantic_vad',
      eagerness: ['low', 'medium', 'high', 'auto'].includes(c.turn?.eagerness) ? c.turn.eagerness : 'auto',
      silence_ms: int(c.turn?.silence_ms, 500),
    },
    elevenlabs_agent_id: str(c.elevenlabs_agent_id, 64),
    updated_at: str(c.updated_at, 40),
    updated_by: str(c.updated_by, 64),
  };
  if (!ID_RE.test(out.id)) e.push('id: lower-case letters, digits, - or _ (max 40)');
  if (!out.name) e.push('name is required');
  if (out.provider !== 'openai' && out.provider !== 'elevenlabs') e.push('provider must be openai or elevenlabs');
  if (!MODEL_RE.test(out.model)) e.push('model: letters, digits, . _ : - only');
  if (!MODEL_RE.test(out.voice)) e.push('voice: letters, digits, . _ : - only');
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(out.language)) e.push('language: ISO code like en');
  if (out.prompt_source === 'custom' && out.custom_prompt.trim().length < 200) e.push('custom prompt is too short (it must carry the safety rules)');
  if (out.provider === 'elevenlabs' && out.elevenlabs_agent_id && !/^[A-Za-z0-9_-]{8,64}$/.test(out.elevenlabs_agent_id)) e.push('ElevenLabs agent ID format');
  for (const t of out.enabled_tools) if (!ENABLEABLE_TOOLS.includes(t)) e.push(`unknown tool ${t}`);
  if (!out.enabled_tools.includes('say_script')) e.push('say_script must stay enabled (exact safety lines)');
  out.enabled_tools = [...new Set(out.enabled_tools)];
  const ids = new Set<string>();
  for (const h of Array.isArray(c.handoffs) ? c.handoffs : []) {
    const a: HandoffAction = { id: str(h?.id, 40).toLowerCase(), label: str(h?.label, 60), kind: h?.kind, target: str(h?.target, 12), description: str(h?.description, 200) };
    if (!ID_RE.test(a.id) || ids.has(a.id)) e.push(`handoff id ${a.id || '(empty)'} invalid or duplicate`);
    ids.add(a.id);
    if (!TARGET_RULES[a.kind as HandoffKind]) e.push(`handoff ${a.id}: kind must be transfer, voicemail, park or valet_park`);
    else if (!TARGET_RULES[a.kind].test(a.target)) e.push(`handoff ${a.id}: target ${a.target} not allowed for ${a.kind}`);
    // Belt and braces: the per-kind patterns already exclude these.
    if (FORBIDDEN_CODES.some((f) => a.target === f || (a.target.startsWith('*') && !a.target.startsWith('**') && a.target.length > 2))) e.push(`handoff ${a.id}: ${a.target} is never allowed`);
    if (!a.label) e.push(`handoff ${a.id}: label required`);
    out.handoffs.push(a);
  }
  if (out.handoffs.length > 12) e.push('at most 12 handoff actions');
  for (const x of out.dial_allow) if (!EXT_RE.test(x)) e.push(`dial allow-list entry ${x}: internal extension/group numbers only (2-8 digits)`);
  out.dial_allow = [...new Set(out.dial_allow)];
  if (out.warm_transfer.enabled && out.dial_allow.length === 0) e.push('warm transfer needs at least one allowed extension');
  if (out.warm_transfer.ring_timeout_s < 5 || out.warm_transfer.ring_timeout_s > 60) e.push('ring timeout 5..60 s');
  if (out.warm_transfer.hold_timeout_s < 15 || out.warm_transfer.hold_timeout_s > 300) e.push('hold timeout 15..300 s');
  if (out.turn.silence_ms < 200 || out.turn.silence_ms > 2000) e.push('silence 200..2000 ms');
  // No secrets anywhere in the configuration.
  if (looksLikeSecret(JSON.stringify(out))) e.push('the configuration contains something that looks like a key or password; keys belong in the environment only');
  return e.length ? { ok: false, errors: e } : { ok: true, config: out };
}

// ── Store ────────────────────────────────────────────────────────────────────────────────────────────────────

export function voiceDir(): string {
  return path.join(process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data'), 'voice');
}
const storeFile = () => path.join(voiceDir(), 'agents.json');

export function loadAgents(env: NodeJS.ProcessEnv = process.env): AgentStore {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    const agents: AgentConfig[] = [];
    for (const a of Array.isArray(raw?.agents) ? raw.agents : []) {
      const v = validateAgent(a);
      if (v.ok) agents.push(v.config);
      else console.warn(`[Voice] stored agent ${String(a?.id || '?').slice(0, 40)} is invalid and ignored`);
    }
    if (agents.length) return { active: agents.some((a) => a.id === raw.active) ? raw.active : agents[0].id, agents };
  } catch {
    // no file yet
  }
  const d = defaultAgent(env);
  return { active: d.id, agents: [d] };
}

export function saveAgent(cfg: AgentConfig, user: string, makeActive: boolean): AgentStore {
  const store = loadAgents();
  const v = validateAgent({ ...cfg, updated_at: new Date().toISOString(), updated_by: user });
  if (!v.ok) throw new Error(v.errors.join('; '));
  const i = store.agents.findIndex((a) => a.id === v.config.id);
  if (i >= 0) store.agents[i] = v.config;
  else store.agents.push(v.config);
  if (makeActive) store.active = v.config.id;
  fs.mkdirSync(voiceDir(), { recursive: true, mode: 0o700 });
  const tmp = `${storeFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storeFile());
  return store;
}

export function activeAgent(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const store = loadAgents(env);
  const want = String(env.VOICE_AGENT_ID || '').trim() || store.active;
  return store.agents.find((a) => a.id === want) || store.agents[0];
}
