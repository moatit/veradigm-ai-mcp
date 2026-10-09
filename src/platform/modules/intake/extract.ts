/**
 * Field extraction from a received document's text (MOATiT Fax OCR, or a text layer).
 *
 * Pure functions, heuristic regexes. OCR text is untrusted: every field carries a confidence and
 * the matcher (match.ts) decides what is good enough. Nothing here summarizes or rewrites the
 * clinical content; the original file is what gets filed.
 *
 * Confidence:
 *   high    the value sits next to an explicit label ("DOB:", "MRN:", "Patient Name:")
 *   medium  a weaker label ("Name:", "RE:", "Patient ID:") or a well-known name (lab company)
 *   low     a guess; never used for patient matching
 */
export type Confidence = 'high' | 'medium' | 'low';
export type DocumentKind = 'lab_result' | 'imaging' | 'consult' | 'referral' | 'other';

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
  abnormal: AbnormalFlags;
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

/** Labels that end a value when several fields share one line ("Name: X   DOB: Y"). */
const NEXT_LABEL =
  /\s{2,}|\t|\s+(?=(?:DOB|D\.O\.B\.?|Date of Birth|Birth ?Date|MRN|Med(?:ical)? Rec(?:ord)?|Sex|Gender|Age|Phone|Tel|Acct|Account|Patient ID|Chart|Collected|Ordered|Received|Reported|Fax|Provider|Physician|Location|Room|SSN)\b)/i;

/** Text after `label` on the same line, cut at the next label. '' when the label is absent. */
function labeled(lines: string[], label: RegExp): string {
  for (const line of lines) {
    const m = line.match(label);
    if (!m || m.index === undefined) continue;
    const rest = line.slice(m.index + m[0].length).replace(/^[\s:#.-]+/, '');
    const cut = rest.split(NEXT_LABEL)[0].trim();
    if (cut) return cut;
  }
  return '';
}

// ── Patient name ─────────────────────────────────────────────────────────────

const NAME_TOKEN = /^[A-Za-z][A-Za-z'’-]*\.?$/;
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_, p, c) => p + c.toUpperCase());

/** "LAST, FIRST M" or "First M. Last" → name parts; null when it doesn't look like a name. */
export function parseName(raw: string): PatientName | null {
  const s = raw.replace(/\s+/g, ' ').replace(/[;|]+.*$/, '').trim();
  if (!s || s.length > 60 || /\d/.test(s)) return null;
  let first = '';
  let last = '';
  let middle: string[] = [];
  const comma = s.match(/^([^,]+),\s*(.+)$/);
  if (comma) {
    const lastParts = comma[1].trim().split(' ');
    const rest = comma[2].trim().split(' ');
    if (!lastParts.every((t) => NAME_TOKEN.test(t)) || !rest.every((t) => NAME_TOKEN.test(t))) return null;
    last = lastParts.join(' ');
    first = rest[0];
    middle = rest.slice(1);
  } else {
    const parts = s.split(' ').filter((t) => !/^(mr|mrs|ms|miss|dr)\.?$/i.test(t));
    if (parts.length < 2 || parts.length > 4 || !parts.every((t) => NAME_TOKEN.test(t))) return null;
    first = parts[0];
    last = parts[parts.length - 1];
    middle = parts.slice(1, -1);
  }
  first = titleCase(first.replace(/\.$/, ''));
  last = titleCase(last.replace(/\.$/, ''));
  if (first.length < 2 || last.length < 2) return null;
  return { first, last, full: [first, ...middle.map(titleCase), last].join(' ') };
}

function extractName(lines: string[]): Extracted<PatientName> | undefined {
  const tries: [RegExp, Confidence][] = [
    [/\bPatient(?:'s)?\s*Name\b/i, 'high'],
    [/\bPatient\s*:/i, 'high'],
    [/\bPt\.?\s*Name\b/i, 'high'],
    [/\b(?:RE|Regarding)\s*:/i, 'medium'],
    [/^\s*Name\s*:/i, 'medium'],
  ];
  for (const [label, confidence] of tries) {
    const v = labeled(lines, label);
    const name = v ? parseName(v) : null;
    if (name) return { value: name, confidence };
  }
  return undefined;
}

// ── Other fields ─────────────────────────────────────────────────────────────

function extractDob(lines: string[], now: Date): Extracted | undefined {
  const v = labeled(lines, /\b(?:DOB|D\.O\.B\.?|Date\s+of\s+Birth|Birth\s*Date|Birthdate)\b/i);
  const d = v ? normalizeDate(v, { pastOnly: true, now }) : '';
  return d ? { value: d, confidence: 'high' } : undefined;
}

const MRN_VALUE = /^#?\s*([A-Z0-9][A-Z0-9-]{2,19})\b/i;
function extractMrn(lines: string[]): Extracted | undefined {
  const tries: [RegExp, Confidence][] = [
    [/\b(?:MRN|Med(?:ical)?\.?\s*Rec(?:ord)?\.?\s*(?:Number|No\.?|#)?|Chart\s*(?:Number|No\.?|#))/i, 'high'],
    [/\bPatient\s*ID\b/i, 'medium'],
  ];
  for (const [label, confidence] of tries) {
    const m = labeled(lines, label).match(MRN_VALUE);
    if (m && /\d/.test(m[1])) return { value: m[1].toUpperCase(), confidence };
  }
  return undefined;
}

/** Patient phone only: plain "Phone:" lines are often the sender's, so they are low confidence. */
function extractPhone(lines: string[]): Extracted | undefined {
  const tries: [RegExp, Confidence][] = [
    [/\b(?:Patient|Pt\.?|Home|Cell|Mobile)\s*(?:Phone|Tel(?:ephone)?|#)/i, 'high'],
    [/^\s*(?:Phone|Tel(?:ephone)?)\b(?!.*\bfax\b)/i, 'low'],
  ];
  for (const [label, confidence] of tries) {
    const v = labeled(lines, label);
    const digits = v.replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '');
    if (/^\d{10}$/.test(digits)) return { value: digits, confidence };
  }
  return undefined;
}

/** Lab companies that commonly fax results; a name match is medium confidence. */
const KNOWN_SENDERS = ['Quest Diagnostics', 'LabCorp', 'Labcorp', 'ARUP Laboratories', 'Mayo Clinic Laboratories', 'Sonic Healthcare', 'BioReference', 'St. Luke’s', "St. Luke's", 'Saint Alphonsus'];

function extractSender(lines: string[], text: string): Extracted | undefined {
  const tries: [RegExp, Confidence][] = [
    [/^\s*(?:From|Sender|Sent by)\s*:/i, 'high'],
    [/\b(?:Performing|Reporting)\s+(?:Lab(?:oratory)?|Facility|Site)\b/i, 'high'],
    [/^\s*(?:Laboratory|Lab|Facility|Practice|Clinic)\s*:/i, 'medium'],
  ];
  for (const [label, confidence] of tries) {
    const v = labeled(lines, label).replace(/\s*\(?\b(?:fax|ph|phone|tel)\b.*$/i, '').trim();
    if (v && v.length <= 80 && /[A-Za-z]{2}/.test(v)) return { value: v, confidence };
  }
  for (const s of KNOWN_SENDERS) if (text.toLowerCase().includes(s.toLowerCase())) return { value: s, confidence: 'medium' };
  return undefined;
}

function extractCollectionDate(lines: string[], now: Date): Extracted | undefined {
  const tries: [RegExp, Confidence][] = [
    [/\b(?:Date\s+)?Collected(?:\s+(?:Date|On))?\b|\bCollection\s+(?:Date|Time)\b|\bSpecimen\s+Collected\b/i, 'high'],
    [/\b(?:Exam|Study|Procedure|Service)\s+Date\b|\bDate\s+of\s+(?:Exam|Service|Study|Visit|Consultation)\b|\bDOS\b/i, 'medium'],
  ];
  for (const [label, confidence] of tries) {
    const v = labeled(lines, label);
    const d = v ? normalizeDate(v, { now }) : '';
    if (d) return { value: d, confidence };
  }
  return undefined;
}

// ── Document kind ────────────────────────────────────────────────────────────

const KIND_TERMS: Record<Exclude<DocumentKind, 'other'>, [RegExp, number][]> = {
  lab_result: [
    [/\blab(?:oratory)?\s+(?:report|results?)\b/i, 3],
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

// ── Abnormal flags ───────────────────────────────────────────────────────────

/** A value followed by a lab flag: "2.1  H  0.6-1.3", "2.1H", "142 (L)", "6.8 *HH". */
const FLAG_RE = /\d(?:\s+|\s*\*|(?=[HL]\b))\(?(HH|LL|H|L)\)?(?=\s|$)/;
const ABNORMAL_RE = /\babnormal\b/i;
const NOT_ABNORMAL_RE = /\b(?:no|not|non-?)\s*abnormal|abnormal\s*(?:flag|range|indicator)s?\b|\bnormal\/abnormal\b/i;
const CRITICAL_RE = /\b(?:critical|panic)\b/i;
const NOT_CRITICAL_RE = /\bcritical\s+access\b|\bno\s+critical\b|\bcritical\s+(?:range|values?\s+policy)\b/i;

export function abnormalFlags(text: string): AbnormalFlags {
  const markers = new Set<string>();
  let flaggedLines = 0;
  let critical = false;
  for (const line of text.split(/\r?\n/)) {
    const f = line.match(FLAG_RE);
    if (f) {
      flaggedLines++;
      markers.add(f[1]);
      if (f[1].length === 2) critical = true; // HH / LL are critical-high / critical-low
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

/** Every field we can read from one document's text. Missing fields are left out. */
export function extractFields(text: string, now: Date = new Date()): ExtractedFields {
  const clean = String(text || '').replace(/\r/g, '').slice(0, 200_000);
  const lines = clean.split('\n');
  const out: ExtractedFields = { kind: classifyKind(clean), abnormal: abnormalFlags(clean) };
  const name = extractName(lines);
  if (name) out.patient_name = name;
  const dob = extractDob(lines, now);
  if (dob) out.dob = dob;
  const mrn = extractMrn(lines);
  if (mrn) out.mrn = mrn;
  const phone = extractPhone(lines);
  if (phone) out.phone = phone;
  const sender = extractSender(lines, clean);
  if (sender) out.sender = sender;
  const collected = extractCollectionDate(lines, now);
  if (collected) out.collection_date = collected;
  return out;
}
