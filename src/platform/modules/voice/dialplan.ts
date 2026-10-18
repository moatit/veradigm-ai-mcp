import { transportsFromEnv } from '../../helpdesk';
import { securityEvent } from '../../security-events';

/**
 * What the agent may dial or transfer to (owner decision, Oct 18 2026): internal extensions/queues/groups, the
 * allowed handoff codes, and outside numbers in the US/NANP, under guardrails. Checked here (agent configuration and
 * every call) and again in the gateway (deploy/voice-gw/config.go) before any SIP request goes out.
 *
 * Always blocked, whatever the configuration says:
 *  - international: 011..., +<not 1>, and NANP area codes that are other countries (Caribbean, Bermuda: billed as
 *    international, a classic toll-fraud route);
 *  - premium / pay-per-call: area code 900, exchange 976, personal-communications 5XX codes, 700;
 *  - N11 service codes (211..911) and 911/933 emergency: the agent never dials 911; it tells the caller to hang up and
 *    call 911 (EMERGENCY_911 clip);
 *  - star codes other than the handoff codes (**ext voicemail, *3 park, *4 valet park).
 * Rate limits: dials per call (default 2) and per hour per agent (default 20), with a help-desk alert when hit.
 */
export type TargetKind = 'internal' | 'external' | 'voicemail' | 'park' | 'valet_park';
export type Classified = { ok: true; kind: TargetKind; dial: string; masked: string } | { ok: false; reason: string };

/** NANP area codes outside the US (and its territories) and Canada: international rates. */
const FOREIGN_NANP = new Set([
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721', '758', '767', '784', '809', '829', '849', '868', '869', '876',
]);
const PREMIUM_NPA = new Set(['900', '700', '500', '521', '522', '523', '524', '525', '526', '527', '528', '529', '533', '544', '566', '577', '588', '976']);

export const mask = (digits: string): string => (digits.length > 4 ? `...${digits.slice(-4)}` : digits);

/** Classify one configured target ("4500", "**4500", "*3", "*4", "2087760388", "12087760388", "+12087760388"). */
export function classifyTarget(raw: string): Classified {
  const t = String(raw || '').trim().replace(/[\s().-]/g, '');
  if (/^\*\*\d{2,8}$/.test(t)) return { ok: true, kind: 'voicemail', dial: t, masked: t };
  if (t === '*3') return { ok: true, kind: 'park', dial: t, masked: t };
  if (t === '*4') return { ok: true, kind: 'valet_park', dial: t, masked: t };
  if (t.startsWith('*') || t.includes('#')) return { ok: false, reason: 'star codes other than **ext, *3 and *4 are never allowed' };
  if (/^011/.test(t) || (/^\+/.test(t) && !/^\+1/.test(t))) return { ok: false, reason: 'international numbers are never allowed' };
  const digits = t.replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return { ok: false, reason: 'digits only' };
  if (/^(911|933|112|999)$/.test(digits)) return { ok: false, reason: 'emergency numbers are never dialled by the agent' };
  if (/^[2-9]11$/.test(digits)) return { ok: false, reason: 'N11 service codes are never allowed' };
  if (digits.length >= 2 && digits.length <= 8 && !/^1?[2-9]\d{2}[2-9]\d{2}/.test(digits)) {
    if (digits.length === 7) return { ok: false, reason: '7-digit local numbers are not allowed; use the 10-digit number' };
    return { ok: true, kind: 'internal', dial: digits, masked: digits };
  }
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return { ok: false, reason: 'outside numbers must be 10-digit US/NANP numbers' };
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return { ok: false, reason: 'not a valid NANP number' };
  const npa = ten.slice(0, 3);
  const nxx = ten.slice(3, 6);
  if (FOREIGN_NANP.has(npa)) return { ok: false, reason: 'NANP area code outside the US/Canada (international rates)' };
  if (PREMIUM_NPA.has(npa) || nxx === '976') return { ok: false, reason: 'premium-rate numbers are never allowed' };
  if (/^[2-9]11$/.test(nxx) && npa !== nxx) return { ok: false, reason: 'N11 exchange' };
  return { ok: true, kind: 'external', dial: ten, masked: mask(ten) };
}

/** May this agent dial `target` (already classified) under its allow-list? */
export function allowedByList(c: Classified, allow: string[], allowAnyNanp: boolean): boolean {
  if (!c.ok) return false;
  if (c.kind === 'external' && allowAnyNanp) return true;
  return allow.some((a) => {
    const x = classifyTarget(a);
    return x.ok && x.dial === c.dial;
  });
}

// ── Rate limits ──────────────────────────────────────────────────────────────────────────────────────────────

const hourly = new Map<string, number[]>();
const alerted = new Map<string, number>();

export function dialsInLastHour(agentId: string, now = Date.now()): number {
  return (hourly.get(agentId) || []).filter((t) => now - t < 3_600_000).length;
}

/** Count one dial-out for the agent; false when the hourly limit is reached (the dial must not happen). */
export function takeHourlySlot(agentId: string, limit: number, now = Date.now()): boolean {
  const list = (hourly.get(agentId) || []).filter((t) => now - t < 3_600_000);
  if (list.length >= limit) {
    hourly.set(agentId, list);
    return false;
  }
  list.push(now);
  hourly.set(agentId, list);
  return true;
}

export function resetRateLimits(): void {
  hourly.clear();
  alerted.clear();
}

/**
 * A dial limit was hit: security event, and a help-desk alert (at most one an hour per agent and limit). No patient
 * data and no phone numbers in the alert: agent, limit, count, call ID.
 */
export function dialLimitHit(agentId: string, which: 'per_call' | 'per_hour', count: number, callId: string, now = Date.now()): void {
  securityEvent('voice_dial_limit', { code: which.toUpperCase(), object: `agent:${agentId}`, callId, channel: 'voice' });
  const key = `${agentId}|${which}`;
  if (now - (alerted.get(key) || 0) < 3_600_000) return;
  alerted.set(key, now);
  const subject = `[Drawbridge] Phone agent dial limit reached (${which.replace('_', ' ')})`;
  const text =
    `The Drawbridge phone agent "${agentId}" reached its outbound dial limit (${which.replace('_', ' ')}, ${count}).\n` +
    `Further dial-outs were refused. Call ID: ${callId}.\nCheck the audit (voice_dial lines) for unusual activity; possible toll-fraud attempt.\n`;
  for (const t of transportsFromEnv()) {
    t.send({ subject, text, json: { kind: 'voice_dial_limit', agent: agentId, limit: which, count, call_id: callId, at: new Date(now).toISOString() } }).catch((e: any) =>
      console.error(`[Voice] dial-limit alert via ${t.name} failed: ${e?.code || 'error'}`)
    );
  }
}
