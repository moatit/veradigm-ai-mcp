import type { PlatformDeps } from '../../registry';
import { isToolFailure, toToolFailure } from '../../../unity/utils/tool-result';
import type { Confidence, ExtractedFields } from './extract';

/**
 * Match a received document to one patient.
 *
 * Safety rule (FAX_INTAKE_ADDON.md): never file on one identifier, never guess between two patients.
 *   auto       exactly one patient matches name + DOB AND a second identifier agrees:
 *              the MRN, or (exact full name + DOB + the patient's phone, when the document has one)
 *   review     exactly one name + DOB match, but no second identifier (or a weak/conflicting one,
 *              or an MRN label whose value OCR could not read: the phone never stands in for it)
 *   none       nobody matches, or the document lacks a readable name or DOB
 *   ambiguous  more than one patient matches name + DOB, or the document itself names more than
 *              one patient (a daily batch, two patients' results in one fax): staff split it
 *   error      the patient search failed; never treated as "no match" (CLAUDE.md rule 5)
 *
 * MRN: Veradigm keeps two per patient, the PM MRN and the EHR chart MRN (= PM "PatientNumber").
 * Outside documents carry either, so the document's MRN agrees when it equals any of the patient's
 * MRNs, and conflicts only when it equals none of them.
 *
 * decideMatch() is the pure decision table (smoke-tested); matchPatient() runs the search.
 *
 * Optional clinic rule INTAKE_MATCH_RULE=name_dob (default: two_identifiers, the rule above). It adds
 * one way to reach 'auto' when the document carries no MRN or patient phone at all; everything that
 * is review, none or ambiguous under the default stays so. With name_dob, auto also needs ALL of:
 *   - the exact normalized full name (first + last, letters only) and DOB, both from an explicit label
 *     ('high' confidence), and every labelled read of them on the document identical (reads_agree)
 *   - exactly one patient with that exact name + DOB
 *   - no other patient with a similar name and the same DOB or a DOB one character off (or with day
 *     and month swapped): similar = one edit apart, sound-alike (Soundex) first and last name, first
 *     names where one starts the other, swapped first/last, or the same last name (twins). A misread
 *     letter or digit can't turn one such patient into the other. matchPatient() widens the search
 *     for this check: same DOB with the last name's first two letters, and the last name at any DOB
 *   - no MRN or patient phone on the document that disagrees, no MRN label left unread, and no
 *     unexplained MRN- or phone-like number near the patient line (extract.ts unread_identifier)
 *   - the pipeline's OCR-confidence gate (INTAKE_OCR_MIN_CONFIDENCE), as for every auto match
 * The result says which rule decided it (rule: 'name_dob').
 */
export type MatchDecision = 'auto' | 'review' | 'none' | 'ambiguous' | 'error';
/** two_identifiers (default): name + DOB + MRN or phone. name_dob: also exact name + DOB alone, see above. */
export type MatchRule = 'two_identifiers' | 'name_dob';

/** INTAKE_MATCH_RULE: 'name_dob' turns on the optional clinic rule; anything else is the default. */
export function matchRule(): MatchRule {
  return String(process.env.INTAKE_MATCH_RULE || '').trim().toLowerCase() === 'name_dob' ? 'name_dob' : 'two_identifiers';
}

export interface DecideOptions {
  /** Default two_identifiers. */
  rule?: MatchRule;
}

export interface Candidate {
  patientId: string;
  chartPatientId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  /** Display MRN (the first one Veradigm returned). */
  mrn: string;
  /** Every MRN the patient has (PM MRN, EHR chart MRN / PatientNumber). Defaults to [mrn]. */
  mrns?: string[];
  phones: string[];
}

export interface MatchedPatient {
  /** Veradigm® PM patient ID ('' when the person exists only in the EHR). */
  patientId: string;
  /** Veradigm® EHR patient ID: what a document is filed against. */
  chartPatientId: string;
  name: string;
  dateOfBirth: string;
  mrn: string;
}

export interface MatchResult {
  decision: MatchDecision;
  /** Short, staff-readable explanation. */
  reason: string;
  /** People that matched name + DOB. */
  candidates: number;
  patient?: MatchedPatient;
  second_identifier?: 'mrn' | 'phone';
  /** Set when the optional name_dob rule made the decision 'auto' (no second identifier). */
  rule?: 'name_dob';
  error_code?: string;
  checked_at: string;
}

const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
const normMrn = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '');
const digits10 = (s: unknown) => String(s ?? '').replace(/\D/g, '').slice(-10);
/** MM/DD/YYYY with zero padding; accepts M/D/YYYY and YYYY-MM-DD. */
export function normDob(s: unknown): string {
  const v = String(s ?? '').trim();
  let m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}/${m[1]}` : '';
}
const usable = (c?: Confidence) => c === 'high' || c === 'medium';

/** First names agree when equal, or one is the other's prefix of 3+ letters ("Jon" / "Jonathan"). */
function firstNameAgrees(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.length >= 3 && l.startsWith(s);
}

function toMatched(c: Candidate): MatchedPatient {
  return {
    patientId: c.patientId,
    chartPatientId: c.chartPatientId,
    name: `${c.firstName} ${c.lastName}`.trim(),
    dateOfBirth: normDob(c.dateOfBirth) || c.dateOfBirth,
    mrn: c.mrn,
  };
}

function multiplePatients(n: number): Omit<MatchResult, 'checked_at'> {
  return {
    decision: 'ambiguous',
    reason: `The document shows ${n} different patients (names, dates of birth or MRNs). Split it and file each part by hand.`,
    candidates: 0,
  };
}

// ── Optional rule: exact name + DOB ──────────────────────────────────────────

/** American Soundex ("Beasley" = "Beesly" = B240). '' for no letters. */
export function soundex(s: string): string {
  const w = norm(s);
  if (!w) return '';
  const code: Record<string, string> = { b: '1', f: '1', p: '1', v: '1', c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2', d: '3', t: '3', l: '4', m: '5', n: '5', r: '6' };
  let out = w[0].toUpperCase();
  let prev = code[w[0]] || '';
  for (const ch of w.slice(1)) {
    const c = code[ch] || '';
    if (c && c !== prev) out += c;
    if (ch !== 'h' && ch !== 'w') prev = c;
  }
  return (out + '000').slice(0, 4);
}

/** Edit distance at most 1. */
function oneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

/**
 * Two people whose names could be confused (normalized letters): the same last name (twins), one edit
 * apart over the full name, swapped first and last names, or a similar last name (one edit, Soundex)
 * with a similar first name (one edit, Soundex, or one first name starting the other).
 */
export function similarNames(aFirst: string, aLast: string, bFirst: string, bLast: string): boolean {
  const [af, al, bf, bl] = [aFirst, aLast, bFirst, bLast].map(norm);
  if (!al || !bl) return false;
  if (al === bl) return true;
  if (oneEdit(af + al, bf + bl) || (af === bl && al === bf)) return true;
  const lastSim = oneEdit(al, bl) || soundex(al) === soundex(bl);
  const firstSim = af === bf || oneEdit(af, bf) || soundex(af) === soundex(bf) || firstNameAgrees(af, bf);
  return lastSim && firstSim;
}

/** Two MM/DD/YYYY dates one character apart, or with day and month swapped (a likely misread). */
export function nearDob(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  if (a.length === b.length && [...a].filter((ch, i) => ch !== b[i]).length === 1) return true;
  const [am, ad, ay] = a.split('/');
  const [bm, bd, by] = b.split('/');
  return ay === by && am === bd && ad === bm;
}

/**
 * The name_dob conditions for a document whose one name + DOB match is `c` and that reached the end
 * of the default rule (no MRN or phone confirmed it). ok, or the condition that failed.
 */
function nameDobCheck(extracted: ExtractedFields, c: Candidate, candidates: Candidate[]): { ok: true } | { ok: false; reason: string } {
  const name = extracted.patient_name!;
  const dob = extracted.dob!;
  const first = norm(name.value.first);
  const last = norm(name.value.last);
  const birth = normDob(dob.value);
  if (name.confidence !== 'high' || dob.confidence !== 'high') return { ok: false, reason: 'the name or date of birth is not next to a clear label' };
  if (extracted.reads_agree === false) return { ok: false, reason: 'the name or date of birth reads differently in different places' };
  if (norm(c.firstName) !== first || norm(c.lastName) !== last) return { ok: false, reason: 'the name is not exactly the chart name' };
  const exact = candidates.filter((p) => norm(p.firstName) === first && norm(p.lastName) === last && normDob(p.dateOfBirth) === birth);
  if (exact.length !== 1) return { ok: false, reason: 'more than one patient has this exact name and date of birth' };
  const same = (p: Candidate) => (!!p.chartPatientId && p.chartPatientId === c.chartPatientId) || (!!p.patientId && p.patientId === c.patientId);
  const close = candidates.find((p) => {
    if (same(p) || !similarNames(first, last, p.firstName, p.lastName)) return false;
    const d = normDob(p.dateOfBirth);
    return d === birth || nearDob(d, birth);
  });
  if (close) {
    return {
      ok: false,
      reason: normDob(close.dateOfBirth) === birth
        ? 'another patient with the same date of birth has a similar name'
        : 'another patient with a similar name has a date of birth one digit away',
    };
  }
  if (extracted.mrn || extracted.mrn_unreadable) return { ok: false, reason: 'an MRN on the document could not be checked' };
  if (extracted.phone && usable(extracted.phone.confidence)) return { ok: false, reason: 'the phone on the document could not be checked' };
  if (extracted.unread_identifier) return { ok: false, reason: 'a number near the patient line may be an MRN or phone that could not be read' };
  return { ok: true };
}

/** The decision table. Pure: same inputs, same answer. */
export function decideMatch(extracted: ExtractedFields, candidates: Candidate[], opts: DecideOptions = {}): Omit<MatchResult, 'checked_at'> {
  const name = extracted.patient_name;
  const dob = extracted.dob;
  if ((extracted.patient_count ?? 1) > 1) return multiplePatients(extracted.patient_count!);
  if (!name || !dob || !usable(name.confidence) || !usable(dob.confidence)) {
    return { decision: 'none', reason: 'The document has no readable patient name and date of birth.', candidates: 0 };
  }
  const first = norm(name.value.first);
  const last = norm(name.value.last);
  const birth = normDob(dob.value);

  const hits = candidates.filter(
    (c) => norm(c.lastName) === last && normDob(c.dateOfBirth) === birth && firstNameAgrees(norm(c.firstName), first)
  );
  if (hits.length === 0) return { decision: 'none', reason: 'No patient matches this name and date of birth.', candidates: 0 };
  if (hits.length > 1) {
    return { decision: 'ambiguous', reason: `${hits.length} patients match this name and date of birth.`, candidates: hits.length };
  }

  const c = hits[0];
  const patient = toMatched(c);
  const review = (reason: string): Omit<MatchResult, 'checked_at'> => ({ decision: 'review', reason, candidates: 1, patient });

  if (!c.chartPatientId) return review('One patient matches, but there is no Veradigm® EHR chart for them.');

  // Second identifier 1: MRN. A different MRN on the document is a conflict, never a match.
  const docMrn = extracted.mrn && usable(extracted.mrn.confidence) ? normMrn(extracted.mrn.value) : '';
  const known = (c.mrns && c.mrns.length ? c.mrns : [c.mrn]).map(normMrn).filter(Boolean);
  if (docMrn && known.length) {
    if (known.includes(docMrn)) {
      return { decision: 'auto', reason: 'Name, date of birth and MRN match one patient.', candidates: 1, patient, second_identifier: 'mrn' };
    }
    return review('Name and date of birth match one patient, but the MRN on the document is different.');
  }

  // An MRN is printed but unreadable: it may disagree, so the phone cannot stand in for it.
  if (!docMrn && extracted.mrn_unreadable) {
    return review('Name and date of birth match one patient, but the MRN on the document could not be read.');
  }

  // Second identifier 2: exact full name + DOB + phone (only when the document has a patient phone).
  const docPhone = extracted.phone && usable(extracted.phone.confidence) ? digits10(extracted.phone.value) : '';
  if (docPhone.length === 10) {
    const exactName = norm(c.firstName) === first && norm(c.lastName) === last;
    const phoneHit = c.phones.some((p) => digits10(p) === docPhone);
    if (exactName && phoneHit) {
      return { decision: 'auto', reason: 'Full name, date of birth and phone match one patient.', candidates: 1, patient, second_identifier: 'phone' };
    }
    if (!phoneHit) return review('Name and date of birth match one patient, but the phone on the document is different.');
  }

  if (opts.rule === 'name_dob') {
    const nd = nameDobCheck(extracted, c, candidates);
    if (nd.ok) {
      return {
        decision: 'auto',
        reason: 'Exact full name and date of birth match one patient, and no other patient has a similar name and the same date of birth (clinic rule: name + date of birth).',
        candidates: 1,
        patient,
        rule: 'name_dob',
      };
    }
    return review(`Name and date of birth match one patient; no second identifier to confirm (name + date of birth rule not met: ${nd.reason}).`);
  }
  return review('Name and date of birth match one patient; no second identifier to confirm.');
}

/** Rows from unity_search_patients → candidates. */
export function toCandidates(result: any): Candidate[] {
  const rows: any[] = Array.isArray(result?.patients) ? result.patients : [];
  return rows.map((p) => {
    // PM MRN and EHR chart MRN (PM PatientNumber): whichever fields the search returns.
    const mrns = [p?.mrn, p?.patientNumber, p?.chartMrn, p?.ehrMrn, p?.pmMrn]
      .filter((x) => (typeof x === 'string' || typeof x === 'number') && String(x).trim())
      .map(String);
    return {
      patientId: String(p?.patientId ?? p?.id ?? ''),
      chartPatientId: String(p?.chartPatientId ?? ''),
      firstName: String(p?.firstName ?? ''),
      lastName: String(p?.lastName ?? ''),
      dateOfBirth: String(p?.dateOfBirth ?? ''),
      mrn: mrns[0] || '',
      mrns: [...new Set(mrns)],
      phones: [p?.phone?.home, p?.phone?.cell, p?.phone?.work, typeof p?.phone === 'string' ? p.phone : '']
        .filter((x) => typeof x === 'string' && x.trim())
        .map(String),
    };
  });
}

/**
 * Search Veradigm (PM + EHR) by name + DOB through the agent tool path, then decide.
 * A failed or malformed search returns decision 'error' with the error code.
 */
export async function matchPatient(
  extracted: ExtractedFields,
  runTool: PlatformDeps['runTool'],
  now: () => Date = () => new Date()
): Promise<MatchResult> {
  const stamp = () => now().toISOString();
  const name = extracted.patient_name;
  const dob = extracted.dob;
  if (!name || !dob || !usable(name.confidence) || !usable(dob.confidence) || (extracted.patient_count ?? 1) > 1) {
    return { ...decideMatch(extracted, []), checked_at: stamp() };
  }
  const tool = 'unity_search_patients';
  let r: any;
  try {
    r = await runTool(tool, { lastName: name.value.last, firstName: name.value.first, dateOfBirth: dob.value });
  } catch (e) {
    r = toToolFailure(e, tool);
  }
  const fail = (code: string): MatchResult => ({
    decision: 'error',
    reason: 'The patient search in Veradigm® failed. Try again.',
    candidates: 0,
    error_code: code,
    checked_at: stamp(),
  });
  if (isToolFailure(r)) return fail(r.error_code);
  if (!r || typeof r !== 'object' || !Array.isArray(r.patients)) return fail('API_ERROR');
  if (r.redacted === true) return fail('RESTRICTED');
  const rule = matchRule();
  const candidates = toCandidates(r);
  const decided = decideMatch(extracted, candidates, { rule });
  if (decided.rule !== 'name_dob') return { ...decided, checked_at: stamp() };
  // name_dob only: look wider before filing on name + DOB: same-DOB patients whose last name starts with
  // the same two letters (twins, Beasley / Beesly), and patients with this last name at any DOB (the
  // same name with a DOB one digit off).
  let wider = candidates;
  const wideSearches: Record<string, string>[] = [{ lastName: name.value.last.trim().slice(0, 2), dateOfBirth: dob.value }, { lastName: name.value.last.trim() }];
  for (const args of wideSearches) {
    const wide = await neighbours(args, runTool);
    if (!wide.ok) return fail(wide.error_code);
    wider = mergeCandidates(wider, wide.candidates);
  }
  return { ...decideMatch(extracted, wider, { rule }), checked_at: stamp() };
}

/** One wider search for the name_dob rule. A failed search is an error, never "nobody similar". */
async function neighbours(
  args: Record<string, string>,
  runTool: PlatformDeps['runTool']
): Promise<{ ok: true; candidates: Candidate[] } | { ok: false; error_code: string }> {
  const tool = 'unity_search_patients';
  let r: any;
  try {
    r = await runTool(tool, args);
  } catch (e) {
    r = toToolFailure(e, tool);
  }
  if (isToolFailure(r)) return { ok: false, error_code: r.error_code };
  if (!r || typeof r !== 'object' || !Array.isArray(r.patients)) return { ok: false, error_code: 'API_ERROR' };
  if (r.redacted === true) return { ok: false, error_code: 'RESTRICTED' };
  return { ok: true, candidates: toCandidates(r) };
}

function mergeCandidates(a: Candidate[], b: Candidate[]): Candidate[] {
  const key = (c: Candidate) => c.chartPatientId || c.patientId || `${norm(c.firstName)}|${norm(c.lastName)}|${normDob(c.dateOfBirth)}`;
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((c) => !seen.has(key(c)))];
}
