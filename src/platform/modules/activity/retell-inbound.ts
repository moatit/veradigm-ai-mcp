import { createHash, createHmac, timingSafeEqual } from 'crypto';
import express, { Express, Request, Response } from 'express';
import { currentMode } from '../../../unity/oncall/call-mode';
import { getSystemStatus } from '../../system-status';
import { clientIp, throttledSecurityEvent } from '../../security-events';
import { safeId } from '../../audit';
import { SECRET_HEADER } from './retell-events';

/**
 * Retell inbound-call webhook (POST /webhooks/retell-inbound), set per phone number in Retell
 * ("Inbound Webhook URL"). Retell calls it before the call connects with
 *   { event: "call_inbound", call_inbound: { call_id, agent_id, agent_version, from_number, to_number } }
 * and Drawbridge answers with per-call dynamic variables, so the agent knows the line mode and the
 * records status from its first turn without calling drawbridge_get_call_mode:
 *   { call_inbound: { dynamic_variables: { call_mode, records_status, fhir_tools } } }
 *     call_mode       BUSINESS_HOURS | AFTER_HOURS   (CLINIC_HOURS / the notebook override)
 *     records_status  UP | DOWN | DEGRADED | UNKNOWN (system-status.ts)
 *     fhir_tools      ON | OFF  (DRAWBRIDGE_FHIR_TOOLS, default OFF: the backup chart tools are not in service)
 * It also warms the Veradigm sessions for the call (keep-warm), without waiting for them.
 * No patient data in or out; the caller's number is not stored here.
 *
 * Verification (Retell signs with the account API key; it cannot send custom headers here):
 *   x-retell-signature: v=<ms timestamp>,d=<hex HMAC-SHA256(raw body + timestamp, RETELL_API_KEY)>,
 *   timestamp within 5 minutes; or x-drawbridge-webhook-secret = RETELL_WEBHOOK_SECRET (relays, tests).
 * With neither configured: 503. Bad signature: 401 + webhook_rejected security event.
 * If Drawbridge does not answer within Retell's 10 s (3 attempts), Retell still connects the call to
 * the number's agent and the prompt falls back to drawbridge_get_call_mode (default variables UNKNOWN).
 */
const TOLERANCE_MS = 5 * 60_000;

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Retell's documented signature check, without the SDK. */
export function verifyRetellSignature(rawBody: string, apiKey: string, header: string, now: number = Date.now()): boolean {
  const m = /^v=(\d+),d=([0-9a-fA-F]+)$/.exec(String(header || '').trim());
  if (!m || !apiKey) return false;
  const ts = Number(m[1]);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TOLERANCE_MS) return false;
  const digest = createHmac('sha256', apiKey).update(rawBody + m[1]).digest('hex');
  return safeEqual(digest, m[2].toLowerCase());
}

export function verifyInbound(rawBody: string, headers: Record<string, string | string[] | undefined>, now: number = Date.now()): { ok: boolean; status: number; reason: string } {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] || '' : v || '';
  };
  const secret = process.env.RETELL_WEBHOOK_SECRET || '';
  const apiKey = process.env.RETELL_API_KEY || '';
  if (!secret && !apiKey) return { ok: false, status: 503, reason: 'webhook not configured' };
  const given = h(SECRET_HEADER);
  if (secret && given && safeEqual(given, secret)) return { ok: true, status: 200, reason: 'shared secret' };
  if (apiKey && verifyRetellSignature(rawBody, apiKey, h('x-retell-signature'), now)) return { ok: true, status: 200, reason: 'retell signature' };
  return { ok: false, status: 401, reason: 'bad signature' };
}

const fhirTools = () => (/^(1|true|on|yes)$/i.test(String(process.env.DRAWBRIDGE_FHIR_TOOLS || '').trim()) ? 'ON' : 'OFF');

/** The per-call variables (also usable for web calls: retell_llm_dynamic_variables). */
export function callStartVariables(): Record<string, string> {
  return {
    call_mode: currentMode() === 'after_hours' ? 'AFTER_HOURS' : 'BUSINESS_HOURS',
    records_status: getSystemStatus()?.agentStatus() || 'UNKNOWN',
    fhir_tools: fhirTools(),
  };
}

export function inboundResponse(body: any): { status: number; json?: unknown; callId: string } {
  if (body?.event !== 'call_inbound') return { status: 204, callId: '' };
  return {
    status: 200,
    json: { call_inbound: { dynamic_variables: callStartVariables(), metadata: { drawbridge: 'call_start_v1' } } },
    callId: safeId(body?.call_inbound?.call_id),
  };
}

/** Mount BEFORE express.json() (the signature is over the raw body). `onCallStart` warms Veradigm sessions. */
export function mountRetellInbound(app: Express, onCallStart?: () => void): void {
  app.post('/webhooks/retell-inbound', express.raw({ type: () => true, limit: '256kb' }), (req: Request, res: Response) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const v = verifyInbound(raw, req.headers);
      if (!v.ok) {
        if (v.status === 401) throttledSecurityEvent('webhook_rejected', { ip: clientIp(req), code: 'RETELL_INBOUND', object: '/webhooks/retell-inbound' });
        res.status(v.status).json({ error: v.reason });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        res.status(400).json({ error: 'invalid json' });
        return;
      }
      const out = inboundResponse(body);
      if (out.status === 200) {
        try {
          onCallStart?.();
        } catch {
          // warming must never delay or fail the call
        }
        console.log(`[Drawbridge] inbound call ${out.callId || '-'}: ${JSON.stringify((out.json as any).call_inbound.dynamic_variables)}`);
        res.status(200).json(out.json);
      } else res.status(out.status).end();
    } catch (e: any) {
      console.error(`[Drawbridge] inbound webhook failed: ${e?.code || e?.name || 'error'}`);
      res.status(500).json({ error: 'failed' });
    }
  });
}
