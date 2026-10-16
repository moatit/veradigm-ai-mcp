import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Retell webhook verification, shared by POST /webhooks/retell (call events) and
 * POST /webhooks/retell-inbound (inbound-call webhook).
 *
 * Retell (docs.retellai.com/features/secure-webhook) signs every webhook with ONE API key: the key that has
 * the "webhook" badge in the Retell dashboard (Settings -> API Keys). That key may differ from the key
 * Drawbridge uses for API calls (RETELL_API_KEY), so the verification key is its own setting:
 *   RETELL_WEBHOOK_API_KEY   the webhook-badged key (falls back to RETELL_API_KEY when unset)
 *
 * Header: x-retell-signature: v=<ms timestamp>,d=<hex HMAC-SHA256(raw body + timestamp, key)>
 *  - parsed with /v=(\d+),d=(.*)/ (Retell's own pattern);
 *  - rejected when the timestamp is more than 5 minutes from now;
 *  - the digest is over the exact bytes received (express.raw), never re-serialized JSON;
 *  - compared in constant time.
 * Alternative for relays and tests: x-drawbridge-webhook-secret = RETELL_WEBHOOK_SECRET.
 *
 * Rejections carry a reason for the server log (missing signature, bad format, stale timestamp, digest
 * mismatch, shared secret mismatch). The key and the body are never logged.
 */
export const SECRET_HEADER = 'x-drawbridge-webhook-secret';
export const SIGNATURE_HEADER = 'x-retell-signature';
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

export type SignatureFailure = 'missing signature' | 'bad signature format' | 'stale timestamp' | 'digest mismatch' | 'no key';
export type SignatureCheck = { ok: true } | { ok: false; reason: SignatureFailure; skewSeconds?: number };

export interface VerifyResult {
  ok: boolean;
  status: number;
  /** For the server log only: never the key, the signature or the body. */
  reason: string;
}

export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** The key Retell signs webhooks with: RETELL_WEBHOOK_API_KEY, else RETELL_API_KEY ('' when neither). */
export function retellWebhookKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'RETELL_WEBHOOK_API_KEY' | 'RETELL_API_KEY' | '' } {
  const webhookKey = String(env.RETELL_WEBHOOK_API_KEY || '').trim();
  if (webhookKey) return { key: webhookKey, source: 'RETELL_WEBHOOK_API_KEY' };
  const apiKey = String(env.RETELL_API_KEY || '').trim();
  return apiKey ? { key: apiKey, source: 'RETELL_API_KEY' } : { key: '', source: '' };
}

/** Retell's signature check (same as the SDK's Retell.verify), over the raw request bytes. */
export function checkRetellSignature(rawBody: Buffer | string, apiKey: string, header: string, now: number = Date.now()): SignatureCheck {
  if (!apiKey) return { ok: false, reason: 'no key' };
  const sig = String(header || '').trim();
  if (!sig) return { ok: false, reason: 'missing signature' };
  const m = /v=(\d+),d=(.*)/.exec(sig);
  if (!m) return { ok: false, reason: 'bad signature format' };
  const ts = Number(m[1]);
  const given = m[2].trim().toLowerCase();
  if (!Number.isFinite(ts) || !/^[0-9a-f]{64}$/.test(given)) return { ok: false, reason: 'bad signature format' };
  if (Math.abs(now - ts) > SIGNATURE_TOLERANCE_MS) return { ok: false, reason: 'stale timestamp', skewSeconds: Math.round((now - ts) / 1000) };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const digest = createHmac('sha256', apiKey).update(body).update(m[1], 'utf8').digest('hex');
  return safeEqual(digest, given) ? { ok: true } : { ok: false, reason: 'digest mismatch' };
}

/** Boolean form of checkRetellSignature. */
export function verifyRetellSignature(rawBody: Buffer | string, apiKey: string, header: string, now: number = Date.now()): boolean {
  return checkRetellSignature(rawBody, apiKey, header, now).ok;
}

const headerValue = (headers: Record<string, string | string[] | undefined>, k: string): string => {
  const v = headers[k];
  return Array.isArray(v) ? v[0] || '' : v || '';
};

/**
 * Accept a Retell webhook when either the shared-secret header matches RETELL_WEBHOOK_SECRET or the
 * Retell signature verifies with RETELL_WEBHOOK_API_KEY (else RETELL_API_KEY).
 * 503 when neither is configured, 401 otherwise.
 */
export function verifyRetellWebhook(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): VerifyResult {
  const secret = String(env.RETELL_WEBHOOK_SECRET || '');
  const { key, source } = retellWebhookKey(env);
  if (!secret && !key) return { ok: false, status: 503, reason: 'webhook not configured (set RETELL_WEBHOOK_API_KEY)' };

  const given = headerValue(headers, SECRET_HEADER);
  if (secret && given && safeEqual(given, secret)) return { ok: true, status: 200, reason: 'shared secret' };

  const sig = headerValue(headers, SIGNATURE_HEADER);
  if (key && (sig || !given)) {
    const c = checkRetellSignature(rawBody, key, sig, now);
    if (c.ok) return { ok: true, status: 200, reason: `retell signature (${source})` };
    const detail =
      c.reason === 'stale timestamp'
        ? `stale timestamp (${c.skewSeconds}s off, limit ${SIGNATURE_TOLERANCE_MS / 1000}s)`
        : c.reason === 'digest mismatch'
          ? `digest mismatch (verified with ${source}; Retell signs with the API key that has the "webhook" badge)`
          : c.reason;
    return { ok: false, status: 401, reason: detail };
  }
  return { ok: false, status: 401, reason: given ? 'shared secret mismatch' : 'missing signature' };
}
