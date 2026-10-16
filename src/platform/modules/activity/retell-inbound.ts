import express, { Express, Request, Response } from 'express';
import { currentMode } from '../../../unity/oncall/call-mode';
import { getSystemStatus } from '../../system-status';
import { clientIp, throttledSecurityEvent } from '../../security-events';
import { safeId } from '../../audit';
import { verifyRetellWebhook, VerifyResult } from './retell-signature';

export { verifyRetellSignature } from './retell-signature';

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
 * Verification (retell-signature.ts; Retell cannot send custom headers here):
 *   x-retell-signature: v=<ms timestamp>,d=<hex HMAC-SHA256(raw body + timestamp, key)>, timestamp within 5 minutes,
 *   key = RETELL_WEBHOOK_API_KEY (the API key with the "webhook" badge in Retell), else RETELL_API_KEY;
 *   or x-drawbridge-webhook-secret = RETELL_WEBHOOK_SECRET (relays, tests).
 * With neither configured: 503. Bad signature: 401, the reason in the server log, a webhook_rejected security event.
 * If Drawbridge does not answer within Retell's 10 s (3 attempts), Retell still connects the call to
 * the number's agent and the prompt falls back to drawbridge_get_call_mode (default variables UNKNOWN).
 */
export function verifyInbound(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>, now: number = Date.now()): VerifyResult {
  return verifyRetellWebhook(rawBody, headers, now);
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
      // The exact bytes received (express.raw). If another parser ran first there are none to verify.
      if (!Buffer.isBuffer(req.body)) {
        console.error('[Drawbridge] inbound webhook: raw body unavailable (a body parser ran before this route)');
        res.status(500).json({ error: 'failed' });
        return;
      }
      const v = verifyInbound(req.body, req.headers);
      if (!v.ok) {
        console.warn(`[Drawbridge] inbound webhook rejected (${v.status}): ${v.reason}`);
        if (v.status === 401) throttledSecurityEvent('webhook_rejected', { ip: clientIp(req), code: 'RETELL_INBOUND', object: '/webhooks/retell-inbound' });
        res.status(v.status).json({ error: v.status === 401 ? 'bad signature' : 'webhook not configured' });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(req.body.toString('utf8'));
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
