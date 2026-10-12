/**
 * Field extraction from a received document's text (MOATiT Fax OCR, or a text layer).
 *
 * Pure functions, heuristic regexes. OCR text is untrusted: every field carries a confidence and
 * the matcher (match.ts) decides what is good enough. Nothing here summarizes or rewrites the
 * clinical content; the original file is what gets filed.
 *
 * Confidence:
 *   high    the value sits next to an explicit label ("DOB:", "MRN:", "Patient Name:")
 *   medium  a weaker label ("Name:", "RE:", "Patient ID:"), a plain "Phone:" inside the patient
 *           block, or the sender's letterhead
 *   low     a guess; never used for patient matching
 *
 * Fax OCR (deploy/ocr) is noisy: a colon often comes back as ";" "," or "."; O/0 and l/1 swap inside
 * numbers; "DOB" reads as "D0B" or "D,O.B.". Labels and values here tolerate that, measured on the
 * synthetic bench (src/scripts/eval-intake.ts, docs/drawbridge/INTAKE_ACCURACY.md).
 *
 * patient_count: distinct patients named on the document (labelled names and dates of birth, OCR
 * noise allowed for). More than one (a daily batch report, a fax with two patients' results) means
 * staff must split the document; match.ts never files it to one chart.
 *
 * Sender templates (templates.ts, INTAKE_SENDER_TEMPLATES_DIR): when the document comes from a sender
 * with a template, that sender's labels, name order, date formats and MRN pattern are read first
 * (OCR-tolerant labels, 'high'); the generic reading of those lines is dropped. A template only changes
 * how fields are read, never what the matcher accepts.
 */
import { findTemplate, fitsDateFormat, templateValues, type SenderTemplate } from './templates';
export type Confidence = 'high' | 'medium' | 'low';
export type DocumentKind = 'lab_result' | 'imaging' | 'consult' | 'referral' | 'other';
export type DocumentSubtype =
  | 'ct' | 'mri' | 'chest_xray' | 'xray' | 'mammogram' | 'ultrasound' | 'nuclear'
  | 'pathology' | 'ekg' | 'stress_test' | 'colonoscopy'
  | 'discharge_summary' | 'history_physical' | 'op_note' | 'progress_note' | 'referral_letter' | 'insurance_card';

export interface Extracted<T = string> {
  value: T;
  confidence: Confidence;
}

export interface PatientName {
  first: string;
  last: string;
  /** "First Last" as written (middle names/initials kept). */
  full: string;
}

export interface AbnormalFlags {
  /** Any abnormal marker found (H/L flags, "ABNORMAL", critical/panic values). */
  flagged: boolean;
  critical: boolean;
  /** Result lines carrying an H/L/HH/LL flag. */
  flagged_lines: number;
  /** Distinct markers seen, e.g. ["H", "L", "ABNORMAL", "CRITICAL"]. */
  markers: string[];
}

export interface ExtractedFields {
  patient_name?: Extracted<PatientName>;
  /** MM/DD/YYYY */
  dob?: Extracted;
  mrn?: Extracted;
  /** Patient phone, 10 digits. */
  phone?: Extracted;
  /** Sending lab, office or facility. */
  sender?: Extracted;
  /** MM/DD/YYYY: specimen collection, exam or service date. */
  collection_date?: Extracted;
  kind: Extracted<DocumentKind>;
  /** Finer type for the chart category (e.g. ct, pathology, discharge_summary). Absent when unclear. */
  subtype?: Extracted<DocumentSubtype>;
  abnormal: AbnormalFlags;
  /** Distinct patients named on the document (0 when none could be read). */
  patient_count?: number;
  /**
   * Something like an MRN label is printed but no MRN could be read. The MRN might disagree, so
   * match.ts does not fall back to the phone as the second identifier.
   */
  mrn_unreadable?: boolean;
  /**
   * The patient's name and date of birth read the same everywhere they are labelled (pages, cover
   * sheet, repeated headers). false when some read differs (OCR noise); absent when nothing was read.
   */
  reads_agree?: boolean;
  /**
   * A number that looks like an identifier (5-10 digits, or a phone number) is printed in the patient
   * block (the name and DOB lines and the 3 lines after them) but was not read as the MRN or the
   * patient's phone. It may be an MRN or phone that disagrees, so the name_dob rule never files on it.
   */
  unread_identifier?: boolean;
  /**
   * Last 4 digits of the patient's SSN ("SSN: ***-**-1234", "xxx-xx-1234", "SSN Last 4: 1234"). A full
   * SSN printed on the document is never kept anywhere: only its last 4 digits are read.
   */
  ssn_last4?: Extracted;
  /** An SSN label is printed but no last 4 digits could be read (or two different ones were read). */
  ssn_unreadable?: boolean;
  /** The patient's address from the patient block (labelled "Address:", or a street line under the patient). */
  address?: Extracted<PatientAddress>;
  /** An address label is printed but no street number + street could be read from it. */
  address_unreadable?: boolean;
  /** Sender template used to read the fields (templates.ts). */
  template?: string;
}

export interface PatientAddress {
  /** Street line as read, unit included ("1234 W Juniper St Apt 4"). */
  line1: string;
  city?: string;
  /** Two letters. */
  state?: string;
  /** Five digits. */
  zip?: string;
}

// ── Dates ────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';

/** Date patterns found in faxed documents, first match wins. */
const DATE_PATTERNS: { re: RegExp; parts: (m: RegExpMatchArray) => [number, number, string] }[] = [
  // 2026-10-08
  { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, parts: (m) => [+m[2], +m[3], m[1]] },
  // 10/08/2026, 10-08-2026, 10.08.2026, 3/5/79
  { re: /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/, parts: (m) => [+m[1], +m[2], m[3]] },
  // Oct 8, 2026 / October 08 2026
  { re: new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'), parts: (m) => [MONTHS[m[1].toLowerCase().slice(0, 3)], +m[2], m[3]] },
  // 8 Oct 2026 / 08-Oct-2026
  { re: new RegExp(`\\b(\\d{1,2})[\\s-]+${MONTH_RE}[\\s-]+(\\d{4})\\b`, 'i'), parts: (m) => [MONTHS[m[2].toLowerCase().slice(0, 3)], +m[1], m[3]] },
];

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * First date in `s` as MM/DD/YYYY, or '' when none is valid. Two-digit years: `pastOnly` (birth
 * dates) puts them in the last 100 years; otherwise 20YY.
 */
export function normalizeDate(s: string, opts: { pastOnly?: boolean; now?: Date } = {}): string {
  const now = opts.now || new Date();
  for (const p of DATE_PATTERNS) {
    const m = s.match(p.re);
    if (!m) continue;
    const [month, day, y] = p.parts(m);
    let year = +y;
    if (y.length === 2) {
      const cur = now.getFullYear() % 100;
      year = opts.pastOnly ? (year > cur ? 1900 + year : 2000 + year) : 2000 + year;
    }
    if (!month || month > 12 || day < 1 || day > 31 || year < 1900 || year > now.getFullYear() + 1) continue;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1) continue; // Feb 30 etc.
    if (opts.pastOnly && d.getTime() > now.getTime()) continue;
    return `${pad2(month)}/${pad2(day)}/${year}`;
  }
  return '';
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** "DOB" as printed and as OCR reads it: DOB, D.O.B., D,O.B., D0B, DOR. */
const DOB_LABEL = String.raw`D[.,]?\s?[O0][.,]?\s?[BR8]\b\.?|Date\s+of\s+Birth|Birth\s*Date|Birthdate`;

/** Labels that end a value when several fields share one line ("Name: X   DOB: Y"). */
const NEXT_LABEL = new RegExp(
  String.raw`\s{2,}|\t|\s+(?=(?:${DOB_LABEL}|MRN|Med(?:ical)? Rec(?:ord)?|Sex|Gender|Age|Phone|Tel|PT PHONE|Acct|Account|ACC#|Accession|Patient [I1l]D|Chart|Coll\w*|Ordered|Ordering|Received|Reported|Resulted|Specimen|Fax|Provider|Physician|Referring|Location|Room|SSN|Client|Exam|Addr(?:ess)?)\b)`,
  'i'
);

/** Separators OCR leaves between a label and its value (":" read as ";" "," "." and stray marks). */
const LEAD_JUNK = /^[\s:;!,#.\-_'"|‘’“”~]+/;

/** Every value after `label` (one per matching line), cut at the next label. */
function labeledAll(lines: string[], label: RegExp): { value: string; line: number }[] {
  const out: { value: string; line: number }[] = [];
  lines.forEach((line, i) => {
    const m = line.match(label);
    if (!m || m.index === undefined) return;
    const rest = line.slice(m.index + m[0].length).replace(LEAD_JUNK, '');
    const cut = rest.split(NEXT_LABEL)[0].trim();
    if (cut) out.push({ value: cut, line: i });
  });
  return out;
}

/** Inside a number, OCR reads 0 as O/o/D and 1 as l/I/|: "1O/O4/l971" → "10/04/1971". */
export function fixDigits(s: string): string {
  return s
    .replace(/(?<=[\d/.-])[OoD](?=[\d/.-])|(?<=\d)[OoD]\b|\b[OoD](?=\d)/g, '0')
    .replace(/(?<=[\d/.-])[lI|](?=[\d/.-])|(?<=\d)[lI|]\b|\b[lI|](?=\d)/g, '1');
}

// ── Patient name ─────────────────────────────────────────────────────────────

const NAME_TOKEN = /^[A-Za-z][A-Za-z'’-]*\.?$/;
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
/** Words that show a "RE:" or "Name:" line is not a person ("RE: Lab results", "RE: Report attached"). */
const NOT_A_NAME = new Set(
  'report reports result results lab labs laboratory records record attached requested request patient patients your for the of and fax cover page pages information info notes consult consultation letter referral imaging study test tests document documents copy'.split(' ')
);
/** Surname particles: "Maxine Van Wyk", "Rosa De La Cruz", "Ann St. Clair". */
const PARTICLES = new Set(['van', 'von', 'de', 'del', 'della', 'la', 'le', 'da', 'di', 'du', 'st', 'st.', 'ten', 'ter', 'den', 'der', 'des']);

/** "LAST, FIRST M" or "First M. Last" → name parts; null when it doesn't look like a name. */
export function parseName(raw: string): PatientName | null {
  const s = raw
    .replace(/\s+/g, ' ')
    .replace(/[;|]+.*$/, '')
    .replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, '')
    .replace(/\s*,\s*/, ', ')
    .trim();
  if (!s || s.length > 60 || /\d/.test(s)) return null;
  if (s.toLowerCase().split(/[\s,]+/).some((t) => NOT_A_NAME.has(t.replace(/\.$/, '')))) return null;
  let first = '';
  let last = '';
  let middle: string[] = [];
  const comma = s.match(/^([^,]+),\s*(.+)$/);
  if (comma) {
    const lastParts = comma[1].trim().split(' ');
    const rest = comma[2].trim().split(' ');
    if (!lastParts.every((t) => NAME_TOKEN.test(t)) || !rest.every((t) => NAME_TOKEN.test(t))) return null;
    if (lastParts.length === 2 && /^[A-Za-z]\.?$/.test(lastParts[1]) && rest.length === 1) {
      // "Bernard P, Colfax": OCR read the middle initial's period as a comma. No surname ends in an
      // initial, so this is First M. Last.
      first = lastParts[0];
      middle = [lastParts[1]];
      last = rest[0];
    } else {
      last = lastParts.join(' ');
      first = rest[0];
      middle = rest.slice(1);
    }
  } else {
    const parts = s.split(' ').filter((t) => !/^(mr|mrs|ms|miss|dr)\.?$/i.test(t));
    if (parts.length < 2 || parts.length > 5 || !parts.every((t) => NAME_TOKEN.test(t))) return null;
    let k = parts.length - 1; // first token of the last name
    while (k > 1 && PARTICLES.has(parts[k - 1].toLowerCase())) k--;
    first = parts[0];
    last = parts.slice(k).join(' ');
    middle = parts.slice(1, k);
    if (middle.length > 2) return null;
  }
  first = titleCase(first.replace(/\.$/, ''));
  last = titleCase(last.replace(/\.$/, ''));
  if (first.length < 2 || last.length < 2) return null;
  return { first, last, full: [first, ...middle.map(titleCase), last].join(' ') };
}

const NAME_LABELS: [RegExp, Confidence][] = [
  [/\bPatient(?:'s)?\s*Name\b/i, 'high'],
  [/\bPatient\s*[:;]/i, 'high'],
  [/\bPt\.?\s*Name\b/i, 'high'],
  [/(?:^|\s)PT\s*[:;!]/i, 'high'],
  [/\b(?:RE|Regarding)\s*[:;]/i, 'medium'],
  [/^\W{0,3}Name\s*[:;]/i, 'medium'],
];

/** Every labelled name on the document, best label first. */
function allNames(lines: string[]): { name: PatientName; confidence: Confidence; line: number }[] {
  const out: { name: PatientName; confidence: Confidence; line: number }[] = [];
  for (const [label, confidence] of NAME_LABELS) {
    for (const v of labeledAll(lines, label)) {
      const name = parseName(v.value);
      if (name) out.push({ name, confidence, line: v.line });
    }
  }
  return out;
}

// ── Other fields ─────────────────────────────────────────────────────────────

const DOB_RE = new RegExp(String.raw`\b(?:${DOB_LABEL})`, 'i');

/** Every labelled date of birth (MM/DD/YYYY), in document order. */
function allDobs(lines: string[], now: Date): { value: string; line: number }[] {
  return labeledAll(lines, DOB_RE)
    .map((v) => ({ value: normalizeDate(fixDigits(v.value), { pastOnly: true, now }), line: v.line }))
    .filter((v) => v.value);
}

const MRN_VALUE = /^#?\s*([A-Z0-9][A-Z0-9-]{2,19})\b/i;
/**
 * Anything that looks like an MRN label, even badly read ("Med Ree #", "M RN"). See mrn_unreadable.
 * "Med Rec" needs a #, No, Num or colon after it, so prose ("medical renal disease") doesn't count.
 */
const MRN_LABEL_LOOSE = /\b(?:M\s?R\s?N\b|Med\w{0,5}\.?\s*Re[a-z]{1,4}\.?\s*(?:#|No\b|Num|[:;])|Chart\s*(?:#|No\b|Num)|Patient\s*[I1l]D\b)/i;
/** Every labelled MRN on the document, high-confidence labels first. */
function allMrns(lines: string[]): (Extracted & { line: number })[] {
  const tries: [RegExp, Confidence][] = [
    [/\b(?:MRN|Med(?:ical)?\.?\s*Re[ce](?:ord)?\.?\s*(?:Number|No\.?|#)?|Chart\s*(?:Number|No\.?|#))/i, 'high'],
    [/\bPatient\s*[I1l]D\b/i, 'medium'],
  ];
  const out: (Extracted & { line: number })[] = [];
  for (const [label, confidence] of tries) {
    for (const v of labeledAll(lines, label)) {
      const val = mrnValue(v.value);
      if (val) out.push({ value: val, confidence, line: v.line });
    }
  }
  return out;
}

/** The MRN at the start of a labelled value, OCR digit swaps undone; '' when there is none. */
function mrnValue(value: string): string {
  // OCR splits digits with a single space ("005696 14"); values are already cut at double spaces.
  const m = value.replace(/(?<=\d) (?=\d)/g, '').match(MRN_VALUE);
  if (!m || !/\d/.test(m[1])) return '';
  // Mostly digits: undo O/0 and l/1 swaps ("4O2449O" → "4024490"). Letter MRNs stay as read.
  const raw = m[1].toUpperCase();
  return (raw.match(/\d/g) || []).length >= raw.length - 2 ? raw.replace(/[OD]/g, '0').replace(/[IL|]/g, '1') : raw;
}

// ── Sender templates ─────────────────────────────────────────────────────────

interface TemplateReads {
  names: { name: PatientName; confidence: Confidence; line: number }[];
  dobs: { value: string; line: number }[];
  mrns: (Extracted & { line: number })[];
  phone?: Extracted;
  /** An MRN label of the template whose value does not fit its pattern. */
  mrnBad: boolean;
  /** Lines the template read, per field: the generic reading of these lines is not used. */
  claimed: { name: Set<number>; dob: Set<number>; mrn: Set<number> };
}

const cut = (v: string) => v.replace(LEAD_JUNK, '').split(NEXT_LABEL)[0].trim();

function templateReads(lines: string[], t: SenderTemplate, now: Date): TemplateReads {
  const r: TemplateReads = { names: [], dobs: [], mrns: [], mrnBad: false, claimed: { name: new Set(), dob: new Set(), mrn: new Set() } };
  const f = t.fields;
  if (f.name) {
    for (const v of templateValues(lines, f.name.labels)) {
      let raw = cut(v.value);
      const parts = raw.split(/\s+/);
      if (f.name.order === 'last_first' && !raw.includes(',') && parts.length === 2) raw = `${parts[0]}, ${parts[1]}`;
      const name = parseName(raw);
      if (!name) continue;
      r.names.push({ name, confidence: 'high', line: v.line });
      r.claimed.name.add(v.line);
    }
  }
  if (f.dob) {
    for (const v of templateValues(lines, f.dob.labels)) {
      r.claimed.dob.add(v.line);
      const raw = fixDigits(cut(v.value));
      if (!fitsDateFormat(raw, f.dob.formats)) continue;
      const d = normalizeDate(raw, { pastOnly: true, now });
      if (d) r.dobs.push({ value: d, line: v.line });
    }
  }
  if (f.mrn) {
    const pattern = f.mrn.pattern ? new RegExp(f.mrn.pattern) : null;
    for (const v of templateValues(lines, f.mrn.labels)) {
      r.claimed.mrn.add(v.line);
      const val = mrnValue(cut(v.value));
      if (!val || (pattern && !pattern.test(val))) {
        r.mrnBad = true;
        continue;
      }
      r.mrns.push({ value: val, confidence: 'high', line: v.line });
    }
  }
  if (f.phone) {
    for (const v of templateValues(lines, f.phone.labels)) {
      const d = fixDigits(cut(v.value)).replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '');
      if (/^\d{10}$/.test(d)) {
        r.phone = { value: d, confidence: 'high' };
        break;
      }
    }
  }
  return r;
}

// ── Third identifiers: SSN last 4 and address ────────────────────────────────

/**
 * An SSN label as printed and as OCR reads it: SSN, S.S.N., SS#, S5N, Soc Sec #, Social Security No.,
 * optionally followed by "Last 4" / "(last 4)" / "L4".
 */
const SSN_LABEL = String.raw`(?:\bS[.,]?\s?[S5][.,]?\s?N\b\.?|\bSS\s?#|\bS[o0]c(?:ial)?\.?\s*S[e3][ce](?:urity)?\.?(?:\s*(?:No\b\.?|Num(?:ber)?\b|#))?)(?:\s*\(?\s*(?:l\w{2,3}\s*(?:4|four)|L4)\b\s*\)?)?`;
const SSN_LABEL_RE = new RegExp(SSN_LABEL, 'i');
/** A masked SSN: "***-**-1234", "XXX-XX-1234", "xxx xx 1234", "###-##-1234" (OCR reads * as + or ., X as x). */
const SSN_MASKED = /^[*xX#•+.]{3}[\s-]?[*xX#•+.]{2}[\s-]?(\d{4})(?!\d)/;
/** A mask OCR garbled ("**¥-**-5846", "***-\"*-5200", "eee *KRK_-0185"): 3-16 non-digits, then the last 4. */
const SSN_MASK_NOISY = /^([^\d\n]{3,16}?)(\d{4})(?!\d)/;
/** A full SSN: "912-34-5678", "912 34 5678", "912345678". Only its last 4 digits are ever kept. */
const SSN_FULL = /^(\d{3})[\s-]?(\d{2})[\s-]?(\d{4})(?!\d)/;
/** Just the last 4 ("SSN Last 4: 1234", "SSN: 1234"). */
const SSN_LAST4 = /^(\d{4})(?![\d-])/;
/** Anything that looks like a full SSN with dashes, for redaction anywhere in a text. */
const SSN_FULL_ANY = /\b(\d{3})-(\d{2})-(\d{4})\b/g;

/**
 * The last 4 digits at the start of an SSN label's value ('' when there are none): 'high' for a clean
 * mask, full SSN or last 4, 'medium' for a mask OCR garbled.
 */
function ssnLast4Of(value: string): { last4: string; confidence: Confidence } | null {
  const v = fixDigits(value.replace(LEAD_JUNK, '')).trim();
  const m = v.match(SSN_MASKED) || v.match(SSN_FULL);
  if (m) return { last4: m[m.length - 1], confidence: 'high' };
  const l = v.match(SSN_LAST4);
  if (l) return { last4: l[1], confidence: 'high' };
  const n = v.match(SSN_MASK_NOISY);
  // A garbled mask: mostly mask-like marks, never words ("on file 1234", "see chart 1234").
  if (n && (n[1].match(/[*xX#•+.\-"'¥§_~]/g) || []).length >= 3 && !/[a-wyz]{3,}/i.test(n[1])) return { last4: n[2], confidence: 'medium' };
  return null;
}

/**
 * The SSN's last 4 from every SSN label on the document. Two different last-4 values (another person's
 * SSN, or a misread) make it unreadable: nothing to compare with.
 */
function extractSsn(lines: string[]): { last4?: Extracted; unreadable: boolean } {
  const reads: { last4: string; confidence: Confidence }[] = [];
  let labels = 0;
  for (const line of lines) {
    const m = line.match(SSN_LABEL_RE);
    if (!m || m.index === undefined) continue;
    labels++;
    const r = ssnLast4Of(line.slice(m.index + m[0].length));
    if (r) reads.push(r);
  }
  const distinct = [...new Set(reads.map((r) => r.last4))];
  if (distinct.length === 1) return { last4: { value: distinct[0], confidence: reads.some((r) => r.confidence === 'high') ? 'high' : 'medium' }, unreadable: false };
  return { unreadable: labels > 0 };
}

/**
 * Mask every full SSN in a text, keeping the last 4 ("912-34-5678" → "***-**-5678"): after an SSN label
 * in any form, and anywhere in the dashed or spaced 3-2-4 form. Used before a document's text is stored.
 */
export function redactSsn(text: string): string {
  const s = String(text ?? '');
  const labelled = new RegExp(`(${SSN_LABEL})(\\s*[:;!,#.\\-_'"|]*\\s*)(\\d{3})[\\s-]?(\\d{2})[\\s-]?(\\d{4})(?!\\d)`, 'gi');
  return s.replace(labelled, (_m, label, sep, _a, _b, last) => `${label}${sep}***-**-${last}`).replace(SSN_FULL_ANY, (_m, _a, _b, last) => `***-**-${last}`);
}

/** US state codes (and DC) for address lines. */
const STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ')
);
/** Street suffixes a street line ends with ("St", "Avenue", "Rd.", ...). */
const STREET_SUFFIX = String.raw`(?:St|Street|Str|Ave|Avenue|Av|Rd|Road|Dr|Drive|Blvd|Boulevard|Ln|Lane|Ct|Court|Pl|Place|Cir|Circle|Ter|Terrace|Pkwy|Parkway|Hwy|Highway|Way|Trl|Trail|Loop|Sq|Square|Xing|Crossing|Row|Run|Pass|Pike|Path)`;
/** "Address:" as printed and as OCR reads it ("Adatess:", "ARDR:"), at a line start or after a column gap. */
const ADDRESS_LABEL = /(?:^|\s{2,}|\t|(?<=\d)\s+)\W{0,3}(?:(?:Patient|Pt\.?|Home|Mailing|Street)\s+)?(?:Addr(?:ess)?|Ad\w{1,4}ss|A[DR]{2}R)\b\.?\s*[:;!,]/i;
/** A ZIP as fax OCR reads it: "$3706", "&3647", "§1302" ($ and & for 8, § and S for 5, O for 0). */
const fixZip = (s: string) => s.replace(/(?<=\s)[\d$&§SBO]{5}(?=(?:-\d{4})?\s*$)/, (z) => z.replace(/[$&B]/g, '8').replace(/[§S]/g, '5').replace(/O/g, '0'));
/** Where an address value ends: a column gap, or the next patient label on the same line. */
const ADDRESS_END = new RegExp(String.raw`\s{2,}|\t|\s+(?=(?:${DOB_LABEL}|MRN|SSN|Sex|Gender|Phone|Tel|Cell|Home\s+Phone|Patient\s+Phone|Acct|ACC#)\b\s*[:;#.!]?)`, 'i');
const firstSegment = (s: string) => String(s || '').trim().split(/\s{2,}|\t/)[0];
/** "Boise, ID 83704", "BOISE ID 83704-1234", "Boise, Idaho 83704" is not read (state must be two letters). */
const CITY_STATE_ZIP = /^\s*([A-Za-z][A-Za-z .'-]*?),?\s+([A-Za-z]{2})\.?\s+(\d{5})(?:-\d{4})?\s*$/;
const STREET_LINE = new RegExp(String.raw`^\s*(\d{1,6}[A-Za-z]?)\s+([A-Za-z0-9][A-Za-z0-9 .'#-]*?\b${STREET_SUFFIX}\b\.?(?:[ ,]+(?:N|S|E|W|NE|NW|SE|SW)\b\.?)?(?:[ ,]+(?:Apt|Apartment|Unit|Ste|Suite|Bldg|Lot|Spc|Space|Rm|Room|Fl|Floor|#)\.?\s*#?\s*[A-Za-z0-9-]+)?)\s*$`, 'i');

/** Street line + city/state/zip from an address value (and the line after it when the value has no ZIP). */
function parseAddress(value: string, next: string): PatientAddress | null {
  const v = fixZip(fixDigits(value.replace(LEAD_JUNK, '')).replace(/\s+/g, ' ').trim());
  const box =v.match(/^P\.?\s?O\.?\s?Box\s+(\d+)\b,?\s*(.*)$/i);
  if (box) {
    const m = fixZip(box[2] || fixDigits(firstSegment(next))).match(CITY_STATE_ZIP);
    return { line1: `PO Box ${box[1]}`, ...(m && STATES.has(m[2].toUpperCase()) ? { city: m[1].trim(), state: m[2].toUpperCase(), zip: m[3] } : {}) };
  }
  const parts = v.split(/\s*,\s*/).filter(Boolean);
  // "1234 W Juniper St, Apt 4, Boise, ID 83704" / "1234 W Juniper St Boise ID 83704" / "1234 W Juniper St"
  let line1 = parts[0] || '';
  let rest = parts.slice(1);
  if (rest.length && /^(?:Apt|Apartment|Unit|Ste|Suite|Bldg|Lot|Spc|Space|Rm|Room|Fl|Floor|#)\b/i.test(rest[0])) {
    line1 = `${line1} ${rest[0]}`;
    rest = rest.slice(1);
  }
  let csz = rest.join(', ');
  if (!rest.length) {
    // City, state and ZIP on the street line without commas: take them off the end.
    const tail = line1.match(/^(.*\b(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Ln|Lane|Ct|Court|Pl|Way|Cir|Hwy|Pkwy|Loop|Trl)\b\.?(?:\s+(?:Apt|Unit|Ste|Suite|#)\.?\s*#?\s*\w+)?)\s+([A-Za-z][A-Za-z .'-]*\s+[A-Za-z]{2}\s+\d{5}(?:-\d{4})?)$/i);
    if (tail) [line1, csz] = [tail[1], tail[2]];
  }
  if (!/^\d{1,6}[A-Za-z]?\s+[A-Za-z0-9]/.test(line1) || !/[A-Za-z]{2}/.test(line1.replace(/^\d+\S*\s*/, ''))) return null;
  const out: PatientAddress = { line1: line1.replace(/[.,]+$/, '') };
  const m = fixZip(csz || fixDigits(firstSegment(next)).replace(/^\W+/, '') || '').match(CITY_STATE_ZIP);
  if (m && STATES.has(m[2].toUpperCase())) {
    out.city = m[1].trim();
    out.state = m[2].toUpperCase();
    out.zip = m[3];
  } else {
    const zip = (csz || '').match(/\b(\d{5})(?:-\d{4})?\s*$/);
    if (zip) out.zip = zip[1];
  }
  return out;
}

/**
 * The patient's address: an "Address:" label ('high'), or a street line with a street suffix in the
 * patient block (the name and DOB lines and the 3 after them, 'medium'), with city, state and ZIP on
 * the same or the next line. The sender's letterhead is never in the patient block. Two different
 * addresses read make it unreadable.
 */
function extractAddress(lines: string[], block: number[]): { address?: Extracted<PatientAddress>; unreadable: boolean; lines: Map<number, string[]> } {
  const found: { a: PatientAddress; confidence: Confidence }[] = [];
  const spans = new Map<number, string[]>();
  const keep = (i: number, s: string) => spans.set(i, [...(spans.get(i) || []), s]);
  let labelled = 0;
  let streetUnread = false;
  lines.forEach((line, i) => {
    const m = line.match(ADDRESS_LABEL);
    if (!m || m.index === undefined) return;
    labelled++;
    const value = line.slice(m.index + m[0].length).replace(LEAD_JUNK, '').split(ADDRESS_END)[0].trim();
    // The city line: the next line, or the one after an empty line OCR left in between.
    const j = !String(lines[i + 1] || '').trim() && String(lines[i + 2] || '').trim() ? i + 2 : i + 1;
    const next = lines[j] || '';
    const a = parseAddress(value, next);
    if (!a) return;
    keep(i, value);
    if (a.zip && !fixZip(fixDigits(value)).includes(a.zip)) keep(j, firstSegment(next));
    found.push({ a, confidence: 'high' });
  });
  if (!found.length) {
    const rows = new Set<number>();
    for (const b of block) for (let i = b; i <= b + 3 && i < lines.length; i++) rows.add(i);
    for (const i of [...rows].sort((a, b) => a - b)) {
      for (const seg of lines[i].split(/\s{2,}|\t/)) {
        const s = fixDigits(seg.replace(/^\W{0,3}/, '')).trim();
        if (!STREET_LINE.test(s.split(/\s*,\s*(?=[A-Za-z][A-Za-z .'-]*,?\s+[A-Za-z]{2}\s+\d{5})/)[0])) continue;
        const a = parseAddress(s, lines[i + 1] || '');
        if (!a || !a.zip) {
          // Unlabelled: only with a city, state and ZIP to back it. A street line next to the patient
          // without them can't be checked, and might disagree.
          streetUnread = true;
          continue;
        }
        keep(i, seg);
        if (!s.includes(a.zip)) keep(i + 1, firstSegment(lines[i + 1] || ''));
        found.push({ a, confidence: 'medium' });
      }
    }
  }
  const key = (a: PatientAddress) => a.line1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const distinct = [...new Set(found.map((f) => key(f.a)))];
  const zips = new Set(found.map((f) => f.a.zip).filter(Boolean));
  if (distinct.length === 1 && zips.size <= 1) {
    const best = found.find((f) => f.a.zip) || found[0];
    return { address: { value: best.a, confidence: best.confidence }, unreadable: false, lines: spans };
  }
  return { unreadable: labelled > 0 || found.length > 0 || streetUnread, lines: spans };
}

// ── Unread identifiers in the patient block ──────────────────────────────────

const DATE_ANY = /\b\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}\b/g;
const PHONE_ANY = /\(?\b\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/g;
const STATE_ZIP = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g;
const TIME_ANY = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
/** Numbers that say what they are: accession, specimen, order, account, batch numbers. */
const NAMED_NUMBER = /\b(?:Acc\w*|Specimen(?:\s*ID)?|Order\w*|Req\w*|Acct|Account|Batch|Lab\s*ID|Ref(?:erence)?\s*(?:#|No))\s*[#:;.!]*\s*\S+/gi;

/**
 * True when the patient block (lines with the name or DOB and the 3 after them) shows a number that
 * looks like an MRN (5-10 digits) or a phone that was not read as the document's MRN or patient phone.
 * Dates, times, "ID 83704" style zip codes and numbers after an accession, specimen, order, account
 * or batch label don't count.
 */
function unreadIdentifier(lines: string[], block: number[], mrns: string[], phone: string, skip: Map<number, string[]> = new Map()): { kind: 'mrn' | 'phone' | null; ssn: boolean } {
  const rows = new Set<number>();
  for (const b of block) for (let i = b; i <= b + 3 && i < lines.length; i++) rows.add(i);
  const known = new Set(mrns.map((m) => m.replace(/^0+(?=.)/, '')));
  let ssnSeen = false;
  for (const i of rows) {
    // The patient's address (street number, ZIP) and SSN were read as what they are: not MRNs or phones.
    let raw = lines[i];
    for (const s of skip.get(i) || []) raw = raw.replace(s, ' ');
    const ssn = raw.match(SSN_LABEL_RE);
    if (ssn && ssn.index !== undefined) raw = raw.slice(0, ssn.index) + ' ' + raw.slice(ssn.index + ssn[0].length).replace(/^\W*(?:[*xX#•+.\d]{3}[\s-]?[*xX#•+.\d]{2}[\s-]?\d{4}|\d{4})/, ' ');
    // An SSN (full or masked) whose label OCR lost ("Soc See #: 946-41-9100" read before the label
    // was tolerated): it may be someone else's, so it counts as unread (before dates swallow it).
    if (/\b\d{3}-\d{2}-\d{4}\b|[*xX#]{3}-[*xX#]{2}-\d{4}\b/.test(fixDigits(raw))) ssnSeen = true;
    const l = fixDigits(raw).replace(NAMED_NUMBER, ' ').replace(DATE_ANY, ' ').replace(TIME_ANY, ' ').replace(STATE_ZIP, ' ');
    for (const m of l.match(PHONE_ANY) || []) {
      const d = m.replace(/\D/g, '');
      if (d.length === 10 && d !== phone) return { kind: 'phone', ssn: ssnSeen };
    }
    for (const m of l.replace(PHONE_ANY, ' ').replace(/(?<=\d) (?=\d)/g, '').match(/(?<![A-Za-z0-9])\d{5,10}(?![A-Za-z0-9])/g) || []) {
      if (!known.has(m.replace(/^0+(?=.)/, ''))) return { kind: 'mrn', ssn: ssnSeen };
    }
  }
  return { kind: null, ssn: ssnSeen };
}

/**
 * Patient phone. "Patient/Home/Cell Phone" is high. A plain "Phone:" is the sender's in a letterhead
 * but the patient's inside the patient block, so it counts (medium) only within a few lines after
 * the patient's name or date of birth; elsewhere it is low and never used for matching.
 */
function extractPhone(lines: string[], blockLines: number[]): Extracted | undefined {
  const digitsOf = (v: string) => fixDigits(v).replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '');
  for (const v of labeledAll(lines, /\b(?:Patient|Pt\.?|Home|Cell|Mobile)\s*(?:Phone|Tel(?:ephone)?|#)/i)) {
    const d = digitsOf(v.value);
    if (/^\d{10}$/.test(d)) return { value: d, confidence: 'high' };
  }
  let low: Extracted | undefined;
  for (const v of labeledAll(lines, /^\W{0,3}(?:Phone|Tel(?:ephone)?|Ph)\s*[:;#.]?(?=\s|\d|\()(?!.*\bfax\b)/i)) {
    const d = digitsOf(v.value);
    if (!/^\d{10}$/.test(d)) continue;
    if (blockLines.some((b) => v.line > b && v.line - b <= 4)) return { value: d, confidence: 'medium' };
    low = low || { value: d, confidence: 'low' };
  }
  return low;
}

/** Lab companies that commonly fax results; a name match is medium confidence. */
const KNOWN_SENDERS = ['Quest Diagnostics', 'LabCorp', 'Labcorp', 'ARUP Laboratories', 'Mayo Clinic Laboratories', 'Sonic Healthcare', 'BioReference', 'St. Luke’s', "St. Luke's", 'Saint Alphonsus'];

/** Words that make a letterhead line an organization: "Larkspur Reference Laboratories". */
const ORG_WORD =
  /\b(?:Lab|Labs|Laborator(?:y|ies)|Diagnostics?|Clinic|Hospital|Medical\s+Center|Health|Imaging|Radiology|Associates|Group|Center|Centre|Surgery|Cardiology|Urology|Nephrology|Endocrin\w*|Pathology|Physicians|Practice)\b/i;
/** A fax machine's header line: "10/09/2026 15:01 FROM: 2085550163 ... P.001/002", "... p1". */
const FAX_HEADER_LINE = /\b(?:P\.?\s?\d{1,3}\s?\/\s?\d{1,3}|p\d{1,2}|Page\s+\d+\s*\/\s*\d+)\s*$|\bTO:\s*\d{7,}|\d{10}.*\b\d{1,2}:\d{2}|\b\d{1,2}:\d{2}.*\d{10}/i;

/**
 * The sending organization, in order: a "Performing/Reporting Lab" line, a cover sheet "From:"
 * (not the fax machine's header line), "Lab:/Clinic:" labels, the letterhead (the first lines that
 * name an organization; two-column lines are split), a well-known lab name. `ownName` (the
 * receiving practice) is never the sender. Display only: never used for matching.
 */
function extractSender(lines: string[], text: string, ownName: string): Extracted | undefined {
  const clean = (v: string) =>
    v
      .replace(/\s*\(?\b(?:fax|ph|phone|tel|telephone)\b.*$/i, '')
      .replace(/,?\s+[A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?,?\s+[A-Z1l]{2}\s+[\d$]{5}.*$/, '') // ", Nampa, ID 83651 ..."
      .replace(/^[^A-Za-z]+|[^A-Za-z)]+$/g, '')
      .trim();
  const own = ownName.toLowerCase();
  const ok = (v: string) =>
    v.length >= 4 && v.length <= 80 && /[A-Za-z]{3}/.test(v) && !/\d{5,}/.test(v) && (!own || !v.toLowerCase().includes(own));
  const body = lines.filter((l) => !FAX_HEADER_LINE.test(l));
  const tries: [RegExp, Confidence][] = [
    [/\b(?:Performing|Reporting)\s+(?:Lab(?:oratory)?|Facility|Site)\b/i, 'high'],
    [/^\W{0,3}(?:From|Sender|Sent by)\s*[:;]?(?=\s)/i, 'high'],
    [/^\W{0,3}(?:Laboratory|Lab|Facility|Practice|Clinic)\s*[:;]/i, 'medium'],
  ];
  for (const [label, confidence] of tries) {
    for (const v of labeledAll(body, label)) {
      const c = clean(v.value);
      if (ok(c)) return { value: c, confidence };
    }
  }
  for (const s of KNOWN_SENDERS) if (text.toLowerCase().includes(s.toLowerCase())) return { value: s, confidence: 'medium' };
  let seen = 0;
  for (const line of body) {
    if (!line.trim()) continue;
    if (++seen > 8) break;
    for (const part of line.split(/\s{2,}|\t|\s[|-]\s/)) {
      const c = clean(part);
      if (ORG_WORD.test(c) && ok(c) && !/^(?:to|attn|client|re)\b/i.test(c) && !/\b(?:report|results?)\s*$/i.test(c)) {
        return { value: c, confidence: 'medium' };
      }
    }
  }
  return undefined;
}

function extractCollectionDate(lines: string[], now: Date): Extracted | undefined {
  const tries: [RegExp, Confidence][] = [
    [/\b(?:Date\s+)?Coll\w*(?:\s+(?:Date\/Time|Date|On|Time))?\b|\bSpecimen\s+Coll\w*/i, 'high'],
    [/\b(?:Exam|Study|Procedure|Service)\s+Date\b|\bDate\s+of\s+(?:Exam|Service|Study|Visit|Consultation)\b|\bDOS\b/i, 'medium'],
  ];
  for (const [label, confidence] of tries) {
    for (const v of labeledAll(lines, label)) {
      const d = normalizeDate(fixDigits(v.value), { now });
      if (d) return { value: d, confidence };
    }
  }
  return undefined;
}

const usableConf = (c?: Confidence) => c === 'high' || c === 'medium';

// ── Patients on the document ─────────────────────────────────────────────────

/** True when the edit distance between a and b is at most k. */
function within(a: string, b: string, k: number): boolean {
  if (Math.abs(a.length - b.length) > k) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...cur) > k) return false;
    prev = cur;
  }
  return prev[b.length] <= k;
}

/**
 * Distinct people named on the document: labelled names count as one when they differ by OCR noise
 * only (edit distance ≤ 2 on last + first), dates of birth when they differ in one character, MRNs
 * when they differ by one edit. Returns the largest of the three counts, so a second patient is
 * caught even when OCR loses that patient's name or DOB label (seen on the bench: "PT:" read as
 * "Pri", "DOB" as "NOB", while both MRNs were still readable). Two different MRN values for one
 * patient also count as two: that document needs a person anyway.
 */
function countPatients(names: PatientName[], dobs: string[], mrns: string[]): number {
  const distinct = (xs: string[], same: (a: string, b: string) => boolean) =>
    xs.reduce<string[]>((acc, x) => (acc.some((y) => same(x, y)) ? acc : [...acc, x]), []).length;
  return Math.max(
    distinct(
      names.map((n) => `${n.last}${n.first}`.toLowerCase().replace(/[^a-z]/g, '')),
      (a, b) => within(a, b, 2)
    ),
    distinct(dobs, (a, b) => [...a].filter((ch, i) => ch !== b[i]).length <= 1),
    distinct(
      mrns.map((m) => m.replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '')),
      (a, b) => within(a, b, 1)
    )
  );
}

/**
 * The value read most often among the reads that are the first read's patient up to OCR noise
 * (`near`). Ties go to the earliest read. unanimous: every read in that group is the same value.
 * null when there are no reads.
 */
function vote<T>(reads: T[], key: (r: T) => string, near: (a: string, b: string) => boolean): { key: string; unanimous: boolean } | null {
  if (!reads.length) return null;
  const seed = key(reads[0]);
  const group = reads.map(key).filter((k) => k === seed || near(k, seed));
  const counts = new Map<string, number>();
  for (const k of group) counts.set(k, (counts.get(k) || 0) + 1);
  let best = seed;
  for (const k of group) if ((counts.get(k) || 0) > (counts.get(best) || 0)) best = k;
  return { key: best, unanimous: counts.size === 1 };
}

// ── Document kind ────────────────────────────────────────────────────────────

const KIND_TERMS: Record<Exclude<DocumentKind, 'other'>, [RegExp, number][]> = {
  lab_result: [
    [/\blab(?:oratory)?\s+(?:report|results?)\b/i, 3],
    [/\b(?:batch|test|in-office|point\s+of\s+care)\s+results\b/i, 3],
    [/\d\s*(?:mmol\/L|mg\/dL|g\/dL|U\/L|pg\/mL|ng\/mL|mg\/g)\b/i, 2],
    [/\breference\s+(?:range|interval)\b/i, 2],
    [/\bspecimen\b/i, 2],
    [/\bcollected\b/i, 1],
    [/\b(?:CBC|CMP|BMP|lipid panel|urinalysis|hemoglobin|creatinine|eGFR|potassium|sodium|BUN|A1c)\b/i, 1],
    [/\b(?:Quest Diagnostics|LabCorp|ARUP)\b/i, 1],
  ],
  imaging: [
    [/\bradiology\b/i, 3],
    [/\b(?:ultrasound|sonogram|CT|MRI|x-ray|radiograph|mammogra\w*|nuclear medicine|PET)\b/i, 2],
    [/\bimpression\s*:/i, 1],
    [/\bfindings\s*:/i, 1],
    [/\btechnique\s*:/i, 1],
    [/\bcontrast\b/i, 1],
  ],
  consult: [
    [/\bconsult(?:ation)?\s+(?:note|report|letter)\b/i, 3],
    [/\bthank you for (?:referring|the referral|allowing)\b/i, 3],
    [/\bdear\s+dr\.?\b/i, 1],
    [/\bassessment\s+(?:and|&)\s+plan\b/i, 1],
    [/\bhistory of present illness\b/i, 1],
  ],
  referral: [
    [/\breferral\s+(?:form|request|order)\b/i, 3],
    [/\breason\s+for\s+referral\b/i, 3],
    [/\breferred\s+(?:by|to)\b/i, 2],
    [/\b(?:prior\s+)?authorization\b/i, 1],
  ],
};

export function classifyKind(text: string): Extracted<DocumentKind> {
  const scores = (Object.keys(KIND_TERMS) as Exclude<DocumentKind, 'other'>[])
    .map((kind) => ({ kind, score: KIND_TERMS[kind].reduce((n, [re, w]) => n + (re.test(text) ? w : 0), 0) }))
    .sort((a, b) => b.score - a.score);
  const [top, next] = scores;
  if (top.score < 2 || top.score === next.score) return { value: 'other', confidence: 'low' };
  return { value: top.kind, confidence: top.score >= 4 && top.score - next.score >= 2 ? 'high' : 'medium' };
}

/**
 * Finer document type, used only to pick a more specific chart category (doctypes.ts). Title-like
 * phrases near the top of the document count most; the first strong match wins.
 */
const SUBTYPE_TERMS: [DocumentSubtype, RegExp][] = [
  ['discharge_summary', /\bdischarge\s+summary\b/i],
  ['history_physical', /\bhistory\s+(?:and|&)\s+physical\b|\bH\s*&\s*P\b/],
  ['op_note', /\b(?:operative|procedure|op)\s+(?:note|report)\b/i],
  ['pathology', /\b(?:surgical\s+)?pathology\s+report\b|\bkidney\s+biopsy\b|\brenal\s+biopsy\b/i],
  ['colonoscopy', /\bcolonoscopy\b/i],
  ['stress_test', /\b(?:cardiac\s+)?stress\s+test\b|\bnuclear\s+stress\b/i],
  ['ekg', /\b(?:EKG|ECG|electrocardiogram)\b/],
  ['mammogram', /\bmammogra\w*\b/i],
  ['ct', /\bCT\s+(?:scan|abdomen|chest|head|pelvis|renal|urogram|of)\b|\bcomputed\s+tomography\b/i],
  ['mri', /\bMRI\b|\bmagnetic\s+resonance\b/],
  ['nuclear', /\bnuclear\s+medicine\b|\brenal\s+scan\b|\bMAG-?3\b|\bPET\b/i],
  ['chest_xray', /\bchest\s+(?:x-?ray|radiograph)\b|\bCXR\b/i],
  ['xray', /\bx-?ray\b|\bradiograph\b/i],
  ['ultrasound', /\bultrasound\b|\bsonogra\w*\b|\bduplex\b|\bdoppler\b/i],
  ['referral_letter', /\breferral\s+(?:letter|form|request)\b|\breason\s+for\s+referral\b/i],
  ['progress_note', /\bprogress\s+note\b|\boffice\s+visit\s+note\b/i],
  ['insurance_card', /\binsurance\s+card\b|\bmember\s+ID\b.*\bgroup\b/i],
];

/** Which subtypes make sense for a kind ('other' accepts the non-imaging, non-lab ones). */
const SUBTYPE_KINDS: Record<DocumentSubtype, DocumentKind[]> = {
  ct: ['imaging'], mri: ['imaging'], chest_xray: ['imaging'], xray: ['imaging'], mammogram: ['imaging'],
  ultrasound: ['imaging'], nuclear: ['imaging'],
  pathology: ['lab_result', 'other'], ekg: ['other', 'imaging'], stress_test: ['other', 'imaging'], colonoscopy: ['other'],
  discharge_summary: ['other', 'consult'], history_physical: ['other', 'consult'], op_note: ['other', 'consult'],
  progress_note: ['other', 'consult'], referral_letter: ['referral', 'other'], insurance_card: ['other'],
};

export function classifySubtype(text: string, kind: DocumentKind): Extracted<DocumentSubtype> | undefined {
  const head = text.slice(0, 1500);
  for (const [subtype, re] of SUBTYPE_TERMS) {
    if (!SUBTYPE_KINDS[subtype].includes(kind)) continue;
    if (re.test(head)) return { value: subtype, confidence: 'high' };
  }
  for (const [subtype, re] of SUBTYPE_TERMS) {
    if (!SUBTYPE_KINDS[subtype].includes(kind)) continue;
    if (re.test(text)) return { value: subtype, confidence: 'medium' };
  }
  return undefined;
}

// ── Abnormal flags ───────────────────────────────────────────────────────────

/** A value followed by a lab flag: "2.1  H  0.6-1.3", "2.1H", "142 (L)", "6.8 *HH". */
const FLAG_RE = /\d(?:\s+|\s*\*|(?=[HL]\b))\(?(HH|LL|H|L)\)?(?=\s|$)/;
const ABNORMAL_RE = /\babnormal\b/i;
const NOT_ABNORMAL_RE = /\b(?:no|not|non-?)\s*abnormal|abnormal\s*(?:flag|range|indicator)s?\b|\bnormal\/abnormal\b/i;
const CRITICAL_RE = /\b(?:critical|panic)\b/i;
const NOT_CRITICAL_RE =
  /\bcritical\s+access\b|\bno\s+critical\b|\bcritical\s+(?:range|values?\s+policy)\b|\bcritical\s+(?:values?|results?)\s+(?:are|is|will\s+be)\b/i;
/** Other flag styles: "7.9 %  *H", "6.8 (C)" (critical), "Moderate (A)" or a lone "A" flag column. */
const STAR_FLAG_RE = /(?:^|\s)\*(HH|LL|H|L)(?=\s|$)/;
const PAREN_FLAG_RE = /\S\s*\((C|A)\)(?=\s|$)/;
const A_COLUMN_RE = /\S\s{2,}(A)(?=\s{2,}|\s*$)/;

export function abnormalFlags(text: string): AbnormalFlags {
  const markers = new Set<string>();
  let flaggedLines = 0;
  let critical = false;
  for (const line of text.split(/\r?\n/)) {
    const f = line.match(FLAG_RE) || line.match(STAR_FLAG_RE) || line.match(PAREN_FLAG_RE) || line.match(A_COLUMN_RE);
    if (f) {
      flaggedLines++;
      markers.add(f[1]);
      if (f[1].length === 2 || f[1] === 'C') critical = true; // HH / LL / (C): critical values
    }
    if (ABNORMAL_RE.test(line) && !NOT_ABNORMAL_RE.test(line)) markers.add('ABNORMAL');
    if (CRITICAL_RE.test(line) && !NOT_CRITICAL_RE.test(line)) {
      markers.add('CRITICAL');
      critical = true;
    }
  }
  return { flagged: markers.size > 0, critical, flagged_lines: flaggedLines, markers: [...markers].sort() };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Every field we can read from one document's text. Missing fields are left out.
 * `ownName` is the receiving practice (INTAKE_PRACTICE_NAME): never taken as the sender.
 */
export function extractFields(
  text: string,
  now: Date = new Date(),
  ownName: string = process.env.INTAKE_PRACTICE_NAME || 'Idaho Kidney Institute'
): ExtractedFields {
  const clean = String(text || '').replace(/\r/g, '').replace(/\f/g, '\n').slice(0, 200_000);
  const lines = clean.split('\n');
  const out: ExtractedFields = { kind: classifyKind(clean), abnormal: abnormalFlags(clean) };
  const subtype = classifySubtype(clean, out.kind.value);
  if (subtype) out.subtype = subtype;
  const tpl = findTemplate(clean);
  const tr = tpl ? templateReads(lines, tpl, now) : null;
  if (tpl) out.template = tpl.id;
  // A template's reads come first; the generic reading of the lines it read is dropped.
  const names = [...(tr?.names || []), ...allNames(lines).filter((n) => !tr?.claimed.name.has(n.line))];
  const dobs = [...(tr?.dobs || []), ...allDobs(lines, now).filter((d) => !tr?.claimed.dob.has(d.line))];
  const mrns = [...(tr?.mrns || []), ...allMrns(lines).filter((m) => !tr?.claimed.mrn.has(m.line))];
  out.patient_count = countPatients(
    names.map((n) => n.name),
    dobs.map((d) => d.value),
    mrns.map((m) => m.value)
  );
  // Consensus across the document: the patient's name, DOB and MRN are often printed on every page (or
  // on the cover sheet and the report). Among the reads that are the same patient up to OCR noise (the
  // clusters countPatients uses), the value read most often wins; ties keep the first (best label, then
  // document order), which is what a single read gives. Matching still needs exact values.
  const nameKey = (n: PatientName) => `${n.last}|${n.first}`.toLowerCase().replace(/[^a-z|]/g, '');
  const nameVote = vote(names, (n) => nameKey(n.name), (a, b) => within(a.replace('|', ''), b.replace('|', ''), 2));
  if (nameVote) {
    const best = names.filter((n) => nameKey(n.name) === nameVote.key);
    const conf = best.some((n) => n.confidence === 'high') ? 'high' : best[0].confidence;
    out.patient_name = { value: best[0].name, confidence: conf };
  }
  const dobVote = vote(dobs, (d) => d.value, (a, b) => [...a].filter((ch, i) => ch !== b[i]).length <= 1);
  if (dobVote) out.dob = { value: dobVote.key, confidence: 'high' };
  if (nameVote || dobVote) out.reads_agree = (!nameVote || nameVote.unanimous) && (!dobVote || dobVote.unanimous);
  const mrnKey = (m: Extracted) => m.value.replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '');
  const mrnVote = vote(mrns, mrnKey, (a, b) => within(a, b, 1));
  const mrn = mrnVote ? mrns.find((m) => mrnKey(m) === mrnVote.key) : undefined;
  if (mrn) out.mrn = { value: mrn.value, confidence: mrn.confidence };
  else if (MRN_LABEL_LOOSE.test(clean) || tr?.mrnBad) out.mrn_unreadable = true;
  const block = [...names.map((n) => n.line), ...dobs.map((d) => d.line)];
  const phone = tr?.phone || extractPhone(lines, block);
  if (phone) out.phone = phone;
  // Third identifiers (match.ts): the SSN's last 4 (a full SSN is never kept) and the patient's address.
  const ssn = extractSsn(lines);
  if (ssn.last4) out.ssn_last4 = ssn.last4;
  else if (ssn.unreadable) out.ssn_unreadable = true;
  const addr = extractAddress(lines, block);
  if (addr.address) out.address = addr.address;
  else if (addr.unreadable) out.address_unreadable = true;
  const unread = unreadIdentifier(lines, block, mrns.map((m) => mrnKey(m)), phone && usableConf(phone.confidence) ? phone.value : '', addr.lines);
  if (unread.kind || unread.ssn) out.unread_identifier = true;
  // An MRN-like number next to the patient that was not read as an MRN: like an unreadable MRN label,
  // the phone must not stand in for it.
  if (unread.kind === 'mrn' && !out.mrn) out.mrn_unreadable = true;
  // An SSN-like number next to the patient that was not read as the SSN: it can't be checked.
  if (unread.ssn) {
    delete out.ssn_last4;
    out.ssn_unreadable = true;
  }
  const sender = extractSender(lines, clean, ownName);
  if (sender) out.sender = sender;
  const collected = extractCollectionDate(lines, now);
  if (collected) out.collection_date = collected;
  return out;
}
