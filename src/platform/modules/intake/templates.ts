import * as fs from 'fs';
import * as path from 'path';

/**
 * Sender templates: small declarative files that describe one frequent sender's layout, so its
 * documents are read with what we know about them instead of generic guesses.
 *
 * One JSON file per sender in INTAKE_SENDER_TEMPLATES_DIR (the same files the OCR container reads from
 * deploy/ocr/templates, see deploy/ocr/README.md). Nothing is active unless the directory is set and a
 * document matches a template. Example: deploy/ocr/templates/sawtooth-rapid-lab.json (the synthetic
 * stand-in for Express Lab's daily batch).
 *
 *   {
 *     "id": "sawtooth-rapid-lab",
 *     "synthetic": true,                                 // made for the bench, not a real sender
 *     "match": { "text": ["SAWTOOTH RAPID LAB"], "fax": ["2085550163"] },
 *     "fields": {
 *       "name":  { "labels": ["PT:"], "order": "last_first" },
 *       "dob":   { "labels": ["DOB:"], "formats": ["YYYY-MM-DD", "MM/DD/YYYY"] },
 *       "mrn":   { "labels": ["MRN:", "PATIENT ID:"], "pattern": "^\\d{5,8}$" },
 *       "phone": { "labels": ["PT PHONE:"] }
 *     },
 *     "ocr": {                                           // used by the OCR container only
 *       "header_labels": ["PT:", "DOB:", "MRN:", "PATIENT ID:"],   // lines always read again
 *       "header_region": [0.0, 0.3],                     // optional: a band of the page (fractions)
 *       "whitelist": "ABC...XYZ0123456789:,.'-/#()"      // optional: characters on those lines
 *     }
 *   }
 *
 * What a template changes in extract.ts, for a document that matches it (its name in the text, OCR
 * noise allowed, or its fax number):
 *   - its labels are read at the start of a line even as OCR misreads them ("PTt", "P7:", "D0B;"),
 *     with 'high' confidence; the generic reading of those lines is replaced by the template's
 *   - name order: "last_first" reads "SCHMITT ALMA" (comma lost) as Schmitt, Alma
 *   - dob.formats: only those date formats are accepted on its DOB lines
 *   - mrn.pattern: an MRN value that doesn't fit is not an MRN: the document is marked mrn_unreadable
 *     (so the phone can't stand in for it), never matched on a misread number
 * A template never relaxes a matching rule: it only changes how fields are read.
 */
export interface FieldSpec {
  labels: string[];
}
export interface SenderTemplate {
  id: string;
  synthetic?: boolean;
  note?: string;
  match: { text?: string[]; fax?: string[] };
  fields: {
    name?: FieldSpec & { order?: 'last_first' | 'first_last' };
    dob?: FieldSpec & { formats?: string[] };
    mrn?: FieldSpec & { pattern?: string };
    phone?: FieldSpec;
  };
  ocr?: Record<string, unknown>;
}

let cache: { dir: string; list: SenderTemplate[] } | null = null;

function valid(t: any): t is SenderTemplate {
  const labels = (f: any) => f === undefined || (Array.isArray(f?.labels) && f.labels.every((l: unknown) => typeof l === 'string' && l.trim()));
  return (
    !!t &&
    typeof t.id === 'string' &&
    /^[a-z0-9-]{2,60}$/.test(t.id) &&
    typeof t.match === 'object' &&
    (Array.isArray(t.match.text) || Array.isArray(t.match.fax)) &&
    typeof t.fields === 'object' &&
    ['name', 'dob', 'mrn', 'phone'].every((k) => labels(t.fields[k])) &&
    (t.fields.mrn?.pattern === undefined || typeof t.fields.mrn.pattern === 'string')
  );
}

/** Templates from INTAKE_SENDER_TEMPLATES_DIR (or `dir`). Invalid files are skipped with a log line (no content). */
export function loadTemplates(dir: string = process.env.INTAKE_SENDER_TEMPLATES_DIR || ''): SenderTemplate[] {
  if (!dir) return [];
  if (cache && cache.dir === dir) return cache.list;
  const list: SenderTemplate[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    console.error('[Intake] sender templates: directory not readable');
  }
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (valid(t)) list.push(t);
      else console.error(`[Intake] sender template ${f} skipped: not a valid template`);
    } catch {
      console.error(`[Intake] sender template ${f} skipped: not valid JSON`);
    }
  }
  cache = { dir, list };
  return list;
}

/** Forget loaded templates (tests). */
export function resetTemplates(): void {
  cache = null;
}

const lettersUp = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '');

/** True when `needle` occurs in `hay` with at most k substitutions/insertions/deletions (letters only). */
function fuzzyContains(hay: string, needle: string, k: number): boolean {
  if (!needle) return false;
  if (hay.includes(needle)) return true;
  // Sellers' algorithm: edit distance of needle against any substring of hay.
  let prev = Array.from({ length: needle.length + 1 }, (_, i) => i);
  for (let j = 1; j <= hay.length; j++) {
    const cur = [0];
    for (let i = 1; i <= needle.length; i++) {
      cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1));
    }
    if (cur[needle.length] <= k) return true;
    prev = cur;
  }
  return false;
}

/**
 * The template whose sender this document is from: its name in the text (letters only, up to two OCR
 * errors for names of 10+ letters), or its fax number equal to the sending fax. null when none or
 * more than one match.
 */
export function findTemplate(text: string, senderFax?: string, list: SenderTemplate[] = loadTemplates()): SenderTemplate | null {
  if (!list.length) return null;
  const hay = lettersUp(String(text || '').slice(0, 20_000));
  const fax = String(senderFax || '').replace(/\D/g, '').slice(-10);
  const hits = list.filter(
    (t) =>
      (t.match.fax || []).some((f) => fax && String(f).replace(/\D/g, '').slice(-10) === fax) ||
      (t.match.text || []).some((s) => {
        const n = lettersUp(s);
        return n.length >= 6 && fuzzyContains(hay, n, n.length >= 10 ? 2 : 0);
      })
  );
  return hits.length === 1 ? hits[0] : null;
}

/** What OCR reads in place of each printed character in a label (Tesseract on fax images). */
const CONFUSIONS: Record<string, string> = {
  A: 'A4', B: 'B8R', D: 'DO0', E: 'EF', G: 'G6', I: 'I1l|!L', L: 'L1I|', M: 'MN', N: 'NHM', O: 'O0QD', P: 'PR',
  R: 'RB', S: 'S5$', T: 'T7', Z: 'Z2', 0: '0OD', 1: '1Il|', 5: '5S', 8: '8B',
};
const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/**
 * A template label as a pattern that tolerates OCR misreads: each letter may come back as a lookalike
 * and a space may vanish; a final ":" "#" or "." must be there but may read as ; ! , . | or ' (or as
 * t i j followed by a space). The label starts the line or follows a space, so "PT:" never matches
 * "PTH-I" or "PT PHONE:". A label without a final colon must be followed by a space.
 */
export function labelPattern(label: string): RegExp {
  let body = '';
  const chars = [...label.trim()];
  chars.forEach((c, i) => {
    const last = i === chars.length - 1;
    if (/[A-Za-z0-9]/.test(c)) {
      const set = CONFUSIONS[c.toUpperCase()] || c.toUpperCase();
      body += `[${esc(set + set.toLowerCase())}]`;
    } else if (c === ' ') body += '\\s?';
    else if (last && /[:#.]/.test(c)) body += `(?:[:;!,.#|']|[tij](?=\\s))`;
    else body += `${esc(c)}?`;
  });
  // After a colon (or its lookalike) the value may follow without a space ("DOB:09/21/1952").
  const tail = /[:#.]$/.test(label.trim()) ? '' : '(?=\\s)';
  return new RegExp(`(?:^\\W{0,3}|(?<=\\s))${body}${tail}`);
}

/** Lines that carry one of `labels` (as OCR reads them): the text after the label, and the line. */
export function templateValues(lines: string[], labels: string[]): { value: string; line: number }[] {
  const pats = labels.map(labelPattern);
  const out: { value: string; line: number }[] = [];
  lines.forEach((line, i) => {
    for (const re of pats) {
      const m = line.match(re);
      if (!m) continue;
      out.push({ value: line.slice(m.index! + m[0].length), line: i });
      return;
    }
  });
  return out;
}

/** Date formats a template may name, as patterns over the value (after OCR digit fixes). */
const FORMATS: Record<string, RegExp> = {
  'YYYY-MM-DD': /^\d{4}-\d{1,2}-\d{1,2}\b/,
  'MM/DD/YYYY': /^\d{1,2}\/\d{1,2}\/\d{4}\b/,
  'MM-DD-YYYY': /^\d{1,2}-\d{1,2}-\d{4}\b/,
  'MM/DD/YY': /^\d{1,2}\/\d{1,2}\/\d{2}\b/,
  'Mon D, YYYY': /^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\b/,
  'D Mon YYYY': /^\d{1,2}[\s-]+[A-Za-z]{3,9}\.?[\s-]+\d{4}\b/,
};

/** True when `value` starts in one of the template's date formats (any format when none are given). */
export function fitsDateFormat(value: string, formats?: string[]): boolean {
  if (!formats || !formats.length) return true;
  return formats.some((f) => FORMATS[f]?.test(value.trim()));
}
