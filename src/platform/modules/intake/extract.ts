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
  /** Distinct patients named on the document (0 when none could be read). */
  patient_count?: number;
  /**
   * Something like an MRN label is printed but no MRN could be read. The MRN might disagree, so
   * match.ts does not fall back to the phone as the second identifier.
   */
  mrn_unreadable?: boolean;
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
  String.raw`\s{2,}|\t|\s+(?=(?:${DOB_LABEL}|MRN|Med(?:ical)? Rec(?:ord)?|Sex|Gender|Age|Phone|Tel|PT PHONE|Acct|Account|ACC#|Accession|Patient [I1l]D|Chart|Coll\w*|Ordered|Ordering|Received|Reported|Resulted|Specimen|Fax|Provider|Physician|Referring|Location|Room|SSN|Client|Exam)\b)`,
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
    last = lastParts.join(' ');
    first = rest[0];
    middle = rest.slice(1);
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
/** Anything that looks like an MRN label, even badly read ("Med Ree #", "M RN"). See mrn_unreadable. */
const MRN_LABEL_LOOSE = /\b(?:M\s?R\s?N|Med\w{0,5}\.?\s*Re[a-z]{1,4}\b|Chart\s*(?:#|No|Num)|Patient\s*[I1l]D)/i;
/** Every labelled MRN on the document, high-confidence labels first. */
function allMrns(lines: string[]): Extracted[] {
  const tries: [RegExp, Confidence][] = [
    [/\b(?:MRN|Med(?:ical)?\.?\s*Re[ce](?:ord)?\.?\s*(?:Number|No\.?|#)?|Chart\s*(?:Number|No\.?|#))/i, 'high'],
    [/\bPatient\s*[I1l]D\b/i, 'medium'],
  ];
  const out: Extracted[] = [];
  for (const [label, confidence] of tries) {
    for (const v of labeledAll(lines, label)) {
      // OCR splits digits with a single space ("005696 14"); values are already cut at double spaces.
      const m = v.value.replace(/(?<=\d) (?=\d)/g, '').match(MRN_VALUE);
      if (!m || !/\d/.test(m[1])) continue;
      // Mostly digits: undo O/0 and l/1 swaps ("4O2449O" → "4024490"). Letter MRNs stay as read.
      const raw = m[1].toUpperCase();
      const val = (raw.match(/\d/g) || []).length >= raw.length - 2 ? raw.replace(/[OD]/g, '0').replace(/[IL|]/g, '1') : raw;
      out.push({ value: val, confidence });
    }
  }
  return out;
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
  const names = allNames(lines);
  if (names.length) out.patient_name = { value: names[0].name, confidence: names[0].confidence };
  const dobs = allDobs(lines, now);
  if (dobs.length) out.dob = { value: dobs[0].value, confidence: 'high' };
  const mrns = allMrns(lines);
  out.patient_count = countPatients(
    names.map((n) => n.name),
    dobs.map((d) => d.value),
    mrns.map((m) => m.value)
  );
  const mrn = mrns[0];
  if (mrn) out.mrn = mrn;
  else if (MRN_LABEL_LOOSE.test(clean)) out.mrn_unreadable = true;
  const phone = extractPhone(lines, [...names.map((n) => n.line), ...dobs.map((d) => d.line)]);
  if (phone) out.phone = phone;
  const sender = extractSender(lines, clean, ownName);
  if (sender) out.sender = sender;
  const collected = extractCollectionDate(lines, now);
  if (collected) out.collection_date = collected;
  return out;
}
