import { pick, unityRows } from '../../../unity/utils/unity-rows';
import { within, type ExtractedFields, type ProviderName, type RequestKind } from './extract';
import type { IntakeItem } from './store';

/**
 * Clinic rules around filing: documents that always go to a person, critical results, who gets the review
 * task, and same-day appointments. Each is a setting, so clinics can differ (Idaho Kidney Institute's
 * answers, Oct 13, 2026, are in docs/drawbridge/CLINIC_ONBOARDING.md):
 *
 *   INTAKE_ALWAYS_PERSON       document types never auto-filed, even with a perfect patient match:
 *                              records_request, prior_auth, refill_request, referral (comma-separated).
 *                              Unset: all four. "none": the rule is off. An unknown name keeps all four
 *                              (a typo never lets a prior authorization through).
 *   INTAKE_TASK_TARGET         who gets a filed document's review task: review_user (default,
 *                              INTAKE_REVIEW_USER) or ordering_provider (the ordering provider printed on the
 *                              document, matched to exactly one Veradigm® EHR provider with a user name;
 *                              INTAKE_REVIEW_USER when there is no confident match)
 *   INTAKE_CRITICAL_NOTIFY     Veradigm® EHR user who gets a critical result's task (default: the normal
 *                              recipient above)
 *   INTAKE_SAME_DAY_NO_NOTIFY  on: no review task for a lab or imaging result collected on the day of one of
 *                              the patient's appointments (critical results always get one). Default off.
 *
 * Critical results (always on): a filed document carrying the lab's own critical flags (HH/LL, "(C)",
 * CRITICAL/PANIC; extract.ts abnormalFlags) gets its review task as High priority with "CRITICAL" first in the
 * subject, and the item records that a phone call is required. Drawbridge never places a call. A critical
 * result is never auto-filed without someone set up to receive that task, and one filed without a task goes
 * back to staff (file.ts).
 *
 * This file holds the settings and the pure decisions (no I/O, safe for the offline bench); notify.ts does the
 * Veradigm® reads (GetProviders, GetScheduleByPatientID; read-only) and plans the review task.
 */

// ── Documents that always go to a person ─────────────────────────────────────

export type AlwaysPersonType = RequestKind;
export const ALWAYS_PERSON_TYPES: AlwaysPersonType[] = ['records_request', 'prior_auth', 'refill_request', 'referral'];
export const ALWAYS_PERSON_LABEL: Record<AlwaysPersonType, string> = {
  records_request: 'Medical records request',
  prior_auth: 'Prior authorization',
  refill_request: 'Medication refill request',
  referral: 'Referral',
};
/** Other spellings accepted in INTAKE_ALWAYS_PERSON. */
const ALIASES: Record<string, AlwaysPersonType> = {
  records: 'records_request', medical_records_request: 'records_request', records_requests: 'records_request',
  prior_authorization: 'prior_auth', prior_authorizations: 'prior_auth', pa: 'prior_auth',
  refill: 'refill_request', refills: 'refill_request', refill_requests: 'refill_request', medication_refill: 'refill_request',
  referrals: 'referral',
};

let listWarned = false;
/** INTAKE_ALWAYS_PERSON as a list (see the header). */
export function alwaysPersonTypes(raw: string | undefined = process.env.INTAKE_ALWAYS_PERSON): AlwaysPersonType[] {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return [...ALWAYS_PERSON_TYPES];
  if (/^(none|off)$/.test(v)) return [];
  const want = v.split(/[\s,;]+/).filter(Boolean).map((w) => ALIASES[w.replace(/-/g, '_')] || w.replace(/-/g, '_'));
  if (want.some((w) => !ALWAYS_PERSON_TYPES.includes(w as AlwaysPersonType))) {
    if (!listWarned) console.error('[Intake] INTAKE_ALWAYS_PERSON names an unknown document type; all four types go to staff');
    listWarned = true;
    return [...ALWAYS_PERSON_TYPES];
  }
  return ALWAYS_PERSON_TYPES.filter((t) => want.includes(t));
}

/**
 * Which always-to-a-person type the document is, or null (extract.ts classifyRequest). A referral is one
 * titled as such ("REFERRAL FORM", "RE: Referral", a ticked box) or a letter that refers the patient, not any
 * document classifyKind calls 'referral': that reading follows passing mentions ("Reason for referral: CKD"
 * on a lab result), measured on the bench.
 */
export function alwaysPersonType(x: ExtractedFields | undefined): AlwaysPersonType | null {
  if (!x?.request || (x.request.confidence !== 'high' && x.request.confidence !== 'medium')) return null;
  return alwaysPersonTypes().includes(x.request.value) ? x.request.value : null;
}

/** "Prior authorization: always reviewed by staff", or '' (staff-readable; shown on the item). */
export function alwaysPersonReason(x: ExtractedFields | undefined): string {
  const t = alwaysPersonType(x);
  return t ? `${ALWAYS_PERSON_LABEL[t]}: always reviewed by staff` : '';
}

// ── Settings ─────────────────────────────────────────────────────────────────

export type TaskTarget = 'ordering_provider' | 'review_user';

/** INTAKE_TASK_TARGET: ordering_provider, else review_user. */
export function taskTarget(): TaskTarget {
  return /^ordering[_\s-]?provider$/i.test(String(process.env.INTAKE_TASK_TARGET || '').trim()) ? 'ordering_provider' : 'review_user';
}
export const reviewUser = (): string => String(process.env.INTAKE_REVIEW_USER || '').trim();
export const criticalNotifyUser = (): string => String(process.env.INTAKE_CRITICAL_NOTIFY || '').trim();
export function sameDayNoNotify(): boolean {
  return /^(on|1|y|yes|true)$/i.test(String(process.env.INTAKE_SAME_DAY_NO_NOTIFY || '').trim());
}

/** The lab's own critical flags were read on the document. */
export const isCritical = (item: Pick<IntakeItem, 'extracted'>): boolean => !!item.extracted?.abnormal?.critical;

/**
 * Who surely gets a critical result's task without any lookup ('' = nobody: such a document is never
 * auto-filed). The ordering provider may still be found at filing time; this is the fallback.
 */
export const criticalFallbackRecipient = (): string => criticalNotifyUser() || reviewUser();

/** Kinds that are "results" for the same-day rule. */
export const RESULT_KINDS: ReadonlySet<string> = new Set(['lab_result', 'imaging']);

// ── What the item records ────────────────────────────────────────────────────

export interface NotifyRecord {
  /** The lab's critical flags are on the document. */
  critical: boolean;
  /** Critical: someone must phone (the provider or the patient, per clinic routine). Drawbridge never calls. */
  call_required: boolean;
  /** Task priority ('High' for a critical result). */
  priority?: 'High' | 'Medium';
  /** Veradigm® EHR user the review task went to, or would have gone to. */
  recipient?: string;
  recipient_source?: 'critical_notify' | 'ordering_provider' | 'review_user';
  /** The ordering provider printed on the document and what the provider list said. */
  ordering_provider?: { name: string; user?: string; note: string };
  /** No task on purpose. */
  skipped?: 'same_day_appointment';
  /** The same-day check (INTAKE_SAME_DAY_NO_NOTIFY): the date compared and what the schedule said. */
  same_day?: { date?: string; appointment?: boolean; note: string };
  task_id?: string;
  /** TASK_REJECTED / TASK_UNCERTAIN / NO_RECIPIENT / NO_TASK_ID. */
  task_error?: string;
  /** Staff confirmed the provider was told (after a critical result's task could not be created). */
  handled_by?: string;
  handled_at?: string;
}

/** Who a review task went to, for staff screens and the item history. */
export const RECIPIENT_SOURCE_LABEL: Record<NonNullable<NotifyRecord['recipient_source']>, string> = {
  ordering_provider: 'ordering provider',
  review_user: 'review user',
  critical_notify: 'critical results recipient',
};

// ── Veradigm® EHR providers: rows and matching ───────────────────────────────

export interface EhrProvider {
  id: string;
  /** Veradigm® EHR user name (SaveTask's target user); '' when the row has none. */
  user: string;
  first: string;
  last: string;
}

const truthy = (v: string) => /^(1|y|yes|true)$/i.test(v.trim());

/**
 * GetProviders rows → providers. Field names are read through aliases: the action is in Veradigm's EHR
 * reference and in verify:sandbox, but its row fields have not been seen on the sandbox yet. Only a field
 * that is a login (UserName and its spellings) is used as the task target; a provider code (EntryCode) is not.
 * Inactive providers are left out.
 */
export function parseProviders(data: unknown): EhrProvider[] {
  return unityRows(data)
    .map((r) => {
      let first = pick(r, 'FirstName', 'ProviderFirstName', 'First');
      let last = pick(r, 'LastName', 'ProviderLastName', 'Last');
      if (!last) {
        // Only a display name: "Hale, Rowan" or "Rowan Hale".
        const full = pick(r, 'ProviderName', 'Name', 'DisplayName', 'FullName');
        const comma = full.match(/^([^,]+),\s*([^\s,]+)/);
        const parts = full.split(/\s+/).filter(Boolean);
        if (comma) [last, first] = [comma[1], comma[2]];
        else if (parts.length >= 2) [first, last] = [parts[0], parts[parts.length - 1]];
      }
      return {
        id: pick(r, 'ProviderID', 'ProviderId', 'ID', 'EntryCode', 'Code'),
        user: pick(r, 'UserName', 'Username', 'User_Name', 'LoginName', 'UserLogin', 'EHRUserName'),
        first: String(first || '').trim(),
        last: String(last || '').trim(),
        inactive: truthy(pick(r, 'Inactive', 'IsInactive')) || /^(n|no|false|0)$/i.test(pick(r, 'Active', 'IsActive')),
      };
    })
    .filter((p) => p.last && !p.inactive)
    .map(({ inactive: _i, ...p }) => p);
}

const letters = (s: unknown) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * The one provider the document names, or why there is none. Confident when exactly one provider has the
 * last name and the first name (or the printed initial); a last name alone ("Dr. Hale") when only one
 * provider has it. A last name one letter off (fax OCR: "Castel") counts only with the exact first name
 * and nobody else close. A provider without a user name can't receive a task.
 */
export function matchProvider(p: ProviderName, list: EhrProvider[]): { provider?: EhrProvider; note: string } {
  const last = letters(p.last);
  const first = letters(p.first);
  const sameLast = list.filter((x) => letters(x.last) === last);
  let pool = sameLast;
  if (first) {
    pool = first.length === 1 ? sameLast.filter((x) => letters(x.first).startsWith(first)) : sameLast.filter((x) => letters(x.first) === first);
    if (!pool.length && first.length > 1 && last.length >= 4) {
      const near = list.filter((x) => letters(x.first) === first && within(letters(x.last), last, 1));
      const others = list.filter((x) => !near.includes(x) && within(letters(x.last), last, 2));
      if (near.length === 1 && !others.length) pool = near;
    }
  }
  if (pool.length > 1) return { note: `${pool.length} providers in Veradigm® EHR match this name` };
  if (!pool.length) return { note: 'not found among the Veradigm® EHR providers' };
  if (!pool[0].user) return { note: 'found in Veradigm® EHR, but the provider list gives no user name to send a task to' };
  return { provider: pool[0], note: 'matched to one Veradigm® EHR provider' };
}
