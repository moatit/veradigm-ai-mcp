import { UnityActions } from '../../../unity/config/unity-endpoints';
import { ocrReviewReason } from './ocr';
import type { IntakeItem } from './store';

/**
 * Shadow mode: measure intake on real documents before anything may be filed.
 *
 *   INTAKE_MODE=shadow   the pipeline runs fully (OCR, pages and split, extract, match, category),
 *                        but filing is impossible whatever INTAKE_FILING says: file.ts refuses,
 *                        pipeline.ts stops before the filing step, and every Veradigm® call goes
 *                        through readOnlyUnity() / readOnlyRunTool() below, which let through only
 *                        the patient search and the category list (no SaveScanDocument, no
 *                        SaveTask, no other write). What Drawbridge *would* have done is recorded
 *                        on the item (`shadow`).
 *   Patients             live unity_search_patients (read-only; the normal path), or the local
 *                        roster (roster.ts, INTAKE_ROSTER_CSV) for an early start without Veradigm.
 *   Categories           live GetDocumentType, with INTAKE_CATEGORIES_CSV as the fallback
 *                        (doctypes.ts FallbackDocTypes).
 *
 * Staff then confirm each document on the item screen (`truth`: the right patient and category,
 * or not an IKI patient / unreadable / several patients with their pages). `npm run eval:shadow`
 * compares the two (shadow-report.ts).
 *
 * No I/O. The guards log refused action names only.
 */
export type IntakeMode = 'live' | 'shadow';

export function intakeMode(): IntakeMode {
  return String(process.env.INTAKE_MODE || '').trim().toLowerCase() === 'shadow' ? 'shadow' : 'live';
}
export const shadowMode = (): boolean => intakeMode() === 'shadow';

// ── Read-only Veradigm® access ───────────────────────────────────────────────

/** The only Veradigm® actions shadow mode may call: the patient search (PM + EHR) and the category list. */
export const SHADOW_READ_ACTIONS: ReadonlySet<string> = new Set([UnityActions.Patient.SEARCH_PATIENTS, UnityActions.Document.GET_DOCUMENT_TYPES]);
/** The only agent tool shadow mode may run. */
export const SHADOW_TOOLS: ReadonlySet<string> = new Set(['unity_search_patients']);

type ExecuteAction = (action: string, params?: any, patientId?: string, target?: any) => Promise<any>;
const refusedLogged = new Set<string>();
function refuse(action: string) {
  if (!refusedLogged.has(action)) console.error(`[Intake] shadow mode refused Veradigm action ${String(action).replace(/[^\w]/g, '').slice(0, 40)}`);
  refusedLogged.add(action);
  // The Unity response shape: a refusal, so callers treat it as "nothing was created".
  return { success: false, error: `Shadow mode is read-only: ${action} is not allowed.` };
}

/** A view of a UnityService that runs only SHADOW_READ_ACTIONS. The service itself is untouched (the phone agent may share it). */
export function readOnlyUnity<T extends { executeAction: ExecuteAction }>(unity: T | null | undefined): { executeAction: ExecuteAction } {
  return {
    executeAction: async (action, params, patientId, target) =>
      unity && SHADOW_READ_ACTIONS.has(action) ? unity.executeAction(action, params, patientId, target) : refuse(action),
  };
}

/**
 * Patch a UnityService instance so that it runs only SHADOW_READ_ACTIONS. For a process that is
 * only the shadow intake (shadow-server.ts): even code that holds the service directly can't write.
 */
export function lockUnityReadOnly(unity: { executeAction: ExecuteAction }): void {
  const run = unity.executeAction.bind(unity);
  unity.executeAction = async (action, params, patientId, target) => (SHADOW_READ_ACTIONS.has(action) ? run(action, params, patientId, target) : refuse(action));
}

/** runTool limited to SHADOW_TOOLS; anything else fails with SHADOW_READ_ONLY (never runs). */
export function readOnlyRunTool(runTool: (name: string, args: any, ctx?: any) => Promise<any>): (name: string, args: any, ctx?: any) => Promise<any> {
  return async (name, args, ctx) =>
    SHADOW_TOOLS.has(name) ? runTool(name, args, ctx) : { success: false, error_code: 'SHADOW_READ_ONLY', retryable: false, tool: name, message: 'Shadow mode is read-only.' };
}

export type ShadowWould = 'auto_file' | 'staff' | 'split';

/** What Drawbridge would have done with one item. */
export interface ShadowDecision {
  at: string;
  would: ShadowWould;
  /** Stable reason code (REASON_LABEL), for ranking in the report. */
  code: string;
  /** Staff-readable reason. */
  reason: string;
  /** The patient it would file to (auto_file) or the candidate shown to staff: roster key (chart ID or MRN). */
  patient_key?: string;
  /** Category it would file under (the suggestion; "(ready for indexing)" counts as none). */
  category?: string;
}

export type TruthOutcome = 'patient' | 'not_iki' | 'unreadable' | 'several';

export interface TruthPatient {
  /** Roster key (chart ID or MRN): the same key as ShadowDecision.patient_key. */
  key: string;
  name: string;
  dateOfBirth: string;
  mrn: string;
}

/** Ground truth from staff (the Confirm panel). */
export interface GroundTruth {
  at: string;
  by: string;
  outcome: TruthOutcome;
  patient?: TruthPatient;
  category?: string;
  /** Staff accepted the prediction as it was. */
  accepted?: boolean;
  /** outcome 'several': which pages belong to whom (no patient = not an IKI patient / unknown). */
  parts?: { pages: number[]; patient?: TruthPatient; not_iki?: boolean; category?: string }[];
}

export const REASON_LABEL: Record<string, string> = {
  auto: 'Two identifiers match one patient',
  split: 'Split into one document per patient',
  no_text: 'No readable text',
  ocr_low_confidence: 'OCR confidence below the gate',
  no_name_dob: 'No readable patient name and date of birth',
  no_match: 'No patient in the list with this name and date of birth',
  several_candidates: 'More than one patient with this name and date of birth',
  multi_patient: 'Document names more than one patient',
  no_chart: 'Patient has no chart',
  mrn_conflict: 'MRN on the document differs',
  mrn_unreadable: 'MRN printed but unreadable',
  phone_conflict: 'Phone on the document differs',
  no_second_id: 'Only name + DOB match (no MRN or phone)',
  no_category: 'No specific chart category',
  duplicate: 'Same file as an earlier document',
  pages_unchecked: 'Batch sender: pages not checked',
  sender_staff_only: 'Sender set to staff review',
  pages_two_on_page: 'Pages: a page shows two patients',
  pages_no_identifier: 'Pages: a page without a readable identifier',
  pages_near_identical: 'Pages: two almost-identical patients',
  pages_results_unassigned: 'Pages: results not under a patient line',
  pages_noncontiguous: 'Pages: a patient\'s pages are not together',
  pages_count_mismatch: 'Pages: page count of text and file differ',
  pages_split_off: 'Pages: several patients, splitting unavailable',
  pages_other: 'Pages: other page-check doubt',
  other: 'Other',
};

/** decideMatch() reason → code (the strings are fixed in match.ts; smoke-tested). */
export function matchReasonCode(decision: string, reason: string): string {
  const r = String(reason || '');
  if (decision === 'auto') return 'auto';
  if (/shows \d+ different patients/.test(r)) return 'multi_patient';
  if (/no readable patient name and date of birth/i.test(r)) return 'no_name_dob';
  if (/^No patient matches/.test(r)) return 'no_match';
  if (/\d+ patients match this name/.test(r)) return 'several_candidates';
  if (/no Veradigm® EHR chart/.test(r)) return 'no_chart';
  if (/MRN on the document is different/.test(r)) return 'mrn_conflict';
  if (/MRN on the document could not be read/.test(r)) return 'mrn_unreadable';
  if (/phone on the document is different/.test(r)) return 'phone_conflict';
  if (/no second identifier/.test(r)) return 'no_second_id';
  return 'other';
}

/** pages.ts / pipeline.ts page-check reason → code. */
export function pagesReasonCode(reason: string): string {
  const r = String(reason || '');
  if (/shows more than one patient|matches more than one patient|still names more than one/.test(r)) return 'pages_two_on_page';
  if (/no readable patient|no readable patient identifier|can't be assigned|No page shows a readable/i.test(r)) return 'pages_no_identifier';
  if (/almost, but not exactly|doesn't match the page before|can't be compared/.test(r)) return 'pages_near_identical';
  if (/results above|block of results/.test(r)) return 'pages_results_unassigned';
  if (/another patient in between/.test(r)) return 'pages_noncontiguous';
  if (/page count|page\(s\) but the file has/.test(r)) return 'pages_count_mismatch';
  if (/splitting is turned off|Splitting needs the OCR service|could not be told apart/i.test(r)) return 'pages_split_off';
  return 'pages_other';
}

/** itemAutoFileBlocker() text (pipeline.ts) → code. */
export function blockerCode(blocker: string): string {
  if (/document type/.test(blocker)) return 'no_category';
  if (/same file/.test(blocker)) return 'duplicate';
  if (/pages|batch sender/.test(blocker)) return 'pages_unchecked';
  if (/staff review/.test(blocker)) return 'sender_staff_only';
  return 'other';
}

/**
 * The shadow decision for an item the pipeline has finished with. `blocker` is
 * itemAutoFileBlocker(item) from pipeline.ts ('' when nothing blocks auto-filing).
 */
export function shadowDecision(item: IntakeItem, blocker: string, now: Date): ShadowDecision {
  const at = now.toISOString();
  const category = item.document_type && item.document_type.reason !== 'fallback' ? item.document_type.name : undefined;
  if (item.status === 'split') {
    return { at, would: 'split', code: 'split', reason: item.note || REASON_LABEL.split };
  }
  const m = item.match;
  if (!m) return { at, would: 'staff', code: 'no_text', reason: item.note || REASON_LABEL.no_text };
  const patient_key = m.patient?.chartPatientId || undefined;
  const staff = (code: string, reason: string): ShadowDecision => ({ at, would: 'staff', code, reason, ...(patient_key ? { patient_key } : {}), ...(category ? { category } : {}) });
  if (item.pages_check && !item.pages_check.ok) return staff(pagesReasonCode(item.pages_check.reason), item.pages_check.reason);
  if (m.decision !== 'auto') return staff(matchReasonCode(m.decision, m.reason), m.reason);
  const ocrGate = item.ocr ? ocrReviewReason(item.ocr) : null;
  if (ocrGate) return staff('ocr_low_confidence', ocrGate);
  if (blocker) return staff(blockerCode(blocker), `Matched, but would wait for staff: ${blocker}.`);
  return { at, would: 'auto_file', code: 'auto', reason: m.reason, ...(patient_key ? { patient_key } : {}), ...(category ? { category } : {}) };
}

/** One-line summary for the item history (no names or identifiers). */
export function shadowSummary(d: ShadowDecision): string {
  if (d.would === 'auto_file') return `shadow: would auto-file${d.category ? ` (${d.category})` : ''}`;
  if (d.would === 'split') return 'shadow: split by patient; each part decided on its own';
  return `shadow: would go to staff (${REASON_LABEL[d.code] || d.code})`;
}

// ── Ground truth ─────────────────────────────────────────────────────────────

/** "1-3, 5" → [1,2,3,5]; null when malformed, out of 1..max, or more than 500 pages. */
export function parsePageList(s: string, max?: number): number[] | null {
  const out = new Set<number>();
  const parts = String(s ?? '').replace(/pages?/gi, '').split(/[,;\s]+/).filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    const m = part.match(/^(\d{1,3})(?:-(\d{1,3}))?$/);
    if (!m) return null;
    const a = +m[1];
    const b = m[2] ? +m[2] : a;
    if (a < 1 || b < a || (max && b > max) || b - a > 500) return null;
    for (let p = a; p <= b; p++) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}

/** Truth for one filing unit (a whole document or a part), from its own truth or its parent's. */
export type UnitTruth = { kind: 'patient'; key: string; category?: string } | { kind: 'not_iki' } | { kind: 'unreadable' } | { kind: 'several' };

const sameKey = (a?: string, b?: string) => !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();

function fromTruth(t: GroundTruth): UnitTruth {
  if (t.outcome === 'patient' && t.patient) return { kind: 'patient', key: t.patient.key, ...(t.category ? { category: t.category } : {}) };
  if (t.outcome === 'not_iki') return { kind: 'not_iki' };
  if (t.outcome === 'unreadable') return { kind: 'unreadable' };
  return { kind: 'several' };
}

/**
 * A unit's truth. Its own when staff confirmed it; else derived from the parent's: one patient →
 * that patient for every part; several with pages → the patient(s) on this part's pages (two
 * different ones = several; a page staff did not assign = unconfirmed).
 */
export function unitTruth(item: IntakeItem, byId: (id: string) => IntakeItem | undefined): UnitTruth | null {
  if (item.truth) return fromTruth(item.truth);
  const parent = item.parent_id ? byId(item.parent_id) : undefined;
  const t = parent?.truth;
  if (!t || !item.part) return null;
  if (t.outcome !== 'several') return fromTruth(t);
  const owners = new Set<string>();
  let category: string | undefined;
  for (const p of item.part.pages) {
    const part = (t.parts || []).find((x) => x.pages.includes(p));
    if (!part) return null;
    if (part.patient) {
      owners.add(`p:${part.patient.key.trim().toUpperCase()}`);
      category = category || part.category;
    } else if (part.not_iki) owners.add('not_iki');
    else return null;
  }
  if (owners.size !== 1) return owners.size ? { kind: 'several' } : null;
  const only = [...owners][0];
  if (only === 'not_iki') return { kind: 'not_iki' };
  const part = (t.parts || []).find((x) => x.patient && `p:${x.patient.key.trim().toUpperCase()}` === only)!;
  return { kind: 'patient', key: part.patient!.key, ...(category ? { category } : {}) };
}

export type Agreement = 'undecided' | 'unconfirmed' | 'agrees' | 'disagrees';

/**
 * Does the confirmed truth agree with the prediction? undecided: no shadow decision yet.
 * Disagrees: the predicted patient (auto-file or the candidate shown) is not the confirmed one, a
 * document it would auto-file is not one IKI patient's, the categories differ, or a split's page
 * groups differ from staff's. A miss (staff, no candidate) for a patient document is not a disagreement.
 */
export function agreement(item: IntakeItem, byId: (id: string) => IntakeItem | undefined): Agreement {
  const d = item.shadow;
  if (!d) return 'undecided';
  if (d.would === 'split') {
    if (item.truth) {
      if (item.truth.outcome !== 'several') return 'disagrees';
      const want = (item.truth.parts || []).map((p) => p.pages.join(',')).sort();
      const got = (item.split?.pages || []).map((p) => p.join(',')).sort();
      return want.length === got.length && want.every((w, i) => w === got[i]) ? 'agrees' : 'disagrees';
    }
    const kids = (item.split?.children || []).map(byId).filter((c): c is IntakeItem => !!c);
    if (!kids.length || kids.some((c) => !unitTruth(c, byId))) return 'unconfirmed';
    return kids.some((c) => agreement(c, byId) === 'disagrees') ? 'disagrees' : 'agrees';
  }
  const t = unitTruth(item, byId);
  if (!t) return 'unconfirmed';
  if (t.kind !== 'patient') return d.would === 'auto_file' ? 'disagrees' : 'agrees';
  if (d.patient_key && !sameKey(d.patient_key, t.key)) return 'disagrees';
  if (d.would === 'auto_file' && !sameKey(d.patient_key, t.key)) return 'disagrees';
  if (t.category && d.category && t.category.trim().toLowerCase() !== d.category.trim().toLowerCase()) return 'disagrees';
  return 'agrees';
}

/** A unit that would have been auto-filed to the wrong chart (the number that must stay 0), with why. */
export function wrongPatient(item: IntakeItem, byId: (id: string) => IntakeItem | undefined): '' | 'different_patient' | 'not_iki' | 'several' {
  if (item.shadow?.would !== 'auto_file') return '';
  const t = unitTruth(item, byId);
  if (!t || t.kind === 'unreadable') return '';
  if (t.kind === 'not_iki') return 'not_iki';
  if (t.kind === 'several') return 'several';
  return sameKey(item.shadow.patient_key, t.key) ? '' : 'different_patient';
}
