import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Wire protocol between the voice gateway container (deploy/voice-gw, Go) and this harness.
 *
 * Transport: WebSocket on the internal Docker network "voice" (VOICE_HARNESS_PORT, default 3010; never published
 * on the host, never proxied by nginx). Each connection is authenticated by the header
 *   X-Voice-Gw-Auth: v1,kind=<call|control>,ts=<unix s>,nonce=<32 hex>,mac=<hex HMAC-SHA256>
 * mac = HMAC(VOICE_GW_SECRET, "drawbridge-voice-gw|v1|<kind>|<ts>|<nonce>"), ts within 30 s, nonce never reused.
 *
 * Text frames are JSON (below). Binary frames: byte 0 = leg index, then PCM s16le mono at the session rate.
 *   gw -> harness: inbound audio of one human leg (0 = the caller, 1.. = legs the session dialled), 20 ms frames
 *   harness -> gw: agent audio for one leg, or leg 255 = every leg in the local conference
 */
export const AUTH_HEADER = 'x-voice-gw-auth';
export const ALL_CONFERENCE_LEGS = 255;
export const AUTH_WINDOW_S = 30;

export type GwKind = 'call' | 'control';

export interface CallStart {
  type: 'call_start';
  call_ref: string;
  from: string;
  from_name: string;
  to: string;
  srtp: boolean;
  codecs: string[];
  media_rule: string;
  registered: boolean;
}

export interface GwQuality {
  expected: number;
  received: number;
  loss_pct: number;
  jitter_ms: number;
  jitter_max_ms: number;
  rtt_ms: number;
  echo_gated_frames: number;
  echo_passed_frames: number;
}

/** gw -> harness events during a call. */
export interface GwEvent {
  type:
    | 'answered'
    | 'media_in'
    | 'media_warning'
    | 'dtmf'
    | 'playout_started'
    | 'playout_idle'
    | 'segment_done'
    | 'cleared'
    | 'transfer_progress'
    | 'transfer_result'
    | 'leg_dialing'
    | 'leg_ringing'
    | 'leg_answered'
    | 'leg_failed'
    | 'leg_hangup'
    | 'leg_quality'
    | 'hold_result'
    | 'resume_result'
    | 'conference_result'
    | 'media_update'
    | 'hangup'
    | 'pong';
  at: number;
  leg: number;
  request_id?: string;
  codec?: string;
  srtp?: boolean;
  digit?: string;
  segment?: string;
  played_ms?: number;
  latency_ms?: number;
  code?: number;
  reason?: string;
  by?: string;
  pkts_in?: number;
  pkts_out?: number;
  first_in_ms?: number;
  quality?: GwQuality;
}

/** harness -> gw commands. */
export type GwCommand =
  | { type: 'accept'; call_id: string; pcm_rate: number }
  | { type: 'reject'; code: 480 | 486 | 503 | 603; reason: string }
  | { type: 'segment'; leg: number; segment: string }
  | { type: 'segment_end'; leg: number; segment: string }
  | { type: 'clear'; leg: number }
  | { type: 'transfer'; leg: number; target?: string; replaces_leg?: number; request_id?: string }
  | { type: 'dial'; target: string; timeout_s: number; request_id: string; leg?: number }
  | { type: 'hold'; leg: number; request_id?: string }
  | { type: 'resume'; leg: number; request_id?: string }
  | { type: 'conference'; legs: number[]; request_id?: string }
  | { type: 'hangup'; leg: number }
  | { type: 'ping' };

/** Registration status from the control link (no secrets, no caller data). */
export interface GwStatus {
  type: 'status';
  registered: boolean;
  proxy: string;
  transport: string;
  tls_version: string;
  tls_cipher: string;
  tls_verified_name: string;
  public_ip: string;
  seen_as: string;
  expires_sec: number;
  last_error: string;
  registered_at: string;
  updated_at: string;
  active_calls: number;
  media_rule: string;
  mode: string;
}

export function authMac(secret: string, kind: string, ts: number, nonce: string): string {
  return createHmac('sha256', secret).update(`drawbridge-voice-gw|v1|${kind}|${ts}|${nonce}`).digest('hex');
}

/** Header value as the gateway sends it (tests and tools). */
export function authToken(secret: string, kind: GwKind, nowS: number, nonce: string): string {
  return `v1,kind=${kind},ts=${nowS},nonce=${nonce},mac=${authMac(secret, kind, nowS, nonce)}`;
}

/** Remembers nonces for the auth window (replay protection). */
export class NonceCache {
  private seen = new Map<string, number>();
  constructor(private readonly ttlMs = 2 * AUTH_WINDOW_S * 1000) {}
  /** true when new (and records it); false when seen within the window. */
  add(nonce: string, now = Date.now()): boolean {
    for (const [n, t] of this.seen) if (now - t > this.ttlMs) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now);
    return true;
  }
}

export type AuthCheck = { ok: true; kind: GwKind } | { ok: false; reason: string };

/** Verify the gateway's auth header. Constant-time MAC compare; never logs the secret or the MAC. */
export function verifyAuth(header: unknown, secret: string, nonces: NonceCache, nowMs = Date.now()): AuthCheck {
  if (!secret || secret.length < 32) return { ok: false, reason: 'not_configured' };
  if (typeof header !== 'string' || header.length > 400) return { ok: false, reason: 'missing' };
  const parts = header.split(',');
  if (parts[0] !== 'v1') return { ok: false, reason: 'version' };
  const kv: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i > 0) kv[p.slice(0, i)] = p.slice(i + 1);
  }
  const kind = kv.kind;
  if (kind !== 'call' && kind !== 'control') return { ok: false, reason: 'kind' };
  if (!/^\d{9,12}$/.test(kv.ts || '') || !/^[0-9a-f]{32}$/.test(kv.nonce || '') || !/^[0-9a-f]{64}$/.test(kv.mac || '')) {
    return { ok: false, reason: 'format' };
  }
  const ts = Number(kv.ts);
  if (Math.abs(nowMs / 1000 - ts) > AUTH_WINDOW_S) return { ok: false, reason: 'stale' };
  const want = Buffer.from(authMac(secret, kind, ts, kv.nonce), 'hex');
  const got = Buffer.from(kv.mac, 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'mac' };
  if (!nonces.add(kv.nonce, nowMs)) return { ok: false, reason: 'replay' };
  return { ok: true, kind };
}

export function encodeFrame(leg: number, pcm: Buffer): Buffer {
  const b = Buffer.allocUnsafe(pcm.length + 1);
  b[0] = leg & 0xff;
  pcm.copy(b, 1);
  return b;
}

export function decodeFrame(data: Buffer): { leg: number; pcm: Buffer } | null {
  if (!Buffer.isBuffer(data) || data.length < 3 || (data.length - 1) % 2 !== 0) return null;
  return { leg: data[0], pcm: data.subarray(1) };
}
