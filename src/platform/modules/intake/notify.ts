import type { UnityService } from '../../../unity/services/unity.service';
import { UnityActions } from '../../../unity/config/unity-endpoints';
import { UnityErrorHandler, UnityMCPError } from '../../../unity/utils/error-handler';
import { pick, unityRows } from '../../../unity/utils/unity-rows';
import {
  criticalNotifyUser,
  isCritical,
  matchProvider,
  parseProviders,
  reviewUser,
  RESULT_KINDS,
  sameDayNoNotify,
  taskTarget,
  type EhrProvider,
  type NotifyRecord,
} from './rules';
import type { IntakeItem } from './store';

export * from './rules';

/**
 * Clinic rules around filing (settings and pure decisions: rules.ts): the Veradigm® reads and the review task's plan.
 *
 * Veradigm® reads, both read-only: GetProviders (EHR, cached for an hour) for the ordering provider's user name,
 * and GetScheduleByPatientID (PM) for the same-day check. Never GetSchedule for a patient: it ignores the
 * patient and returns everyone's visits. A failed read never blocks anything: the task goes to
 * INTAKE_REVIEW_USER, or is sent as on any other day. Nothing here writes to Veradigm® (file.ts does).
 */

// ── Veradigm® EHR providers (GetProviders, read-only) ────────────────────────

type UnityLike = Pick<UnityService, 'executeAction'>;
const CACHE_MS = 60 * 60_000;

/** GetProviders (Veradigm® EHR) with a one-hour cache. A failed load throws (never an empty list). */
export class ProviderDirectory {
  private providers: EhrProvider[] | null = null;
  private loadedAt = 0;
  private inflight: Promise<EhrProvider[]> | null = null;

  constructor(
    private unity: UnityLike,
    private now: () => number = Date.now
  ) {}

  async list(): Promise<EhrProvider[]> {
    if (this.providers && this.now() - this.loadedAt < CACHE_MS) return this.providers;
    if (!this.inflight) {
      this.inflight = this.load().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async load(): Promise<EhrProvider[]> {
    const action = UnityActions.Provider.GET_PROVIDERS;
    try {
      // Parameters blank: every provider the EHR user can see (as verify:sandbox calls it).
      const res = await this.unity.executeAction<any>(action, {}, '', 'EHR');
      if (!res || !res.success) throw UnityErrorHandler.createAPIError(res?.error || 'GetProviders failed', action);
      const providers = parseProviders(res.data);
      if (!providers.length) throw UnityErrorHandler.createAPIError('GetProviders returned no providers', action);
      this.providers = providers;
      this.loadedAt = this.now();
      return providers;
    } catch (e) {
      if (e instanceof UnityMCPError) throw e;
      throw UnityErrorHandler.handleUnknownError(e, action);
    }
  }
}

export type ProviderSource = Pick<ProviderDirectory, 'list'>;

const directories = new WeakMap<object, ProviderDirectory>();
/** One cached directory per Veradigm® connection. */
export function providerDirectory(unity: UnityLike): ProviderDirectory {
  let d = directories.get(unity);
  if (!d) directories.set(unity, (d = new ProviderDirectory(unity)));
  return d;
}

// ── Same-day appointment (GetScheduleByPatientID, read-only) ─────────────────

/** "10/8/2026 9:30:00 AM", "2026-10-08" → "10/08/2026"; '' when there is no date. */
function mdy(v: string): string {
  let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}/${m[1]}` : '';
}

/** Statuses that mean the patient was not seen: cancelled, rescheduled, no-show. */
const NOT_SEEN = /^(x|r|n|cancell?ed|rescheduled|no[\s-]?show)$/i;

/**
 * Whether the PM patient has an appointment (not cancelled, rescheduled or a no-show) on `date` (MM/DD/YYYY).
 * GetScheduleByPatientID returns the patient's whole history; rows of another patient are ignored. A failure is
 * { ok: false } (the caller then notifies as on any other day), never "no appointment".
 */
export async function sameDayAppointment(unity: UnityLike, pmPatientId: string, date: string): Promise<{ ok: true; appointment: boolean } | { ok: false; error_code: string }> {
  const action = UnityActions.Scheduling.GET_APPOINTMENTS;
  // GetSchedule ignores the patient and lists everyone's visits for a day: never used for one patient.
  if (/^GetSchedule$/i.test(action)) return { ok: false, error_code: 'SCHEDULE_ACTION_NOT_BY_PATIENT' };
  try {
    const res = await unity.executeAction<any>(action, {}, pmPatientId, 'PM');
    if (!res || !res.success) return { ok: false, error_code: 'SCHEDULE_LOOKUP_FAILED' };
    const appointment = unityRows(res.data).some((row) => {
      const pid = pick(row, 'Patient_ID', 'PatientID');
      if (pid && pid !== pmPatientId) return false;
      if (NOT_SEEN.test(pick(row, 'Status', 'AppointmentStatus', 'ApptStatus'))) return false;
      return mdy(pick(row, 'Appointment_DateTime', 'AppointmentDateTime', 'AppointmentDate', 'ApptDate')) === date;
    });
    return { ok: true, appointment };
  } catch (e: any) {
    return { ok: false, error_code: e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' ? 'SCHEDULE_TIMEOUT' : 'SCHEDULE_LOOKUP_FAILED' };
  }
}

// ── The review task of a filed document ──────────────────────────────────────

export interface NotifyPlan {
  /** What the item records (recipient, why, critical, same-day). */
  record: NotifyRecord;
  /** '' = no task. */
  recipient: string;
  priority: 'High' | 'Medium';
  /** SaveTask comment and subject start. */
  comment: string;
  subjectPrefix: string;
}

export interface NotifyDeps {
  unity: UnityLike;
  providers?: ProviderSource;
}

/**
 * Who gets the review task of a filed document, at which priority, or why none is sent. Never throws: a
 * failed lookup falls back (provider: INTAKE_REVIEW_USER; schedule: a task as on any other day).
 */
export async function planReviewTask(item: IntakeItem, deps: NotifyDeps): Promise<NotifyPlan> {
  const critical = isCritical(item);
  const record: NotifyRecord = { critical, call_required: critical, priority: critical ? 'High' : 'Medium' };
  const plan = (recipient: string): NotifyPlan => ({
    record: { ...record, ...(recipient ? { recipient } : {}) },
    recipient,
    priority: critical ? 'High' : 'Medium',
    comment: critical ? 'CRITICAL result: a phone call is required. New outside document for review' : 'New outside document for review',
    subjectPrefix: critical ? 'CRITICAL: ' : '',
  });
  const x = item.extracted;

  // Same-day appointment: the provider sees the result at the visit (critical results always notify).
  if (!critical && sameDayNoNotify() && x && RESULT_KINDS.has(x.kind.value)) {
    const date = x.collection_date?.value || '';
    const pm = item.match?.patient?.patientId || '';
    if (!date) record.same_day = { note: 'No collection or service date on the document; notified as usual.' };
    else if (!pm) record.same_day = { date, note: 'No Veradigm® PM patient ID to look up appointments; notified as usual.' };
    else {
      const r = await sameDayAppointment(deps.unity, pm, date);
      if (!r.ok) record.same_day = { date, note: `Appointment lookup failed (${r.error_code}); notified as usual.` };
      else if (r.appointment) {
        record.same_day = { date, appointment: true, note: `Appointment on ${date}, the collection date: no task (clinic rule).` };
        record.skipped = 'same_day_appointment';
        return plan('');
      } else record.same_day = { date, appointment: false, note: `No appointment on ${date}.` };
    }
  }

  // The normal recipient: the ordering provider (INTAKE_TASK_TARGET=ordering_provider) or INTAKE_REVIEW_USER.
  let recipient = reviewUser();
  if (recipient) record.recipient_source = 'review_user';
  const op = x?.ordering_provider;
  if (op) record.ordering_provider = { name: op.value.full, note: 'Not used: this clinic sends review tasks to the review user.' };
  if (taskTarget() === 'ordering_provider') {
    if (!op) record.ordering_provider = { name: '', note: 'No ordering provider found on the document.' };
    else if (op.confidence === 'low') record.ordering_provider!.note = 'The document names two different providers.';
    else {
      try {
        const list = await (deps.providers || providerDirectory(deps.unity)).list();
        const m = matchProvider(op.value, list);
        record.ordering_provider = { name: op.value.full, ...(m.provider ? { user: m.provider.user } : {}), note: m.note };
        if (m.provider) {
          recipient = m.provider.user;
          record.recipient_source = 'ordering_provider';
        }
      } catch (e: any) {
        record.ordering_provider = { name: op.value.full, note: `Provider list unavailable (${e?.code || 'error'}).` };
      }
    }
  }

  // Critical: INTAKE_CRITICAL_NOTIFY when set, else the normal recipient.
  if (critical && criticalNotifyUser()) {
    recipient = criticalNotifyUser();
    record.recipient_source = 'critical_notify';
  }
  if (!recipient) delete record.recipient_source;
  return plan(recipient);
}
