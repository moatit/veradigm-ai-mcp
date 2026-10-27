import * as fs from 'fs';
import * as path from 'path';
import { voiceDir } from './config';

/**
 * Per-call usage and estimated cost (counts only: no transcript text, no patient data).
 *
 *  - Realtime model: every response.done `usage` summed, split into text / audio, cached / uncached input, output.
 *  - Transcription: per leg (caller, each staff leg), the audio seconds sent to the transcription model and the usage
 *    the session reports (tokens or duration).
 *  - Cost: from the price table in <CALL_RECORDS_DIR>/voice/prices.json (USD), seeded once from SEED_PRICES and then
 *    edited on /app/voice: prices change without a code change. The record keeps the prices it used.
 */
export interface RealtimeUsage {
  responses: number;
  input_text_uncached: number;
  input_text_cached: number;
  input_audio_uncached: number;
  input_audio_cached: number;
  output_text: number;
  output_audio: number;
}

export interface TranscriptionUsage {
  model: string;
  /** Audio seconds we sent to the transcription model for this leg. */
  audio_seconds: number;
  /** As the session reported it (OpenAI: tokens or duration). */
  reported_seconds: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ModelPrices {
  /** USD per 1M tokens */
  audio_input: number;
  audio_cached: number;
  audio_output: number;
  text_input: number;
  text_cached: number;
  text_output: number;
}

export interface PriceTable {
  currency: 'USD';
  updated_at: string;
  realtime: Record<string, ModelPrices>;
  /** USD per minute of audio */
  transcription_per_minute: Record<string, number>;
}

export interface CallUsage {
  model: string;
  realtime: RealtimeUsage;
  transcription: Record<string, TranscriptionUsage>;
  duration_s: number;
  cost?: {
    realtime_usd: number;
    transcription_usd: number;
    total_usd: number;
    per_minute_usd: number;
    priced: boolean;
    prices: { realtime?: ModelPrices; transcription_per_minute?: Record<string, number> };
  };
}

/** Seed values (owner, Oct 18 2026). The live table is the prices.json file. */
export const SEED_PRICES: PriceTable = {
  currency: 'USD',
  updated_at: '2026-10-18',
  realtime: {
    'gpt-realtime-2.1': { audio_input: 32, audio_cached: 0.4, audio_output: 64, text_input: 4, text_cached: 0.4, text_output: 24 },
    'gpt-realtime-2.1-mini': { audio_input: 10, audio_cached: 0.3, audio_output: 20, text_input: 0.6, text_cached: 0.06, text_output: 2.4 },
  },
  transcription_per_minute: { 'gpt-4o-transcribe': 0.006 },
};

const pricesFile = () => path.join(voiceDir(), 'prices.json');

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

export function validatePrices(p: any): { ok: true; table: PriceTable } | { ok: false; error: string } {
  if (!p || typeof p !== 'object' || typeof p.realtime !== 'object' || typeof p.transcription_per_minute !== 'object') return { ok: false, error: 'needs realtime and transcription_per_minute' };
  const realtime: Record<string, ModelPrices> = {};
  for (const [m, v] of Object.entries<any>(p.realtime)) {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(m)) return { ok: false, error: `model name ${m.slice(0, 40)}` };
    const keys: Array<keyof ModelPrices> = ['audio_input', 'audio_cached', 'audio_output', 'text_input', 'text_cached', 'text_output'];
    const mp: any = {};
    for (const k of keys) {
      if (typeof v?.[k] !== 'number' || !(v[k] >= 0) || v[k] > 10_000) return { ok: false, error: `${m}.${k} must be a number (USD per 1M tokens)` };
      mp[k] = v[k];
    }
    realtime[m] = mp;
  }
  const tpm: Record<string, number> = {};
  for (const [m, v] of Object.entries<any>(p.transcription_per_minute)) {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(m) || typeof v !== 'number' || !(v >= 0) || v > 100) return { ok: false, error: `transcription price ${m.slice(0, 40)}` };
    tpm[m] = v;
  }
  return { ok: true, table: { currency: 'USD', updated_at: String(p.updated_at || new Date().toISOString().slice(0, 10)).slice(0, 32), realtime, transcription_per_minute: tpm } };
}

export function loadPrices(): PriceTable {
  try {
    const v = validatePrices(JSON.parse(fs.readFileSync(pricesFile(), 'utf8')));
    if (v.ok) return v.table;
    console.warn('[Voice] prices.json is invalid; using the seed prices');
  } catch {
    savePrices(SEED_PRICES);
  }
  return SEED_PRICES;
}

export function savePrices(t: PriceTable): void {
  try {
    fs.mkdirSync(voiceDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${pricesFile()}.tmp`, JSON.stringify(t, null, 2), { mode: 0o600 });
    fs.renameSync(`${pricesFile()}.tmp`, pricesFile());
  } catch (e: any) {
    console.error(`[Voice] prices.json write failed: ${e?.code || 'error'}`);
  }
}

export function emptyRealtime(): RealtimeUsage {
  return { responses: 0, input_text_uncached: 0, input_text_cached: 0, input_audio_uncached: 0, input_audio_cached: 0, output_text: 0, output_audio: 0 };
}

/** Add one OpenAI response.done `usage` object. */
export function addRealtimeUsage(u: RealtimeUsage, usage: any): void {
  if (!usage || typeof usage !== 'object') return;
  const inD = usage.input_token_details || {};
  const cached = inD.cached_tokens_details || {};
  const outD = usage.output_token_details || {};
  const cachedText = num(cached.text_tokens);
  const cachedAudio = num(cached.audio_tokens);
  u.responses++;
  u.input_text_cached += cachedText;
  u.input_audio_cached += cachedAudio;
  u.input_text_uncached += Math.max(0, num(inD.text_tokens) - cachedText);
  u.input_audio_uncached += Math.max(0, num(inD.audio_tokens) - cachedAudio);
  u.output_text += num(outD.text_tokens);
  u.output_audio += num(outD.audio_tokens);
}

export function emptyTranscription(model: string): TranscriptionUsage {
  return { model, audio_seconds: 0, reported_seconds: 0, input_tokens: 0, output_tokens: 0 };
}

/** Add a transcription usage report (OpenAI: { type: 'tokens', ... } or { type: 'duration', seconds }). */
export function addTranscriptionUsage(t: TranscriptionUsage, usage: any): void {
  if (!usage || typeof usage !== 'object') return;
  if (usage.type === 'duration') t.reported_seconds += num(usage.seconds);
  else {
    t.input_tokens += num(usage.input_tokens);
    t.output_tokens += num(usage.output_tokens);
  }
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function priceCall(u: CallUsage, table: PriceTable = loadPrices()): NonNullable<CallUsage['cost']> {
  const p = table.realtime[u.model];
  const r = u.realtime;
  const realtime = p
    ? (r.input_audio_uncached * p.audio_input +
        r.input_audio_cached * p.audio_cached +
        r.output_audio * p.audio_output +
        r.input_text_uncached * p.text_input +
        r.input_text_cached * p.text_cached +
        r.output_text * p.text_output) /
      1e6
    : 0;
  let transcription = 0;
  let tPriced = true;
  const used: Record<string, number> = {};
  for (const t of Object.values(u.transcription)) {
    const per = table.transcription_per_minute[t.model];
    if (per === undefined) {
      tPriced = tPriced && t.audio_seconds === 0;
      continue;
    }
    used[t.model] = per;
    // Billed audio: what the provider reported when it reported seconds, else what we sent.
    const secs = t.reported_seconds > 0 ? t.reported_seconds : t.audio_seconds;
    transcription += (secs / 60) * per;
  }
  const total = realtime + transcription;
  const minutes = u.duration_s / 60;
  return {
    realtime_usd: round6(realtime),
    transcription_usd: round6(transcription),
    total_usd: round6(total),
    per_minute_usd: minutes > 0 ? round6(total / minutes) : 0,
    priced: !!p && tPriced,
    prices: { realtime: p, transcription_per_minute: used },
  };
}
