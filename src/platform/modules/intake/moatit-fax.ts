import { createHmac, timingSafeEqual } from 'crypto';
import express, { Express, Request, Response } from 'express';

type FetchResponse = Awaited<ReturnType<typeof fetch>>;
import { intakeStore, IntakeStore } from './store';

/**
 * MOATiT Fax → Drawbridge.
 *
 * Webhook: POST /webhooks/moatit-fax (mounted BEFORE the app-wide express.json() so the raw bytes
 * are available for the signature check).
 *   X-Webhook-Signature  sha256=<lowercase hex HMAC-SHA256 of the raw body, key MOATIT_FAX_WEBHOOK_SECRET>
 *   X-Webhook-Event      only "fax.received" is accepted
 *   X-Webhook-Id         fax:<job-id>:<event>; delivery is at least once, so it is deduped durably
 *   X-Webhook-Attempt    informational
 * Responses: 503 secret unset, 401 bad/missing signature, 400 bad event/ID/body, 204 recorded or duplicate.
 * The 204 goes out only after the item is on disk; the fetch from MOATiT Fax happens afterwards.
 *
 * Enterprise API (MOATIT_FAX_BASE_URL + /api/v1/enterprise, Authorization: Bearer MOATIT_FAX_API_KEY):
 *   GET /fax/{job_id}            status, OCR state and text (field names unconfirmed, read defensively)
 *   GET /fax/{job_id}/download   original document
 *
 * Never logged: the API key, the webhook secret, fax content, OCR text, patient identifiers.
 */
export const FAX_EVENTS = new Set(['fax.received']);
const SIG_RE = /^sha256=([0-9a-f]{64})$/i;
const JOB_RE = /^[A-Za-z0-9_-]{1,128}$/;
const WEBHOOK_ID_RE = /^fax:([A-Za-z0-9_-]{1,128}):([a-z0-9._-]{1,64})$/;

export interface FaxVerifyResult {
  ok: boolean;
  status: number;
  reason: string;
  event?: string;
  webhook_id?: string;
  /** Job ID taken from X-Webhook-Id. */
  job_id?: string;
  attempt?: number;
}

const header = (headers: Record<string, string | string[] | undefined>, k: string): string => {
  const v = headers[k] ?? headers[k.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v || '').trim();
};

/**
 * Check one delivery: HMAC over the raw bytes (constant time), then the event allowlist and the
 * webhook ID. The signature is checked first so an unsigned caller learns nothing else.
 */
export function verifyFaxWebhook(
  raw: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined
): FaxVerifyResult {
  if (!secret) return { ok: false, status: 503, reason: 'webhook not configured' };
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const sig = header(headers, 'x-webhook-signature').match(SIG_RE);
  if (!sig) return { ok: false, status: 401, reason: 'missing signature' };
  const given = Buffer.from(sig[1].toLowerCase(), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, status: 401, reason: 'bad signature' };
  }
  const event = header(headers, 'x-webhook-event');
  if (!FAX_EVENTS.has(event)) return { ok: false, status: 400, reason: 'event not accepted' };
  const id = header(headers, 'x-webhook-id');
  const m = id.match(WEBHOOK_ID_RE);
  if (!m || m[2] !== event) return { ok: false, status: 400, reason: 'bad webhook id' };
  const attempt = Number(header(headers, 'x-webhook-attempt')) || 1;
  return { ok: true, status: 204, reason: 'verified', event, webhook_id: id, job_id: m[1], attempt };
}

/** Job ID from the payload, read defensively (field name unconfirmed). '' when absent or unsafe. */
export function jobIdFromBody(body: any): string {
  const cands = [body?.job_id, body?.jobId, body?.data?.job_id, body?.data?.jobId, body?.fax?.job_id, body?.data?.id, body?.id];
  for (const c of cands) {
    const v = typeof c === 'number' ? String(c) : typeof c === 'string' ? c.trim() : '';
    if (v) return JOB_RE.test(v) ? v : '';
  }
  return '';
}

/** Called with the new item ID once a delivery is recorded (set by the intake module at start). */
let onRecorded: ((id: string) => void) | null = null;
export function setFaxRecordedHandler(fn: ((id: string) => void) | null): void {
  onRecorded = fn;
}

export interface FaxDeliveryOutcome {
  status: number;
  reason: string;
  item_id?: string;
  duplicate?: boolean;
}

/** Verify, parse, record. Pure of HTTP so the smoke test can drive it directly. */
export function handleFaxDelivery(
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
  store: IntakeStore = intakeStore(),
  secret: string | undefined = process.env.MOATIT_FAX_WEBHOOK_SECRET
): FaxDeliveryOutcome {
  const v = verifyFaxWebhook(raw, headers, secret);
  if (!v.ok) return { status: v.status, reason: v.reason };
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, reason: 'invalid json' };
  }
  const fromBody = jobIdFromBody(body);
  if (fromBody && fromBody !== v.job_id) return { status: 400, reason: 'job id mismatch' };
  const { item, duplicate } = store.recordFax(v.webhook_id!, v.job_id!);
  return { status: 204, reason: duplicate ? 'duplicate' : 'recorded', item_id: item.id, duplicate };
}

/** POST /webhooks/moatit-fax. Mount before express.json(). */
export function mountFaxWebhook(app: Express, opts: { store?: () => IntakeStore } = {}): void {
  const getStore = opts.store || intakeStore;
  app.post('/webhooks/moatit-fax', express.raw({ type: () => true, limit: '1mb' }), (req: Request, res: Response) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const out = handleFaxDelivery(raw, req.headers, getStore());
      if (out.status !== 204) {
        console.warn(`[Intake] fax webhook rejected: ${out.reason}`);
        res.status(out.status).json({ error: out.reason });
        return;
      }
      console.log(`[Intake] fax webhook ${out.duplicate ? 'duplicate' : 'recorded'} ${out.item_id}`);
      res.status(204).end();
      if (!out.duplicate && out.item_id && onRecorded) {
        const id = out.item_id;
        setImmediate(() => onRecorded?.(id));
      }
    } catch (e: any) {
      // Not recorded: a 5xx makes MOATiT Fax retry the delivery.
      console.error(`[Intake] fax webhook failed: ${e?.code || e?.name || 'error'}`);
      res.status(500).json({ error: 'failed' });
    }
  });
}

// ── Enterprise API client ────────────────────────────────────────────────────

export type FaxApiErrorCode =
  | 'FAX_API_NOT_CONFIGURED'
  | 'FAX_API_TIMEOUT'
  | 'FAX_API_NETWORK'
  | 'FAX_API_HTTP'
  | 'FAX_API_TOO_LARGE'
  | 'FAX_API_BAD_RESPONSE';

export class FaxApiError extends Error {
  constructor(
    readonly code: FaxApiErrorCode,
    readonly retryable: boolean,
    readonly httpStatus?: number
  ) {
    super(httpStatus ? `${code} ${httpStatus}` : code);
    this.name = 'FaxApiError';
  }
}

export interface FaxJob {
  status: string;
  /** e.g. pending / processing / completed / failed ('' when MOATiT Fax doesn't say). */
  ocr_state: string;
  text: string;
  /** Sending fax number. */
  sender_fax: string;
}

export interface FaxDownload {
  data: Buffer;
  mime: string;
  name: string;
}

const OCR_PENDING = new Set(['pending', 'queued', 'processing', 'in_progress', 'running', 'started']);
export const isOcrPending = (job: FaxJob): boolean => !job.text.trim() && OCR_PENDING.has(job.ocr_state.toLowerCase());

function at(obj: any, dotted: string): unknown {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
function firstString(obj: any, paths: string[]): string {
  for (const p of paths) {
    for (const root of [obj, obj?.data, obj?.fax, obj?.job]) {
      const v = at(root, p);
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number') return String(v);
    }
  }
  return '';
}

/** GET /fax/{job_id} body → the fields intake needs. Field names unconfirmed: several are tried. */
export function parseFaxJob(json: unknown): FaxJob {
  if (!json || typeof json !== 'object') throw new FaxApiError('FAX_API_BAD_RESPONSE', false);
  const text = firstString(json, ['ocr_text', 'ocrText', 'ocr.text', 'ocr.full_text', 'ocr_result.text', 'ocr.content', 'text']);
  return {
    status: firstString(json, ['status', 'state', 'job_status']).slice(0, 40),
    ocr_state: firstString(json, ['ocr_status', 'ocr_state', 'ocrStatus', 'ocr.status', 'ocr.state']).slice(0, 40),
    text: text.slice(0, 500_000),
    sender_fax: firstString(json, ['from_number', 'fromNumber', 'from', 'caller_id', 'sender_number', 'remote_number', 'remote_station_id'])
      .replace(/[^\d+]/g, '')
      .slice(0, 20),
  };
}

const MIME_OK = new Set(['application/pdf', 'image/tiff', 'image/png', 'image/jpeg']);
function filenameFrom(disposition: string, jobId: string, mime: string): string {
  const m = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) {
    try {
      return decodeURIComponent(m[1]).slice(0, 120);
    } catch {
      return m[1].slice(0, 120);
    }
  }
  const ext = mime === 'image/tiff' ? 'tif' : mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'pdf';
  return `fax-${jobId}.${ext}`;
}

export interface FaxClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  /** Total attempts per request (network errors, timeouts, 429 and 5xx are retried). */
  attempts?: number;
  maxBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class MoatitFaxClient {
  private base: string;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(private opts: FaxClientOptions) {
    const b = opts.baseUrl.replace(/\/+$/, '');
    this.base = /\/api\/v1\/enterprise$/.test(b) ? b : `${b}/api/v1/enterprise`;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** From MOATIT_FAX_BASE_URL + MOATIT_FAX_API_KEY; null when either is missing. */
  static fromEnv(): MoatitFaxClient | null {
    const baseUrl = process.env.MOATIT_FAX_BASE_URL || '';
    const apiKey = process.env.MOATIT_FAX_API_KEY || '';
    if (!baseUrl || !apiKey || !/^https?:\/\//.test(baseUrl)) return null;
    const mb = Number(process.env.INTAKE_MAX_FILE_MB);
    return new MoatitFaxClient({ baseUrl, apiKey, maxBytes: (Number.isFinite(mb) && mb > 0 ? mb : 25) * 1024 * 1024 });
  }

  private async request(pathname: string, timeoutMs: number): Promise<FetchResponse> {
    const attempts = Math.max(1, Math.min(5, this.opts.attempts ?? 3));
    let last: FaxApiError = new FaxApiError('FAX_API_NETWORK', true);
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.sleep(1000 * 2 ** (i - 1));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.base}${pathname}`, {
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, Accept: '*/*' },
          signal: ctrl.signal,
          redirect: 'error',
        });
        if (res.ok) return res;
        const retryable = res.status === 429 || res.status >= 500;
        last = new FaxApiError('FAX_API_HTTP', retryable, res.status);
        if (!retryable) throw last;
      } catch (e: any) {
        if (e instanceof FaxApiError && !e.retryable) throw e;
        if (!(e instanceof FaxApiError)) last = new FaxApiError(e?.name === 'AbortError' ? 'FAX_API_TIMEOUT' : 'FAX_API_NETWORK', true);
      } finally {
        clearTimeout(timer);
      }
    }
    throw last;
  }

  async getJob(jobId: string): Promise<FaxJob> {
    if (!JOB_RE.test(jobId)) throw new FaxApiError('FAX_API_BAD_RESPONSE', false);
    const res = await this.request(`/fax/${encodeURIComponent(jobId)}`, this.opts.timeoutMs ?? 15_000);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new FaxApiError('FAX_API_BAD_RESPONSE', false);
    }
    return parseFaxJob(json);
  }

  async download(jobId: string): Promise<FaxDownload> {
    if (!JOB_RE.test(jobId)) throw new FaxApiError('FAX_API_BAD_RESPONSE', false);
    const res = await this.request(`/fax/${encodeURIComponent(jobId)}/download`, this.opts.downloadTimeoutMs ?? 60_000);
    const max = this.opts.maxBytes ?? 25 * 1024 * 1024;
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > max) throw new FaxApiError('FAX_API_TOO_LARGE', false);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > max) throw new FaxApiError('FAX_API_TOO_LARGE', false);
    if (!data.length) throw new FaxApiError('FAX_API_BAD_RESPONSE', true);
    const ct = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const mime = MIME_OK.has(ct) ? ct : data.subarray(0, 4).toString('latin1') === '%PDF' ? 'application/pdf' : 'application/octet-stream';
    return { data, mime, name: filenameFrom(String(res.headers.get('content-disposition') || ''), jobId, mime) };
  }
}
