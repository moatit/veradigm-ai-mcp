import type { PlatformDeps } from '../../registry';
import { isToolFailure, toToolFailure } from '../../../unity/utils/tool-result';
import type { Confidence, ExtractedFields } from './extract';

/**
 * Match a received document to one patient.
 *
 * Safety rule (FAX_INTAKE_ADDON.md): never file on one identifier, never guess between two patients.
 *   auto       exactly one patient matches name + DOB AND a second identifier agrees:
 *              the MRN, or (exact full name + DOB + the patient's phone, when the document has one)
 *   review     exactly one name + DOB match, but no second identifier (or a weak/conflicting one)
 *   none       nobody matches, or the document lacks a readable name or DOB
 *   ambiguous  more than one patient matches name + DOB
 *   error      the patient search failed; never treated as "no match" (CLAUDE.md rule 5)
 *
 * decideMatch() is the pure decision table (smoke-tested); matchPatient() runs the search.
 */
export type MatchDecision = 'auto' | 'review' | 'none' | 'ambiguous' | 'error';

export interface Candidate {
  patientId: string;
  chartPatientId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  mrn: string;
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

/** The decision table. Pure: same inputs, same answer. */
export function decideMatch(extracted: ExtractedFields, candidates: Candidate[]): Omit<MatchResult, 'checked_at'> {
  const name = extracted.patient_name;
  const dob = extracted.dob;
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
  if (docMrn && c.mrn) {
    if (normMrn(c.mrn) === docMrn) {
      return { decision: 'auto', reason: 'Name, date of birth and MRN match one patient.', candidates: 1, patient, second_identifier: 'mrn' };
    }
    return review('Name and date of birth match one patient, but the MRN on the document is different.');
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

  return review('Name and date of birth match one patient; no second identifier to confirm.');
}

/** Rows from unity_search_patients → candidates. */
export function toCandidates(result: any): Candidate[] {
  const rows: any[] = Array.isArray(result?.patients) ? result.patients : [];
  return rows.map((p) => ({
    patientId: String(p?.patientId ?? p?.id ?? ''),
    chartPatientId: String(p?.chartPatientId ?? ''),
    firstName: String(p?.firstName ?? ''),
    lastName: String(p?.lastName ?? ''),
    dateOfBirth: String(p?.dateOfBirth ?? ''),
    mrn: String(p?.mrn ?? ''),
    phones: [p?.phone?.home, p?.phone?.cell, p?.phone?.work, typeof p?.phone === 'string' ? p.phone : '']
      .filter((x) => typeof x === 'string' && x.trim())
      .map(String),
  }));
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
  if (!name || !dob || !usable(name.confidence) || !usable(dob.confidence)) {
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
  return { ...decideMatch(extracted, toCandidates(r)), checked_at: stamp() };
}
