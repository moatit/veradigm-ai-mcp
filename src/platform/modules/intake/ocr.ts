import { splitPages } from './pages';

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/**
 * Client for Drawbridge's own OCR container (deploy/ocr): Tesseract 5 on the internal Docker
 * network, so document images never leave our infrastructure. Used for dropped and uploaded files
 * without a text layer, and for faxes whose MOATiT Fax OCR never finished.
 *
 *   INTAKE_OCR_URL              default http://ocr:8090; "off" disables OCR (items go to review)
 *   INTAKE_OCR_MIN_CONFIDENCE   default 60; below it a document is never auto-matched
 *
 *   POST {INTAKE_OCR_URL}/ocr   body = file bytes → {text, pages, mean_confidence, used_text_layer,
 *                               page_texts?, page_confidences?} (pages joined by a form feed in text)
 *   POST {INTAKE_OCR_URL}/pages?select=1,2   body = file bytes → a new file with only those pages
 *                               (same format; X-Source-Pages = pages in the input). Used to split a
 *                               batch fax into one file per patient (pipeline.ts).
 *
 * Failures throw OcrError with a code (never an empty text that looks like "nothing on the page"):
 *   OCR_UNAVAILABLE   network error / DNS / refused (retryable)
 *   OCR_TIMEOUT       no answer within the timeout (retryable)
 *   OCR_HTTP_<n>      5xx / 429 (retryable) or another status
 *   OCR_<CODE>        the service's own 4xx code, e.g. OCR_UNSUPPORTED_TYPE, OCR_TOO_LARGE
 *   OCR_BAD_RESPONSE  not JSON or the wrong shape
 * Nothing here logs document bytes or text.
 */
export const DEFAULT_OCR_URL = 'http://ocr:8090';
export const DEFAULT_OCR_MIN_CONFIDENCE = 60;

export interface OcrResult {
  text: string;
  pages: number;
  /** Mean Tesseract word confidence 0-100; 100 when the PDF text layer was used. */
  mean_confidence: number;
  used_text_layer: boolean;
  /** One text per page (from page_texts, or the text split at form feeds). */
  page_texts: string[];
  /** Mean word confidence per page; empty when the service did not report it. */
  page_confidences: number[];
}

export interface PagesResult {
  data: Buffer;
  mime: string;
  /** Page count of the file that was sent. */
  source_pages: number;
}

export class OcrError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly httpStatus?: number
  ) {
    super(code);
    this.name = 'OcrError';
  }
}

/** Base URL, or null when OCR is turned off. */
export function ocrBaseUrl(): string | null {
  const v = (process.env.INTAKE_OCR_URL ?? '').trim();
  if (/^(off|none|disabled|false)$/i.test(v)) return null;
  const url = (v || DEFAULT_OCR_URL).replace(/\/+$/, '');
  return /^https?:\/\//.test(url) ? url : null;
}

export function ocrMinConfidence(): number {
  const n = Number(process.env.INTAKE_OCR_MIN_CONFIDENCE);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_OCR_MIN_CONFIDENCE;
}

/**
 * Why OCR'd text is too weak to auto-match on, or null when it is fine. The match itself still
 * runs (staff see the candidate), but the item goes to review.
 */
export function ocrReviewReason(r: Pick<OcrResult, 'mean_confidence' | 'used_text_layer'>, min: number = ocrMinConfidence()): string | null {
  if (r.used_text_layer) return null;
  if (!(r.mean_confidence >= min)) {
    return `The text was read by OCR with low confidence (${Math.round(r.mean_confidence)}). Check the patient on the original.`;
  }
  return null;
}

export function parseOcrResult(json: any): OcrResult {
  if (!json || typeof json !== 'object' || typeof json.text !== 'string') throw new OcrError('OCR_BAD_RESPONSE', false);
  const pages = Number(json.pages);
  const conf = Number(json.mean_confidence);
  if (!Number.isFinite(pages) || pages < 0 || !Number.isFinite(conf)) throw new OcrError('OCR_BAD_RESPONSE', false);
  const pageTexts =
    Array.isArray(json.page_texts) && json.page_texts.every((t: unknown) => typeof t === 'string') ? (json.page_texts as string[]) : splitPages(json.text, pages);
  const pageConfs =
    Array.isArray(json.page_confidences) && json.page_confidences.length === pageTexts.length && json.page_confidences.every((c: unknown) => Number.isFinite(Number(c)))
      ? json.page_confidences.map(Number)
      : [];
  return { text: json.text, pages, mean_confidence: conf, used_text_layer: json.used_text_layer === true, page_texts: pageTexts, page_confidences: pageConfs };
}

export interface OcrClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Per attempt. A 10-page fine fax takes ~20 s on one core. */
  timeoutMs?: number;
  /** Total attempts (network errors, timeouts, 429 and 5xx are retried). */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class OcrClient {
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(private opts: OcrClientOptions) {
    this.fetchImpl = opts.fetchImpl || fetch;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** From INTAKE_OCR_URL; null when OCR is off. */
  static fromEnv(): OcrClient | null {
    const baseUrl = ocrBaseUrl();
    return baseUrl ? new OcrClient({ baseUrl }) : null;
  }

  /** Read one document (PDF, TIFF, PNG, JPEG). */
  async read(data: Buffer): Promise<OcrResult> {
    const res = await this.post('/ocr', data);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new OcrError('OCR_BAD_RESPONSE', false);
    }
    return parseOcrResult(json);
  }

  /**
   * A new file holding only `pages` (1-based, increasing) of `data`, in the same format. Throws
   * OcrError (OCR_BAD_PAGES, OCR_PAGE_OUT_OF_RANGE, OCR_BAD_RESPONSE, ...) like read().
   */
  async extractPages(data: Buffer, pages: number[]): Promise<PagesResult> {
    if (!pages.length || pages.some((p, i) => !Number.isInteger(p) || p < 1 || (i > 0 && p <= pages[i - 1]))) {
      throw new OcrError('OCR_BAD_PAGES', false);
    }
    const res = await this.post(`/pages?select=${pages.join(',')}`, data);
    const sourcePages = Number(res.headers.get('x-source-pages'));
    const mime = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    let out: Buffer;
    try {
      out = Buffer.from(await res.arrayBuffer());
    } catch {
      throw new OcrError('OCR_BAD_RESPONSE', true);
    }
    if (!out.length || !Number.isInteger(sourcePages) || sourcePages < 1 || !/^(application\/pdf|image\/(tiff|png|jpeg))$/.test(mime)) {
      throw new OcrError('OCR_BAD_RESPONSE', false);
    }
    return { data: out, mime, source_pages: sourcePages };
  }

  private async post(pathAndQuery: string, data: Buffer): Promise<FetchResponse> {
    const attempts = Math.max(1, Math.min(4, this.opts.attempts ?? 2));
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}${pathAndQuery}`;
    let last = new OcrError('OCR_UNAVAILABLE', true);
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.sleep(2000 * 2 ** (i - 1));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 180_000);
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', Accept: pathAndQuery === '/ocr' ? 'application/json' : '*/*' },
          body: new Uint8Array(data),
          signal: ctrl.signal,
          redirect: 'error',
        });
        if (res.ok) return res;
        const retryable = res.status === 429 || res.status >= 500;
        let code = `OCR_HTTP_${res.status}`;
        if (!retryable) {
          try {
            const j: any = await res.json();
            if (typeof j?.error === 'string' && /^[A-Z_]{2,40}$/.test(j.error)) code = `OCR_${j.error}`;
          } catch {
            // keep the HTTP code
          }
        }
        last = new OcrError(code, retryable, res.status);
        if (!retryable) throw last;
      } catch (e: any) {
        if (e instanceof OcrError && !e.retryable) throw e;
        if (!(e instanceof OcrError)) last = new OcrError(e?.name === 'AbortError' ? 'OCR_TIMEOUT' : 'OCR_UNAVAILABLE', true);
      } finally {
        clearTimeout(timer);
      }
    }
    throw last;
  }
}
