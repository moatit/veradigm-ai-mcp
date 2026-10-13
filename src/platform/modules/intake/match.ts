import type { PlatformDeps } from '../../registry';
import { isToolFailure, toToolFailure } from '../../../unity/utils/tool-result';
import type { Confidence, ExtractedFields } from './extract';
import { patientSearch, rosterPath } from './roster';

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
 * INTAKE_MATCH_RULE=name_dob is the MOATiT standard (decided Oct 11, 2026: the two identifiers are name +
 * date of birth); deployments set it. Unset, the stricter two_identifiers rule above applies. name_dob adds
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
 *
 * Third identifier (MOATiT standard, Oct 11, 2026): the last 4 of the SSN or the patient's address,
 * checked whenever the document carries one and the patient's record has one to compare with.
 *   disagrees  the document goes to staff, like a conflicting MRN or phone (also when the MRN agrees)
 *   agrees     recorded on the result (third_identifier) and in the reason. Under either rule, with the
 *              exact full name + DOB it may also be the second identifier (second_identifier 'ssn4' or
 *              'address'), the way the phone is, behind the same look-alike guard
 *   unchecked  the record has none (Veradigm® masks SSNs in search results): it doesn't block an MRN,
 *              phone or other agreeing identifier, but name + DOB alone (name_dob) never file over it,
 *              since it may be someone else's (a namesake), like an unconfirmed phone
 * Address agrees when the street number and the 5-digit ZIP are equal, or the street number and the
 * street name (St/Street, Ave/Avenue, N/North, units like Apt/# ignored, case ignored). SSN-4 agrees when
 * the 4 digits are equal. A printed SSN or address that can't be read (ssn_unreadable,
 * address_unreadable) stops name_dob and an SSN-4/address second identifier, never an MRN match.
 */
export type MatchDecision = 'auto' | 'review' | 'none' | 'ambiguous' | 'error';
/** two_identifiers (when unset): name + DOB + MRN, phone, SSN-4 or address. name_dob (MOATiT standard): also exact name + DOB alone, see above. */
export type MatchRule = 'two_identifiers' | 'name_dob';

/** INTAKE_MATCH_RULE: 'name_dob' (the MOATiT standard, set by deployments); unset or anything else is two_identifiers. */
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
  /** Last 4 digits of the SSN on file ('' or absent when the search returns none). Never a full SSN. */
  ssnLast4?: string;
  /** Addresses on file (Veradigm® returns one; a patient list may hold more). */
  addresses?: CandidateAddress[];
}

export interface CandidateAddress {
  line1: string;
  city?: string;
  state?: string;
  zip?: string;
}

/** The SSN's last 4 or the address: the third identifier (see the header). */
export type ThirdIdentifier = 'ssn4' | 'address';

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
  second_identifier?: 'mrn' | 'phone' | ThirdIdentifier;
  /** An SSN-4 or address on the document that agrees with the patient's record (beyond the second identifier). */
  third_identifier?: ThirdIdentifier;
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

// ── Third identifier: SSN last 4 and address ─────────────────────────────────

const STREET_SUFFIXES: Record<string, string> = {
  st: 'st', street: 'st', str: 'st', ave: 'ave', avenue: 'ave', av: 'ave', rd: 'rd', road: 'rd', dr: 'dr', drive: 'dr',
  blvd: 'blvd', boulevard: 'blvd', ln: 'ln', lane: 'ln', ct: 'ct', court: 'ct', pl: 'pl', place: 'pl', cir: 'cir',
  circle: 'cir', ter: 'ter', terrace: 'ter', pkwy: 'pkwy', parkway: 'pkwy', hwy: 'hwy', highway: 'hwy', way: 'way',
  trl: 'trl', trail: 'trl', loop: 'loop', sq: 'sq', square: 'sq', xing: 'xing', crossing: 'xing', row: 'row', run: 'run',
  pass: 'pass', pike: 'pike', path: 'path',
};
const DIRECTIONS: Record<string, string> = {
  n: 'n', north: 'n', s: 's', south: 's', e: 'e', east: 'e', w: 'w', west: 'w',
  ne: 'ne', northeast: 'ne', nw: 'nw', northwest: 'nw', se: 'se', southeast: 'se', sw: 'sw', southwest: 'sw',
};
const ORDINALS: Record<string, string> = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th',
};

/** A street line in comparable parts: number, street name words, suffix, directional. Units dropped. */
export function streetParts(line: unknown): { number: string; core: string; suffix: string; dir: string } | null {
  let s = String(line ?? '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const box = s.match(/^p ?o ?box (\d+)/);
  if (box) return { number: box[1].replace(/^0+(?=.)/, ''), core: 'pobox', suffix: '', dir: '' };
  s = s.replace(/\s(?:apt|apartment|unit|ste|suite|bldg|building|lot|spc|space|rm|room|fl|floor)\b.*$/, '').replace(/\s*#.*$/, '');
  const toks = s.split(' ').filter(Boolean);
  const num = (toks[0] || '').match(/^(\d{1,6})([a-z]?)$/);
  if (!num) return null;
  const rest = toks.slice(1).map((t) => ORDINALS[t] || t);
  let dir = '';
  let suffix = '';
  const core: string[] = [];
  rest.forEach((t, i) => {
    const last = i === rest.length - 1;
    const beforeTrailingDir = i === rest.length - 2 && !!DIRECTIONS[rest[rest.length - 1]];
    if (DIRECTIONS[t] && rest.length > 1 && (i === 0 || last)) dir = dir || DIRECTIONS[t];
    else if (STREET_SUFFIXES[t] && core.length && (last || beforeTrailingDir)) suffix = STREET_SUFFIXES[t];
    else core.push(t);
  });
  if (!core.length) return null;
  return { number: `${num[1].replace(/^0+(?=.)/, '')}${num[2]}`, core: core.join(' '), suffix, dir };
}

const zip5 = (z: unknown) => (String(z ?? '').match(/\d{5}/) || [''])[0];

/**
 * Document address vs one address on file: agrees when the street number and ZIP are equal, or the street
 * number and street name (a missing suffix or directional on one side is allowed, a different one is not).
 * 'unchecked' when either side has no readable street line.
 */
export function addressAgreement(doc: CandidateAddress, onFile: CandidateAddress): 'agree' | 'disagree' | 'unchecked' {
  const d = streetParts(doc.line1);
  const c = streetParts(onFile.line1);
  if (!d || !c) return 'unchecked';
  if (d.number !== c.number) return 'disagree';
  const dz = zip5(doc.zip);
  const cz = zip5(onFile.zip);
  if (dz && cz && dz === cz) return 'agree';
  const same = d.core === c.core && (!d.suffix || !c.suffix || d.suffix === c.suffix) && (!d.dir || !c.dir || d.dir === c.dir);
  return same ? 'agree' : 'disagree';
}

interface ThirdCheck {
  /** Third identifiers on the document that agree with the record ('ssn4' first). */
  agree: ThirdIdentifier[];
  /** Staff reason when one disagrees, else ''. */
  conflict: string;
  /** An SSN or address is printed but could not be read: can't be checked. */
  unreadable: boolean;
}

/** The document's SSN-4 and address against the candidate's record. */
function checkThird(extracted: ExtractedFields, c: Candidate): ThirdCheck {
  const out: ThirdCheck = { agree: [], conflict: '', unreadable: !!(extracted.ssn_unreadable || extracted.address_unreadable) };
  const ssn = extracted.ssn_last4 && usable(extracted.ssn_last4.confidence) ? extracted.ssn_last4.value.replace(/\D/g, '') : '';
  const onFile = String(c.ssnLast4 ?? '').replace(/\D/g, '').slice(-4);
  let ssnConflict = false;
  if (ssn.length === 4 && onFile.length === 4) {
    if (ssn === onFile) out.agree.push('ssn4');
    else ssnConflict = true;
  }
  let addrConflict = false;
  const doc = extracted.address && usable(extracted.address.confidence) ? extracted.address.value : undefined;
  if (doc) {
    const results = (c.addresses || []).map((a) => addressAgreement(doc, a));
    if (results.includes('agree')) out.agree.push('address');
    else if (results.includes('disagree')) addrConflict = true;
  }
  if (ssnConflict) out.conflict = 'Name and date of birth match one patient, but the SSN last 4 on the document is different.';
  else if (addrConflict) out.conflict = 'Name and date of birth match one patient, but the address on the document is different (an old address, or someone else).';
  return out;
}

const THIRD_TEXT: Record<ThirdIdentifier, string> = { ssn4: 'SSN last 4', address: 'address' };
/** " The SSN last 4 and address also match." for the agreeing third identifiers not used as the second. */
function alsoMatch(ids: ThirdIdentifier[]): string {
  if (!ids.length) return '';
  const t = ids.map((i) => THIRD_TEXT[i]).join(' and ');
  return ` The ${t} also match${ids.length === 1 ? 'es' : ''}.`;
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
  if (extracted.ssn_unreadable || extracted.address_unreadable) return { ok: false, reason: 'an SSN or address on the document could not be read' };
  // Like a phone that can't be confirmed: an SSN-4 or address the chart has nothing to compare with may
  // be someone else's (a namesake), so name + DOB alone don't file it.
  if (extracted.ssn_last4 && usable(extracted.ssn_last4.confidence) && last4Of(c.ssnLast4).length !== 4) {
    return { ok: false, reason: 'the SSN last 4 on the document could not be checked (none on file)' };
  }
  if (extracted.address && usable(extracted.address.confidence) && !(c.addresses || []).some((a) => addressAgreement(extracted.address!.value, a) !== 'unchecked')) {
    return { ok: false, reason: 'the address on the document could not be checked (none on file)' };
  }
  return { ok: true };
}

/**
 * Look-alike guard for every automatic decision: another patient with a similar name and the same DOB
 * (or a DOB one character off) means the document could be theirs (twins, a misread first name).
 * Needs the wider candidate list from matchPatient; with only the exact search it finds nothing.
 */
export function lookalike(extracted: ExtractedFields, c: Candidate, candidates: Candidate[]): string {
  const first = norm(extracted.patient_name!.value.first);
  const last = norm(extracted.patient_name!.value.last);
  const birth = normDob(extracted.dob!.value);
  const same = (p: Candidate) => (!!p.chartPatientId && p.chartPatientId === c.chartPatientId) || (!!p.patientId && p.patientId === c.patientId);
  const close = candidates.find((p) => {
    if (same(p)) return false;
    const d = normDob(p.dateOfBirth);
    if (d !== birth && !nearDob(d, birth)) return false;
    return similarNames(first, last, p.firstName, p.lastName) || similarNames(norm(c.firstName), norm(c.lastName), p.firstName, p.lastName);
  });
  if (!close) return '';
  return normDob(close.dateOfBirth) === birth
    ? 'Another patient with a similar name has the same date of birth (for example twins). Check which patient this is.'
    : 'Another patient with a similar name has a date of birth one digit away. Check which patient this is.';
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
  if (docMrn && known.length && !known.includes(docMrn)) {
    return review('Name and date of birth match one patient, but the MRN on the document is different.');
  }
  // Third identifier: an SSN-4 or address that disagrees sends the document to staff, whatever agrees.
  const third = checkThird(extracted, c);
  if (third.conflict) return review(third.conflict);
  const exactName = norm(c.firstName) === first && norm(c.lastName) === last;
  const withThird = (r: Omit<MatchResult, 'checked_at'>): Omit<MatchResult, 'checked_at'> => {
    const extra = third.agree.filter((t) => t !== r.second_identifier);
    return extra.length ? { ...r, reason: r.reason + alsoMatch(extra), third_identifier: extra[0] } : r;
  };
  if (docMrn && known.length) {
    // Twins have different MRNs, so an exact chart name + MRN is decisive. A name that only loosely
    // agrees (a misread first name) plus a look-alike patient is not.
    const twin = exactName ? '' : lookalike(extracted, c, candidates);
    if (twin) return review(twin);
    return withThird({ decision: 'auto', reason: 'Name, date of birth and MRN match one patient.', candidates: 1, patient, second_identifier: 'mrn' });
  }

  // An MRN is printed but unreadable: it may disagree, so the phone cannot stand in for it.
  if (!docMrn && extracted.mrn_unreadable) {
    return review('Name and date of birth match one patient, but the MRN on the document could not be read.');
  }

  // Second identifier 2: exact full name + DOB + phone (only when the document has a patient phone).
  const docPhone = extracted.phone && usable(extracted.phone.confidence) ? digits10(extracted.phone.value) : '';
  if (docPhone.length === 10) {
    const phoneHit = c.phones.some((p) => digits10(p) === docPhone);
    if (exactName && phoneHit) {
      // A household often shares a phone (twins, a parent and child), so a look-alike always blocks it.
      const twin = lookalike(extracted, c, candidates);
      if (twin) return review(twin);
      return withThird({ decision: 'auto', reason: 'Full name, date of birth and phone match one patient.', candidates: 1, patient, second_identifier: 'phone' });
    }
    if (!phoneHit) return review('Name and date of birth match one patient, but the phone on the document is different.');
  }

  // Second identifier 3: exact full name + DOB + an SSN-4 or address that agrees, the way the phone does.
  // Twins and households share an address, so a look-alike always blocks it; an SSN or address that
  // couldn't be read might disagree, so it blocks too.
  if (exactName && third.agree.length && !third.unreadable) {
    const twin = lookalike(extracted, c, candidates);
    if (twin) return review(twin);
    const second = third.agree[0];
    return withThird({ decision: 'auto', reason: `Full name, date of birth and ${THIRD_TEXT[second]} match one patient.`, candidates: 1, patient, second_identifier: second });
  }

  if (opts.rule === 'name_dob') {
    const nd = nameDobCheck(extracted, c, candidates);
    if (nd.ok) {
      return withThird({
        decision: 'auto',
        reason: 'Exact full name and date of birth match one patient, and no other patient has a similar name and the same date of birth (MOATiT standard: name + date of birth).',
        candidates: 1,
        patient,
        rule: 'name_dob',
      });
    }
    return review(`Name and date of birth match one patient; no second identifier to confirm (name + date of birth rule not met: ${nd.reason}).`);
  }
  return review('Name and date of birth match one patient; no second identifier to confirm.');
}

/**
 * Rows from unity_search_patients → candidates. The SSN comes in as its last 4 only (patient.tools.ts and
 * roster.ts never pass on more); any longer value is cut to its last 4 here too.
 */
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
      ssnLast4: last4Of(p?.ssnLast4 ?? p?.ssn4),
      addresses: candidateAddresses(p),
    };
  });
}

/** The last 4 digits of an SSN field (masked or not); '' when it has fewer than 4 digits. Never more than 4. */
export function last4Of(v: unknown): string {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : '';
}

/** Addresses on a search row: `address` {line1, city, state, zipCode} (patient.tools.ts), and `addresses` (patient list). */
function candidateAddresses(p: any): CandidateAddress[] {
  const raw = [p?.address, ...(Array.isArray(p?.addresses) ? p.addresses : [])];
  const out: CandidateAddress[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const line1 = String(a.line1 ?? a.address1 ?? a.street ?? '').trim();
    if (!line1) continue;
    const addr: CandidateAddress = { line1, city: String(a.city ?? '').trim(), state: String(a.state ?? '').trim(), zip: zip5(a.zipCode ?? a.zip) };
    if (!out.some((x) => x.line1.toLowerCase() === addr.line1.toLowerCase() && x.zip === addr.zip)) out.push(addr);
  }
  return out;
}

/**
 * Search Veradigm (PM + EHR) by name + DOB through the agent tool path, then decide. With
 * INTAKE_ROSTER_CSV set, the local patient list is searched instead (roster.ts). A failed or
 * malformed search returns decision 'error' with the error code, never "no match".
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
  // INTAKE_ROSTER_CSV: the local patient list answers instead (same shape, same failures; roster.ts).
  const local = !!rosterPath();
  let r: any;
  try {
    r = await patientSearch(runTool)(tool, { lastName: name.value.last, firstName: name.value.first, dateOfBirth: dob.value });
  } catch (e) {
    r = toToolFailure(e, tool);
  }
  const fail = (code: string): MatchResult => ({
    decision: 'error',
    reason: local ? 'The search in the local patient list failed. Check the list file, then try again.' : 'The patient search in Veradigm® failed. Try again.',
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
  if (decided.decision !== 'auto' && decided.rule !== 'name_dob') return { ...decided, checked_at: stamp() };
  // Before any automatic decision, look wider: same-DOB patients whose last name starts with the same two
  // letters (twins, a misread first name, Beasley / Beesly), and patients with this last name at any DOB
  // (the same name with a DOB one digit off). decideMatch then sends look-alikes to staff.
  let wider = candidates;
  const wideSearches: Record<string, string>[] = [{ lastName: name.value.last.trim().slice(0, 2), dateOfBirth: dob.value }, { lastName: name.value.last.trim() }];
  for (const args of wideSearches) {
    // Same search path as above: the local patient list when INTAKE_ROSTER_CSV is set.
    const wide = await neighbours(args, patientSearch(runTool));
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

/**
 * The same person is the same candidate when either Veradigm® ID agrees: EHR chart ID with chart ID, or PM
 * patient ID with PM ID (never across the two). A wider search may return a patient as a PM-only row (no chart
 * ID) that the first search returned with both IDs (sandbox Oct 13, 2026: "Br" + DOB); keying the first by
 * chart ID and the second by PM ID made one patient look like two ("2 patients match"). Rows without any ID
 * compare by name + DOB.
 */
export function mergeCandidates(a: Candidate[], b: Candidate[]): Candidate[] {
  const charts = new Set(a.map((c) => c.chartPatientId).filter(Boolean));
  const pms = new Set(a.map((c) => c.patientId).filter(Boolean));
  const named = new Set(a.filter((c) => !c.chartPatientId && !c.patientId).map((c) => `${norm(c.firstName)}|${norm(c.lastName)}|${normDob(c.dateOfBirth)}`));
  const out = [...a];
  for (const c of b) {
    const same = c.chartPatientId || c.patientId
      ? (!!c.chartPatientId && charts.has(c.chartPatientId)) || (!!c.patientId && pms.has(c.patientId))
      : named.has(`${norm(c.firstName)}|${norm(c.lastName)}|${normDob(c.dateOfBirth)}`);
    if (same) continue;
    out.push(c);
    if (c.chartPatientId) charts.add(c.chartPatientId);
    if (c.patientId) pms.add(c.patientId);
    if (!c.chartPatientId && !c.patientId) named.add(`${norm(c.firstName)}|${norm(c.lastName)}|${normDob(c.dateOfBirth)}`);
  }
  return out;
}
