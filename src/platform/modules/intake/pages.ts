import { extractFields, type ExtractedFields } from './extract';
import type { IntakeItem } from './store';

/**
 * Pages of a received document: which patient each page belongs to, and whether a file that shows
 * several patients can be split into one file per patient (pipeline.ts does the split).
 *
 * Page text: the OCR container and the PDF text layer give one text per page (pages are joined with
 * a form feed in the stored text); MOATiT Fax OCR marks pages with "--- Page N ---" (moatit-fax.ts
 * turns that into form feeds). Text without page breaks is one page.
 *
 * Each page is read on its own with the same extractFields() as the whole document. A page
 * *identifies* a patient when it shows a readable name + date of birth, or an MRN.
 *
 *   cover page      no identifiers and looks like a fax cover sheet, before the first patient page:
 *                   not a patient page (it stays with the original, never goes into a split part)
 *   continuation    no identifiers: belongs to the patient on the page before, EXCEPT for batch
 *                   senders (INTAKE_BATCH_SENDERS), where every result page must identify its patient
 *   partial         only a name or only a date of birth: must agree with the patient before it
 *                   (never for batch senders)
 *
 * Grouping compares identifiers exactly (after the extractor's OCR fixes). Two pages whose
 * identifiers are close but not equal (a misread digit, Daniel / Danielle) are never put together
 * and never put apart: the file goes to staff. The same goes for a page showing two patients, a
 * patient whose pages are not contiguous, a page that can't be assigned, a page count that doesn't
 * match the file, and a part that still names more than one patient. Every doubt means "review",
 * never a guess, so a page is never filed to a patient it does not name (or follow, outside batches).
 *
 * Pure: no I/O. Nothing here logs.
 */
export type SegmentDecision = 'single' | 'split' | 'review';

export interface PatientPages {
  /** 1-based page numbers, increasing. */
  pages: number[];
}

export interface PageSegmentation {
  /** single: one patient (file the whole document as today); split: one part per patient; review: staff. */
  decision: SegmentDecision;
  /** Staff-readable: why the file goes to review, or what was found. */
  reason: string;
  batch_sender: boolean;
  /** Pages in the text. */
  page_count: number;
  /** True when every page was read and grouped (batch senders and multi-patient files). */
  checked: boolean;
  cover_pages: number[];
  patients: PatientPages[];
}

export interface SegmentOptions {
  /** The sender is a batch sender (isListedSender('INTAKE_BATCH_SENDERS', ...)). */
  batch: boolean;
  /** patient_count of the whole document (extractFields on all the text). */
  wholeCount: number;
  /** Page count of the file when known (OCR / MOATiT Fax); a different number of texts is a mismatch. */
  expectedPages?: number;
  /** Splitting allowed (INTAKE_SPLIT, default on). Off: a multi-patient file goes to review. */
  split?: boolean;
  now?: Date;
  ownName?: string;
}

// ── Page text ────────────────────────────────────────────────────────────────

/**
 * Text → one string per page, split at form feeds. A trailing empty piece left by a final form
 * feed is dropped when that makes the count match `expected` (or when nothing is expected).
 */
export function splitPages(text: string, expected?: number): string[] {
  const parts = String(text ?? '').split('\f');
  const last = parts[parts.length - 1];
  if (parts.length > 1 && !last.trim() && (expected === undefined || parts.length === expected + 1)) parts.pop();
  return parts;
}

/** "--- Page 2 ---" markers (MOATiT Fax OCR) → pages joined with form feeds. Blank pages, which MOATiT Fax leaves out, come back empty. */
export function pagesFromMarkers(raw: string, pageCount?: number): string {
  const re = /^-{2,}\s*Page\s+(\d{1,3})\s*-{2,}\s*$/gim;
  const marks = [...String(raw ?? '').matchAll(re)];
  if (!marks.length) return raw;
  const total = Math.max(pageCount || 0, ...marks.map((m) => +m[1]));
  const pages: string[] = Array.from({ length: total }, () => '');
  marks.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index! : raw.length;
    const n = +m[1];
    if (n >= 1 && n <= total) pages[n - 1] = (pages[n - 1] ? pages[n - 1] + '\n' : '') + raw.slice(start, end).replace(/^\s*\n|\s+$/g, '');
  });
  return pages.join('\f');
}

// ── Senders ──────────────────────────────────────────────────────────────────

const collapse = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Comma-separated, case-insensitive entries of an env list (INTAKE_BATCH_SENDERS, INTAKE_NO_AUTO_SENDERS). */
export function senderList(envName: string): string[] {
  return String(process.env[envName] || '')
    .split(',')
    .map(collapse)
    .filter(Boolean);
}

/**
 * True when any entry of the list is a substring of the extracted sender, or of the document text
 * (the lab's name on any page; OCR may misread it on one page but rarely on all), or, for an entry
 * of digits, equals the sending fax number from MOATiT Fax.
 */
export function isListedSender(envName: string, who: { sender?: string; senderFax?: string; text?: string }): boolean {
  const entries = senderList(envName);
  if (!entries.length) return false;
  const sender = collapse(who.sender);
  const text = collapse(who.text);
  const fax = String(who.senderFax || '').replace(/\D/g, '').slice(-10);
  return entries.some((e) => {
    const digits = e.replace(/\D/g, '');
    if (digits.length >= 10 && digits === e.replace(/[\s()+.-]/g, '')) return !!fax && digits.slice(-10) === fax;
    return (!!sender && sender.includes(e)) || (!!text && text.includes(e));
  });
}

// ── One page ─────────────────────────────────────────────────────────────────

interface PageId {
  /** "last|first", letters only. */
  name?: string;
  dob?: string;
  mrn?: string;
}

interface PageRead {
  n: number;
  ids: PageId;
  /** Name + DOB, or MRN. */
  full: boolean;
  /** The page itself names more than one patient. */
  multi: boolean;
  cover: boolean;
  /** Result lines above the first patient line: the end of the patient before, on this patient's page. */
  resultsAbove: number;
  /** A ruled-off block of results with no patient line of its own (see unlabelledBlock). */
  unlabelled: boolean;
}

/** A patient identifier label, loosely (as OCR reads it). */
const ID_LABEL = /\b(?:Patient(?:'s)?\s*Name|Patient\s*[:;!]|Pt\.?\s*Name|D[.,]?\s?[O0][.,]?\s?B\b|Date\s+of\s+Birth|Birth\s*Date|MRN|Patient\s*[I1l]D|Med\w{0,5}\.?\s*Re[a-z]{1,4}\.?\s*(?:#|No\b|Num|[:;]))|(?:^|\s)PT\s*[:;!]/i;
/** A result row in columns: a test code, a gap, a value ("CREAT      2.41H", "K   4.1", "Sodium     139"). */
const RESULT_ROW = /^\W{0,3}[A-Za-z][A-Za-z0-9,/()-]{0,15}(?: [A-Za-z0-9,/()-]{1,12}){0,2}\s{2,}[<>]?\d+(?:[.,]\d+)?/;

/** A ruled line that separates blocks (patients) in batch reports: "------", "======", "______". */
const RULE_LINE = /^\W{0,3}[-=_*~]{12,}\W{0,3}$/;

/**
 * A block after a ruled line that holds result rows but no patient line before the next one: a
 * second patient on the page whose identifiers are unreadable (a packed batch page).
 */
function unlabelledBlock(text: string): boolean {
  let rows = -1; // -1: not inside a block that started with a rule
  for (const l of text.split('\n')) {
    if (RULE_LINE.test(l.trim())) {
      if (rows >= 2) return true;
      rows = 0;
    } else if (ID_LABEL.test(l)) {
      rows = -1;
    } else if (rows >= 0 && RESULT_ROW.test(l)) {
      rows++;
    }
  }
  return rows >= 2;
}

/**
 * Batch senders: three or more result codes repeated inside one patient's block (between patient lines,
 * before any history/prior section) mean a second set of results, most likely another patient whose
 * patient line and ruled separator OCR lost (seen on the bench: a packed batch page, the second
 * patient's identifiers blotted, every "------" rule dropped). One patient's results don't repeat a
 * test; a sender's cumulative history comes under its own heading.
 */
function repeatedResults(text: string): boolean {
  let seen = new Map<string, number>();
  let history = false;
  for (const l of text.split('\n')) {
    if (ID_LABEL.test(l) || RULE_LINE.test(l.trim())) {
      seen = new Map();
      history = false;
      continue;
    }
    if (/\b(?:history|prior|previous|cumulative|trend)\b/i.test(l)) history = true;
    if (history || !RESULT_ROW.test(l)) continue;
    const code = (l.replace(/^\W+/, '').match(/^[A-Za-z][A-Za-z0-9]*/) || [''])[0].toUpperCase();
    if (code.length < 1) continue;
    seen.set(code, (seen.get(code) || 0) + 1);
    if ([...seen.values()].filter((n) => n > 1).length >= 3) return true;
  }
  return false;
}

function resultsAboveFirstId(text: string): number {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => ID_LABEL.test(l));
  if (first <= 0) return 0;
  return lines.slice(0, first).filter((l) => RESULT_ROW.test(l)).length;
}

const usable = (c?: string) => c === 'high' || c === 'medium';
const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const normMrn = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '');

/** Fax cover sheet: "confidentiality notice" / "cover sheet", or two of To/Attn/From/Pages/Date labels at a line start. */
function looksLikeCover(text: string): boolean {
  if (/\b(?:fax\s+)?cover\s*sheet\b|\bconfidentiality\s+notice\b|\bfacsimile\s+transmittal\b/i.test(text)) return true;
  const labels = new Set((text.match(/^\W{0,3}(to|attn|from|pages?|date)\s*[:;]/gim) || []).map((l) => l.replace(/\W/g, '').toLowerCase()));
  return labels.size >= 2 && /\bfax\b/i.test(text);
}

function readPage(text: string, n: number, opts: SegmentOptions): PageRead {
  const x: ExtractedFields = extractFields(text, opts.now || new Date(), opts.ownName);
  const ids: PageId = {};
  if (x.patient_name && usable(x.patient_name.confidence)) ids.name = `${letters(x.patient_name.value.last)}|${letters(x.patient_name.value.first)}`;
  if (x.dob && usable(x.dob.confidence)) ids.dob = x.dob.value;
  if (x.mrn && usable(x.mrn.confidence)) ids.mrn = normMrn(x.mrn.value);
  const full = (!!ids.name && !!ids.dob) || !!ids.mrn;
  return {
    n,
    ids,
    full,
    multi: (x.patient_count ?? 0) > 1,
    cover: !full && looksLikeCover(text),
    resultsAbove: full ? resultsAboveFirstId(text) : 0,
    unlabelled: unlabelledBlock(text) || (opts.batch && repeatedResults(text)),
  };
}

/** True when the edit distance between a and b is at most k. */
function within(a: string, b: string, k: number): boolean {
  if (Math.abs(a.length - b.length) > k) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= k;
}

type Relation = 'same' | 'near' | 'different' | 'conflict' | 'unknown';

/**
 * How two sets of identifiers relate, over the fields both have: all equal = same; any one only
 * OCR-noise apart (name ≤ 2 edits, DOB 1 character, MRN 1 edit) = near; all clearly different =
 * different; some equal and some different = conflict; nothing shared = unknown.
 * One exception: the same MRN (5+ characters, read exactly on both pages) with the other fields
 * equal or only OCR-noise apart is the same patient. An MRN belongs to one patient; without an
 * exact MRN, near-identical pages (Daniel / Danielle, a misread DOB) still go to staff.
 */
function relate(a: PageId, b: PageId): Relation {
  const r: ('eq' | 'near' | 'diff')[] = [];
  if (a.name && b.name) r.push(a.name === b.name ? 'eq' : within(a.name.replace('|', ''), b.name.replace('|', ''), 2) ? 'near' : 'diff');
  if (a.dob && b.dob) r.push(a.dob === b.dob ? 'eq' : [...a.dob].filter((c, i) => c !== b.dob![i]).length <= 1 ? 'near' : 'diff');
  if (a.mrn && b.mrn) r.push(a.mrn === b.mrn ? 'eq' : within(a.mrn, b.mrn, 1) ? 'near' : 'diff');
  if (!r.length) return 'unknown';
  if (a.mrn && a.mrn === b.mrn && a.mrn.length >= 5 && !r.includes('diff')) return 'same';
  if (r.includes('near')) return 'near';
  if (r.every((x) => x === 'eq')) return 'same';
  if (r.every((x) => x === 'diff')) return 'different';
  return 'conflict';
}

// ── The document ─────────────────────────────────────────────────────────────

interface Group {
  ids: PageId;
  pages: number[];
}

const list = (ns: number[]) => (ns.length === 1 ? `page ${ns[0]}` : `pages ${ns.join(', ')}`);

/** Which patient each page belongs to, and what to do with the file. See the header comment. */
export function segmentPages(pageTexts: string[], opts: SegmentOptions): PageSegmentation {
  const count = pageTexts.length;
  const base = { batch_sender: opts.batch, page_count: count, cover_pages: [] as number[], patients: [] as PatientPages[] };
  const all = Array.from({ length: count }, (_, i) => i + 1);
  const review = (reason: string, checked = false): PageSegmentation => ({ ...base, decision: 'review', reason, checked });

  // Not a batch sender and one patient on the whole document: file it whole, as before.
  if (!opts.batch && opts.wholeCount <= 1) {
    return { ...base, decision: 'single', reason: 'One patient on the document.', checked: false, patients: [{ pages: all }] };
  }
  const who = opts.batch ? 'This sender sends batch reports, so every page must show the patient.' : '';
  if (opts.batch && opts.expectedPages === undefined && count === 1) {
    return review(`The page count of the file is unknown, so its pages can't be checked one by one. ${who}`);
  }
  if (opts.expectedPages !== undefined && opts.expectedPages !== count) {
    return review(`The text has ${count} page(s) but the file has ${opts.expectedPages}, so pages can't be told apart. ${who}`.trim());
  }

  const reads = pageTexts.map((t, i) => readPage(t, i + 1, opts));
  const groups: Group[] = [];
  const cover: number[] = [];
  let current: Group | null = null;
  for (const p of reads) {
    if (p.multi) return review(`Page ${p.n} shows more than one patient. Split it by hand.`);
    if (p.full && p.unlabelled) {
      return review(`Page ${p.n} has a block of results without a readable patient line (possibly a second patient). Check by hand.`);
    }
    if (p.full) {
      const rel = groups.map((g) => relate(p.ids, g.ids));
      const near = rel.findIndex((r) => r === 'near' || r === 'conflict');
      if (near >= 0) {
        return review(`The patient on page ${p.n} is almost, but not exactly, the same as on ${list(groups[near].pages)} (a misread, or two similar patients). Check by hand.`);
      }
      const same = groups.filter((_, i) => rel[i] === 'same');
      if (same.length > 1) return review(`Page ${p.n} matches more than one patient in the file. Check by hand.`);
      if (same.length === 1) {
        if (same[0] !== current) {
          return review(`The patient on page ${p.n} also appears on ${list(same[0].pages)}, with another patient in between. Check by hand.`);
        }
        current.pages.push(p.n);
        current.ids = { ...p.ids, ...current.ids }; // add identifiers the earlier pages lacked
        continue;
      }
      const unknown = groups.findIndex((_, i) => rel[i] === 'unknown');
      if (unknown >= 0) {
        return review(`Page ${p.n} can't be compared with ${list(groups[unknown].pages)}: different identifiers are readable on each. Check by hand.`);
      }
      if (p.resultsAbove >= 2) {
        // A new patient starts lower on this page; the results above have no patient line of their
        // own (the end of the patient before, or someone whose line is unreadable).
        return review(`Page ${p.n} has results above its patient line, which may belong to another patient. Check by hand.`);
      }
      current = { ids: { ...p.ids }, pages: [p.n] };
      groups.push(current);
      continue;
    }
    if (p.cover && !groups.length) {
      // A cover sheet's "RE:" may carry a name; it identifies nobody and is not a result page.
      cover.push(p.n);
      continue;
    }
    if (p.ids.name || p.ids.dob) {
      if (opts.batch) return review(`Page ${p.n} has no readable patient name and date of birth or MRN. ${who}`);
      if (!current) return review(`Page ${p.n} can't be assigned to a patient. Check by hand.`);
      if (relate(p.ids, current.ids) !== 'same') return review(`Page ${p.n} names a patient that doesn't match the page before it. Check by hand.`);
      current.pages.push(p.n);
      continue;
    }
    if (opts.batch) return review(`Page ${p.n} has no readable patient identifier. ${who}`);
    if (!current) return review(`Page ${p.n} can't be assigned to a patient. Check by hand.`);
    current.pages.push(p.n); // continuation page
  }

  const found = { ...base, cover_pages: cover, patients: groups.map((g) => ({ pages: g.pages })) };
  if (!groups.length) return { ...found, decision: 'review', reason: 'No page shows a readable patient name and date of birth or MRN.', checked: true };
  if (groups.length === 1) {
    if (opts.wholeCount > 1) {
      return { ...found, decision: 'review', reason: 'The document names more than one patient, but the pages could not be told apart. Check by hand.', checked: true };
    }
    return { ...found, decision: 'single', reason: `One patient on every page (${count} page(s) checked).`, checked: true };
  }
  for (const g of groups) {
    const part = extractFields(g.pages.map((n) => pageTexts[n - 1]).join('\f'), opts.now || new Date(), opts.ownName);
    if ((part.patient_count ?? 0) > 1) {
      return { ...found, decision: 'review', reason: `The part for ${list(g.pages)} still names more than one patient. Split it by hand.`, checked: true };
    }
  }
  if (opts.split === false) {
    return { ...found, decision: 'review', reason: `The document shows ${groups.length} patients. Automatic splitting is turned off: split it by hand.`, checked: true };
  }
  return {
    ...found,
    decision: 'split',
    reason: `${groups.length} patients: ${groups.map((g) => list(g.pages)).join('; ')}${cover.length ? ` (cover ${list(cover)})` : ''}.`,
    checked: true,
  };
}

// ── Glue for the pipeline (and the eval harness) ─────────────────────────────

/** INTAKE_SPLIT: on (default) splits multi-patient files into one part per patient; off sends them to staff. */
export function splitEnabled(): boolean {
  return !/^(off|false|0|no)$/i.test(String(process.env.INTAKE_SPLIT || '').trim());
}

/** The page check for one received document, with INTAKE_BATCH_SENDERS, INTAKE_SPLIT and the file's page count applied. */
export function segmentItem(
  item: Pick<IntakeItem, 'sender_fax' | 'ocr' | 'page_count'>,
  text: string,
  extracted: ExtractedFields,
  now: Date = new Date()
): PageSegmentation {
  const batch = isListedSender('INTAKE_BATCH_SENDERS', { sender: extracted.sender?.value, senderFax: item.sender_fax, text });
  const expected = item.ocr?.pages ?? item.page_count;
  return segmentPages(splitPages(text, expected), { batch, wholeCount: extracted.patient_count ?? 0, expectedPages: expected, split: splitEnabled(), now });
}

/** OCR facts for a part: its own pages' confidence (the whole file's mean when per-page values are missing). */
export function partOcr(ocr: IntakeItem['ocr'], pages: number[]): IntakeItem['ocr'] {
  if (!ocr) return undefined;
  const confs = ocr.page_confidences && ocr.page_confidences.length === ocr.pages ? pages.map((p) => ocr.page_confidences![p - 1]) : null;
  const mean = confs ? Math.round((10 * confs.reduce((a, b) => a + b, 0)) / confs.length) / 10 : ocr.mean_confidence;
  return { engine: ocr.engine, pages: pages.length, mean_confidence: mean, used_text_layer: ocr.used_text_layer, ...(confs ? { page_confidences: confs } : {}) };
}
