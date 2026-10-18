import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { auditBaseDir } from '../../audit';
import { buildCallRecord, CallAnalyticsRecord, hashKeySource, writePrivateFile } from './call-analytics';

/**
 * Forwards one minimum-necessary call analytics record per call (call-analytics.ts; handled as PHI under
 * the BAA, not de-identified) to the MOATiT admin app:
 *   POST ${ADMIN_PORTAL_URL}/api/call-records   x-api-key: ADMIN_API_KEY
 *
 * Off unless CALL_ANALYTICS_FORWARD=on and ADMIN_PORTAL_URL and ADMIN_API_KEY are set, and
 * CALL_ANALYTICS_HASH_KEY (32+ characters) is set too, whatever NODE_ENV is (audit N1). The only
 * exception is a local stack with CALL_ANALYTICS_ALLOW_GENERATED_KEY=local, which is refused when
 * NODE_ENV=production.
 * The URL must be https. Plain http is accepted only for loopback (localhost, 127.0.0.1, ::1) and for host
 * names listed exactly in CALL_ANALYTICS_HTTP_HOSTS (for example "admin" on the deploy/local network).
 * Records wait in an outbox, <AUDIT_DIR>/call-records-outbox.json (mode 0600), so a restart or an admin
 * outage loses nothing. The admin app upserts by the call reference, so a retry or a later event for the
 * same call replaces the earlier record. Retry: 30 s, doubling to 1 h; a record the admin app rejects as
 * invalid (4xx other than 401/408/429) is dropped with a warning; anything older than 7 days is dropped.
 */

interface OutboxItem {
  record: CallAnalyticsRecord;
  queued_at: number;
  attempts: number;
  next_at: number;
}

const OUTBOX_MAX = 5000;
const MAX_AGE_MS = 7 * 86_400_000;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 3_600_000;
const TICK_MS = 60_000;

const outboxFile = () => path.join(auditBaseDir(), 'call-records-outbox.json');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Host names allowed over plain http besides loopback (CALL_ANALYTICS_HTTP_HOSTS, comma or space separated). */
export function httpHosts(): Set<string> {
  return new Set(
    String(process.env.CALL_ANALYTICS_HTTP_HOSTS || '')
      .split(/[\s,]+/)
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

export type ForwardStatus =
  | { ok: true; url: string; key: string }
  | { ok: false; reason: 'off' | 'not configured' | 'insecure url' | 'hash key required' | 'generated key refused in production' };

/** Whether forwarding may run, and why not. */
export function forwardStatus(): ForwardStatus {
  if (!/^(1|true|on|yes)$/i.test(String(process.env.CALL_ANALYTICS_FORWARD || '').trim())) return { ok: false, reason: 'off' };
  const base = String(process.env.ADMIN_PORTAL_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.ADMIN_API_KEY || '').trim();
  if (!base || !key) return { ok: false, reason: 'not configured' };
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return { ok: false, reason: 'not configured' };
  }
  // A single-label name can still resolve outside the stack through a DNS search domain, so plain http
  // needs an explicit allow-list, never a guess.
  const httpOk = u.protocol === 'http:' && (LOOPBACK.has(u.hostname) || httpHosts().has(u.hostname.toLowerCase()));
  if (u.protocol !== 'https:' && !httpOk) return { ok: false, reason: 'insecure url' };
  const src = hashKeySource();
  if (src === 'missing') return { ok: false, reason: 'hash key required' };
  if (src === 'refused-production') return { ok: false, reason: 'generated key refused in production' };
  return { ok: true, url: `${base}/api/call-records`, key };
}

export function forwardConfig(): { url: string; key: string } | null {
  const st = forwardStatus();
  return st.ok ? { url: st.url, key: st.key } : null;
}

function readOutbox(): Record<string, OutboxItem> {
  try {
    const o = JSON.parse(fs.readFileSync(outboxFile(), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function writeOutbox(o: Record<string, OutboxItem>): void {
  writePrivateFile(outboxFile(), JSON.stringify(o));
}

export function outboxSize(): number {
  return Object.keys(readOutbox()).length;
}

/** Queue (or replace) the record for this call. */
export function enqueueRecord(record: CallAnalyticsRecord, now = Date.now()): void {
  const o = readOutbox();
  const prev = o[record.call_id];
  o[record.call_id] = { record, queued_at: prev?.queued_at ?? now, attempts: 0, next_at: now };
  const ids = Object.keys(o);
  if (ids.length > OUTBOX_MAX) {
    ids.sort((a, b) => o[a].queued_at - o[b].queued_at);
    for (const id of ids.slice(0, ids.length - OUTBOX_MAX)) delete o[id];
  }
  writeOutbox(o);
}

let flushing: Promise<{ sent: number; failed: number; dropped: number }> | null = null;

/** Send every due record. One flush at a time; never throws. */
export function flushOutbox(now = Date.now()): Promise<{ sent: number; failed: number; dropped: number }> {
  if (flushing) return flushing;
  flushing = (async () => {
    const out = { sent: 0, failed: 0, dropped: 0 };
    const cfg = forwardConfig();
    if (!cfg) return out;
    const due = Object.entries(readOutbox()).filter(([, it]) => it.next_at <= now);
    for (const [id, it] of due) {
      let status = 0;
      try {
        const res = await axios.post(cfg.url, it.record, {
          headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.key },
          timeout: 5000,
          validateStatus: () => true,
          maxRedirects: 0,
        });
        status = res.status;
      } catch {
        status = 0; // network error or timeout
      }
      // Re-read so records queued during the request aren't lost; only touch this ID if it is unchanged.
      const o = readOutbox();
      const cur = o[id];
      if (!cur || JSON.stringify(cur.record) !== JSON.stringify(it.record)) continue;
      if (status >= 200 && status < 300) {
        delete o[id];
        out.sent++;
      } else if (status >= 400 && status < 500 && ![401, 408, 429].includes(status)) {
        console.warn(`[Drawbridge] call record ${id} rejected by the admin app (${status}); dropped`);
        delete o[id];
        out.dropped++;
      } else if (now - cur.queued_at > MAX_AGE_MS) {
        console.warn(`[Drawbridge] call record ${id} undelivered for 7 days; dropped`);
        delete o[id];
        out.dropped++;
      } else {
        cur.attempts++;
        cur.next_at = now + Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (cur.attempts - 1));
        out.failed++;
        if (cur.attempts === 1 || cur.attempts % 10 === 0) {
          console.warn(`[Drawbridge] call record ${id} not delivered (${status || 'network'}); attempt ${cur.attempts}, will retry`);
        }
      }
      writeOutbox(o);
    }
    return out;
  })()
    .catch((e: any) => {
      console.error(`[Drawbridge] call record forwarding failed: ${e?.code || e?.name || 'error'}`);
      return { sent: 0, failed: 0, dropped: 0 };
    })
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

/**
 * Called for call_ended and call_analyzed. Builds the record, queues it and tries to send it,
 * all off the webhook's request path. Does nothing when forwarding is off.
 */
export function forwardCallEvent(event: string, call: unknown): Promise<void> {
  if (!forwardConfig() || (event !== 'call_ended' && event !== 'call_analyzed')) return Promise.resolve();
  return (async () => {
    const record = await buildCallRecord(event, call);
    if (!record) return;
    enqueueRecord(record);
    await flushOutbox();
  })().catch((e: any) => {
    console.error(`[Drawbridge] call record not queued: ${e?.code || e?.name || 'error'}`);
  });
}

let timer: NodeJS.Timeout | null = null;
/** Retry loop for queued records (module start). */
export function startForwarder(): void {
  if (timer) return;
  const st = forwardStatus();
  if (!st.ok) {
    // Asked for but refused: say why once at startup (never the URL's credentials or the key).
    if (st.reason !== 'off') console.error(`[Drawbridge] call analytics forwarding refused: ${st.reason}`);
    return;
  }
  timer = setInterval(() => void flushOutbox(), TICK_MS);
  timer.unref?.();
  void flushOutbox();
}
export function stopForwarder(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
