import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ExtractedFields } from './extract';
import type { MatchResult } from './match';
import type { DocTypeSuggestion } from './doctypes';

/**
 * Intake working store: one JSON file of items plus the original files.
 *
 *   <CALL_RECORDS_DIR or /app/data>/intake/items.json     status, extracted fields, match, audit
 *   <CALL_RECORDS_DIR or /app/data>/intake/files/<id>.*   originals (and <id>.txt: document text)
 *
 * The volume is encrypted at rest in production. Files are written 0600, directories 0700.
 * items.json is rewritten atomically (temp file + rename) on every change. All reads and writes
 * are synchronous, so one process never interleaves two read-modify-write cycles.
 *
 * Dedupe: by source_ref (MOATiT Fax X-Webhook-Id, folder file name + hash, upload hash) and by
 * the SHA-256 of the file. Nothing here logs file contents, document text or patient identifiers.
 */
export type IntakeSource = 'moatit_fax' | 'folder' | 'upload';
export type IntakeStatus = 'received' | 'read' | 'matched' | 'needs_review' | 'filed' | 'sent_to_indexing' | 'failed';
export const INTAKE_STATUSES: IntakeStatus[] = ['received', 'read', 'matched', 'needs_review', 'filed', 'sent_to_indexing', 'failed'];

export interface IntakeHistory {
  ts: string;
  action: string;
  /** Staff username, or "drawbridge" for automatic steps. */
  by: string;
}

export interface IntakeFile {
  name: string;
  mime: string;
  sha256: string;
  size: number;
  /** File name inside files/ (never a caller-supplied path). */
  stored_as: string;
}

export interface IntakeItem {
  id: string;
  source: IntakeSource;
  /** Dedupe key from the source (e.g. "fax:<job-id>:fax.received"). */
  source_ref: string;
  /** MOATiT Fax job ID (fax items only). */
  job_id?: string;
  received_at: string;
  updated_at: string;
  status: IntakeStatus;
  file?: IntakeFile;
  /** Document text is stored next to the file (files/<id>.txt), never in items.json. */
  has_text?: boolean;
  /** Sending fax number as reported by MOATiT Fax (the sender's, not the patient's). */
  sender_fax?: string;
  extracted?: ExtractedFields;
  match?: MatchResult;
  document_type?: DocTypeSuggestion | null;
  /** Item ID of an earlier item with the same file hash. */
  duplicate_of?: string;
  /** Last error code (never a message with content). */
  error_code?: string;
  /** Staff note shown on the item ("why it needs review"). Plain text, short. */
  note?: string;
  reviewed_by?: string;
  reviewed_at?: string;
  /** Times processing waited for MOATiT Fax OCR. */
  ocr_waits?: number;
  history: IntakeHistory[];
}

export interface NewDocument {
  source: IntakeSource;
  source_ref: string;
  name: string;
  mime: string;
  data: Buffer;
  /** Text layer / OCR when the source already has it. */
  text?: string;
  by?: string;
}

export interface AddResult {
  item: IntakeItem;
  /** True when an item with the same source_ref or file hash already existed (nothing written). */
  duplicate: boolean;
}

export function intakeDir(): string {
  return path.join(process.env.CALL_RECORDS_DIR || '/app/data', 'intake');
}

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/tiff': '.tif',
  'image/png': '.png',
  'image/jpeg': '.jpg',
};
export const ALLOWED_MIME = new Set(Object.keys(EXT_BY_MIME));

/** Safe display name: base name only, no control or path characters, max 120 chars. */
export function safeFileName(name: unknown): string {
  const base = String(name ?? '').split(/[\\/]/).pop() || '';
  return base.replace(/[^\w .()+-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'document';
}

/** File type from the first bytes (PDF, TIFF, PNG, JPEG); '' for anything else. */
export function sniffMime(data: Buffer): string {
  const head = data.subarray(0, 8);
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  const t = head.subarray(0, 4).toString('latin1');
  if (t === 'II*\u0000' || t === 'MM\u0000*') return 'image/tiff';
  return '';
}

export const sha256 =(data: Buffer): string => createHash('sha256').update(data).digest('hex');
const newId = () => `in_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
const ID_RE = /^in_[a-z0-9]{6,40}$/;

export class IntakeStore {
  private items: IntakeItem[] | null = null;

  constructor(
    readonly dir: string = intakeDir(),
    private now: () => Date = () => new Date()
  ) {}

  get file(): string {
    return path.join(this.dir, 'items.json');
  }
  get filesDir(): string {
    return path.join(this.dir, 'files');
  }

  private load(): IntakeItem[] {
    if (this.items) return this.items;
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = Array.isArray(rows) ? rows : [];
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        // A corrupt store is not "empty": keep the bad file aside and start a new one loudly.
        const aside = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.file, aside);
        } catch {
          // ignore
        }
        console.error(`[Intake] items.json unreadable (${e?.code || e?.name || 'error'}); moved aside`);
      }
      this.items = [];
    }
    return this.items;
  }

  private persist(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items || [], null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Write a file into files/ atomically. */
  private writeBlob(name: string, data: Buffer | string): void {
    fs.mkdirSync(this.filesDir, { recursive: true, mode: 0o700 });
    const dest = path.join(this.filesDir, name);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, dest);
  }

  /** Newest first, optionally one status. */
  list(status?: IntakeStatus): IntakeItem[] {
    return this.load()
      .filter((i) => !status || i.status === status)
      .sort((a, b) => b.received_at.localeCompare(a.received_at));
  }

  get(id: string): IntakeItem | undefined {
    if (!ID_RE.test(String(id))) return undefined;
    return this.load().find((i) => i.id === id);
  }

  findBySourceRef(ref: string): IntakeItem | undefined {
    return ref ? this.load().find((i) => i.source_ref === ref) : undefined;
  }

  findBySha(hash: string): IntakeItem | undefined {
    return hash ? this.load().find((i) => i.file?.sha256 === hash) : undefined;
  }

  counts(): Record<IntakeStatus, number> {
    const out = Object.fromEntries(INTAKE_STATUSES.map((s) => [s, 0])) as Record<IntakeStatus, number>;
    for (const i of this.load()) out[i.status] = (out[i.status] || 0) + 1;
    return out;
  }

  private create(fields: Pick<IntakeItem, 'source' | 'source_ref'> & Partial<IntakeItem>, by: string, action: string): IntakeItem {
    const ts = this.now().toISOString();
    const item: IntakeItem = {
      ...fields,
      id: newId(),
      received_at: ts,
      updated_at: ts,
      status: 'received',
      history: [{ ts, action, by }],
    };
    this.load().push(item);
    this.persist();
    return item;
  }

  /**
   * MOATiT Fax webhook: record the job durably before the 2xx. Duplicate when the webhook ID or
   * the job ID was seen before (MOATiT Fax delivers at least once).
   */
  recordFax(webhookId: string, jobId: string): AddResult {
    const existing = this.findBySourceRef(webhookId) || this.load().find((i) => i.source === 'moatit_fax' && i.job_id === jobId);
    if (existing) return { item: existing, duplicate: true };
    return { item: this.create({ source: 'moatit_fax', source_ref: webhookId, job_id: jobId }, 'moatit_fax', 'fax received'), duplicate: false };
  }

  /** Folder or upload: store the original (and text) and create the item. Dedupe by source_ref and hash. */
  addDocument(doc: NewDocument): AddResult {
    const hash = sha256(doc.data);
    const sourceRef = doc.source_ref || `${doc.source}:${hash}`;
    const existing = this.findBySourceRef(sourceRef) || this.findBySha(hash);
    if (existing) return { item: existing, duplicate: true };
    const mime = ALLOWED_MIME.has(doc.mime) ? doc.mime : 'application/octet-stream';
    const id = newId();
    const storedAs = `${id}${EXT_BY_MIME[mime] || '.bin'}`;
    this.writeBlob(storedAs, doc.data);
    if (doc.text && doc.text.trim()) this.writeBlob(`${id}.txt`, doc.text);
    const ts = this.now().toISOString();
    const item: IntakeItem = {
      id,
      source: doc.source,
      source_ref: sourceRef,
      received_at: ts,
      updated_at: ts,
      status: 'received',
      file: { name: safeFileName(doc.name), mime, sha256: hash, size: doc.data.length, stored_as: storedAs },
      has_text: !!(doc.text && doc.text.trim()),
      history: [{ ts, action: doc.source === 'upload' ? 'uploaded' : 'picked up from drop folder', by: doc.by || 'drawbridge' }],
    };
    this.load().push(item);
    this.persist();
    return { item, duplicate: false };
  }

  /** Attach the original to an existing item (fax download). Flags, never drops, a same-hash file. */
  attachFile(id: string, data: Buffer, name: string, mime: string): IntakeItem {
    const item = this.require(id);
    const hash = sha256(data);
    const dup = this.findBySha(hash);
    const m = ALLOWED_MIME.has(mime) ? mime : 'application/octet-stream';
    const storedAs = `${id}${EXT_BY_MIME[m] || '.bin'}`;
    this.writeBlob(storedAs, data);
    return this.update(
      id,
      {
        file: { name: safeFileName(name), mime: m, sha256: hash, size: data.length, stored_as: storedAs },
        ...(dup && dup.id !== item.id ? { duplicate_of: dup.id } : {}),
      },
      dup && dup.id !== item.id ? `file downloaded (same file as ${dup.id})` : 'file downloaded'
    );
  }

  saveText(id: string, text: string): void {
    this.require(id);
    this.writeBlob(`${id}.txt`, text);
    this.update(id, { has_text: !!text.trim() });
  }

  readText(id: string): string {
    if (!ID_RE.test(id)) return '';
    try {
      return fs.readFileSync(path.join(this.filesDir, `${id}.txt`), 'utf8');
    } catch {
      return '';
    }
  }

  /** Absolute path of an item's original, or '' when it's gone. */
  filePath(item: IntakeItem): string {
    if (!item.file || !/^[\w.-]+$/.test(item.file.stored_as)) return '';
    const p = path.resolve(this.filesDir, item.file.stored_as);
    return fs.existsSync(p) ? p : '';
  }

  private require(id: string): IntakeItem {
    const item = this.get(id);
    if (!item) throw Object.assign(new Error('intake item not found'), { code: 'NOT_FOUND' });
    return item;
  }

  /** Merge fields, append a history line when `action` is given, persist. */
  update(id: string, patch: Partial<Omit<IntakeItem, 'id' | 'history'>>, action?: string, by = 'drawbridge'): IntakeItem {
    const item = this.require(id);
    const ts = this.now().toISOString();
    Object.assign(item, patch, { updated_at: ts });
    if (action) item.history.push({ ts, action, by });
    this.persist();
    return item;
  }

  /**
   * Delete originals (and text) of items filed or sent to indexing more than `days` ago; the chart
   * copy is the record. The item and its audit history stay. Returns files removed.
   */
  pruneFiled(days: number): number {
    const cutoff = this.now().getTime() - days * 86_400_000;
    let removed = 0;
    for (const item of this.load()) {
      if ((item.status !== 'filed' && item.status !== 'sent_to_indexing') || Date.parse(item.updated_at) > cutoff) continue;
      for (const name of [item.file?.stored_as, `${item.id}.txt`]) {
        if (!name || !/^[\w.-]+$/.test(name)) continue;
        try {
          fs.unlinkSync(path.join(this.filesDir, name));
          removed++;
        } catch {
          // already gone
        }
      }
    }
    return removed;
  }
}

let shared: IntakeStore | null = null;
/** The process-wide store under intakeDir(). */
export function intakeStore(): IntakeStore {
  if (!shared || shared.dir !== intakeDir()) shared = new IntakeStore();
  return shared;
}
