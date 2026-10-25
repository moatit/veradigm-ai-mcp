import type { UnityService } from '../../../unity/services/unity.service';
import { UnityActions } from '../../../unity/config/unity-endpoints';
import { UnityErrorHandler, UnityMCPError } from '../../../unity/utils/error-handler';
import { pick, unityRows } from '../../../unity/utils/unity-rows';
import { planJob, shiftCallingDays } from './scheduler';
import type { CallConfirmSettings } from './settings';
import { JobStore, NewJob } from './store';
import { OutreachJob, OutreachType } from './types';
import { addDays, CalDate, cmpDate, mdy, parseDate, splitDateTime, todayInClinic, toE164 } from './util';

/**
 * Call & Confirm list builders: read Veradigm® PM and create jobs with an attempt plan. They never
 * write to Veradigm and never dial; a job's attempts are called only after staff approve the day's list.
 *
 *   Confirm   GetSchedule for 1–3 business days out; skip visits already confirmed or cancelled (status, and
 *             the confirmation result code against GetAppointmentConfirmationResults).
 *   No-show   GetAppointmentsByChangeDTTM since the previous business day; status no show / missed.
 *   Recall    GetRecalls with a due date before today, open; skip patients with a visit already booked
 *             (GetScheduleByPatientID). At most OUTREACH_RECALL_DAILY_CAP (default 20) new recall jobs a day.
 *   Phones    GetPatient (cell, then home, then work).
 *
 * Errors are never "nothing to do" (CLAUDE.md rule 5): if any read fails, the builder throws and saves
 * nothing, so staff see an error instead of an empty list.
 *
 * PARAMETER LAYOUTS ARE UNVERIFIED. Veradigm's PM reference lists action names only. Every Parameter
 * assumption below follows Unity conventions (MM/DD/YYYY dates, PatientID in the envelope) and is marked
 * ASSUMPTION; check each one with `npm run verify:sandbox` / sandbox logs before the first real run.
 * Field names are read with several candidates via pick().
 */
export type UnityLike = Pick<UnityService, 'executeAction'>;

export interface BuildCtx {
  unity: UnityLike;
  store: JobStore;
  settings: CallConfirmSettings;
  now: Date;
  by: string;
}

export interface GenerateResult {
  type: OutreachType;
  /** Rows Veradigm® PM returned. */
  rows: number;
  /** Rows that matched the filter (not confirmed/cancelled, a no-show, a recall due). */
  matched: number;
  proposed: number;
  /** Created as skipped (no phone, opted out) or not created (already booked, cap); reasons with counts, no PHI. */
  skipped: Record<string, number>;
  /** Already had a job for the same patient and appointment/recall. */
  duplicates: number;
  /** Rows dropped because they had no patient ID. */
  unusable: number;
  /** Confirm jobs on the short plan (booked under 3 business days out). */
  short: number;
  window: string;
  jobs: OutreachJob[];
}

interface Candidate {
  patientId: string;
  firstName: string;
  appointment?: { id: string; date: string; time: string; provider: string };
  recall?: { type: string; due: string };
}

export async function read(unity: UnityLike, action: string, params: Record<string, string>, patientId = ''): Promise<Record<string, any>[]> {
  try {
    const res = await unity.executeAction<any>(action, params, patientId, 'PM');
    if (!res.success) throw UnityErrorHandler.createAPIError(res.error || `${action} failed`, action);
    return unityRows(res.data);
  } catch (e) {
    if (e instanceof UnityMCPError) throw e;
    throw UnityErrorHandler.handleUnknownError(e, action);
  }
}

// ---- Row parsing (candidate field names; Unity returns lower-case keys, pick() ignores case) ----

export const PATIENT_ID = ['PatientID', 'PatID', 'PID', 'PatientNumber', 'Patient_ID'];
const APPT_ID = ['AppointmentID', 'ApptID', 'Appointment_ID', 'SchedulingID', 'AppointmentNumber', 'ID'];
const APPT_DATE = ['ApptDate', 'AppointmentDate', 'StartDate', 'Date', 'ApptDateTime', 'AppointmentDateTime', 'Appointment_DateTime', 'StartDateTime'];
const APPT_TIME = ['ApptTime', 'AppointmentTime', 'StartTime', 'Time'];
const PROVIDER = ['ResourceName', 'ProviderName', 'Provider', 'Resource', 'DoctorName', 'ResourceDescription', 'Doctor'];
const STATUS = ['Status', 'ApptStatus', 'AppointmentStatus', 'StatusDescription', 'ApptStatusDescription', 'StatusName'];
const CONFIRM_RESULT = ['Appt_Confirmation_Result_ID', 'ConfirmationResultID', 'Confirmation_Result_ID', 'ConfirmationResult', 'ConfirmResult', 'ConfirmationStatus'];
const FIRST_NAME = ['PatientFirstName', 'FirstName', 'PatFirstName', 'First', 'FName'];
const FULL_NAME = ['PatientName', 'Patient', 'Name', 'PatName'];

/** First name from a row: an explicit field, else "Last, First" / "First Last". */
export function firstNameOf(row: Record<string, any>): string {
  const f = pick(row, ...FIRST_NAME);
  if (f) return f.split(/\s+/)[0];
  const full = pick(row, ...FULL_NAME);
  if (!full) return '';
  if (full.includes(',')) return (full.split(',')[1] || '').trim().split(/\s+/)[0] || '';
  return full.split(/\s+/)[0];
}

export function appointmentOf(row: Record<string, any>): Candidate['appointment'] & { status: string } {
  let date = pick(row, ...APPT_DATE);
  let time = pick(row, ...APPT_TIME);
  if (date && !time) ({ date, time } = splitDateTime(date));
  else if (date) date = splitDateTime(date).date;
  return {
    id: pick(row, ...APPT_ID),
    date,
    time,
    provider: pick(row, ...PROVIDER),
    status: pick(row, ...STATUS),
  };
}

export const isCancelled = (status: string) => /^x$|cancel|deleted|bumped|void/i.test(String(status || '').trim());
export const isNoShow = (status: string) => /^n$|no[\s_-]?show|missed/i.test(String(status || '').trim());
export const isConfirmedStatus = (status: string) => /^c$|^confirm/i.test(String(status || '').trim());

/**
 * A confirmation result that means "the patient said yes" (GetAppointmentConfirmationResults descriptions such
 * as "Answered - Yes", "Confirmed"). "Left message", "No answer", "Wrong number" are not confirmations.
 */
export function isPositiveConfirmation(description: string): boolean {
  const d = String(description || '');
  if (!d) return false;
  if (/\bno\b|\bnot\b|left|message|voice ?mail|unable|busy|wrong|disconnect|cancel/i.test(d)) return false;
  return /\byes\b|confirm|will (attend|come|be there)|attending/i.test(d);
}

// ---- Phone lookup (GetPatient) ----

/**
 * Best phone for an outbound call: cell first, then home/phone, then work.
 * Returns '' when no usable number is on file.
 */
export function phoneFromPatientRows(rows: Record<string, any>[]): { phone: string; firstName: string } {
  const row = rows[0];
  if (!row) return { phone: '', firstName: '' };
  const candidates = [
    pick(row, 'CellPhone', 'MobilePhone', 'Mobile', 'Cell', 'CellPhoneNumber', 'PhoneCell'),
    pick(row, 'HomePhone', 'Phone', 'PhoneNumber', 'HomePhoneNumber', 'PhoneHome', 'PrimaryPhone'),
    pick(row, 'WorkPhone', 'BusinessPhone', 'PhoneWork'),
  ];
  for (const c of candidates) {
    const e = toE164(c);
    if (e) return { phone: e, firstName: pick(row, 'FirstName', 'First', 'FName') };
  }
  return { phone: '', firstName: pick(row, 'FirstName', 'First', 'FName') };
}

export async function lookupPhone(unity: UnityLike, id: string): Promise<{ phone: string; firstName: string }> {
  // ASSUMPTION: GetPatient (Veradigm® PM) takes the patient in the PatientID envelope field;
  // Parameter1 = include picture Y/N, as the existing EHR call sends it.
  return phoneFromPatientRows(await read(unity, UnityActions.Patient.GET_PATIENT, { Parameter1: 'N' }, id));
}

/** A patient's PM appointment rows (GetScheduleByPatientID); failures throw. */
export async function patientSchedule(unity: UnityLike, patientId: string): Promise<Array<ReturnType<typeof appointmentOf>>> {
  return (await read(unity, UnityActions.Scheduling.GET_APPOINTMENTS, {}, patientId)).map(appointmentOf);
}

/** A non-cancelled, non-no-show visit on or after `from`. */
export const bookedFrom = (rows: Array<ReturnType<typeof appointmentOf>>, from: CalDate) =>
  rows.some((a) => {
    const d = parseDate(a.date);
    return !!d && cmpDate(d, from) >= 0 && !isCancelled(a.status) && !isNoShow(a.status);
  });

// ---- Turning candidates into jobs ----

async function propose(
  ctx: BuildCtx,
  type: OutreachType,
  candidates: Candidate[],
  meta: { rows: number; matched: number; unusable: number; window: string; skipped?: Record<string, number> }
): Promise<GenerateResult> {
  const { store, unity, settings, now } = ctx;
  const keyOf = (c: Candidate) =>
    `${type}|${c.patientId}|${c.appointment ? c.appointment.id || `${c.appointment.date} ${c.appointment.time}` : `${c.recall?.type}|${c.recall?.due}`}`;

  const fresh: Candidate[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const c of candidates) {
    const k = keyOf(c);
    if (seen.has(k) || store.findByDedupeKey(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    fresh.push(c);
  }

  // Any lookup failure throws here, before anything is saved.
  const phones = new Map<string, { phone: string; firstName: string }>();
  for (const c of fresh) {
    if (store.isOptedOut(c.patientId) || phones.has(c.patientId)) continue;
    phones.set(c.patientId, await lookupPhone(unity, c.patientId));
  }

  const skipped: Record<string, number> = { ...(meta.skipped || {}) };
  const batchTaken = new Map<string, string[]>();
  let short = 0;
  const items: NewJob[] = fresh.map((c) => {
    const base: NewJob = {
      type,
      patient_ref: { system: 'veradigm_pm', id: c.patientId },
      patient_first_name: c.firstName,
      phone: '',
      dedupe_key: keyOf(c),
    };
    if (c.appointment) base.appointment = c.appointment;
    if (c.recall) base.recall = c.recall;
    let reason = '';
    if (store.isOptedOut(c.patientId)) reason = 'Patient asked not to be called';
    else {
      const p = phones.get(c.patientId)!;
      if (!base.patient_first_name) base.patient_first_name = p.firstName;
      if (!p.phone) reason = 'No usable phone number on file';
      else base.phone = p.phone;
    }
    if (!reason) {
      const taken = batchTaken.get(c.patientId) || [];
      const apptDate = c.appointment ? parseDate(c.appointment.date) || undefined : undefined;
      const { kind, plan } = planJob({ type, now, appointmentDate: apptDate }, store.byPatient(c.patientId), settings, taken);
      base.plan = plan;
      base.plan_kind = kind;
      if (kind === 'short') short++;
      batchTaken.set(c.patientId, [...taken, ...plan.filter((a) => a.state === 'planned').map((a) => a.date)]);
      if (!plan.some((a) => a.state === 'planned')) reason = 'No attempt fits the call limits before the visit';
    }
    if (reason) {
      skipped[reason] = (skipped[reason] || 0) + 1;
      base.status = 'skipped';
      base.notes = reason;
    }
    return base;
  });

  const jobs = store.addMany(items, ctx.by, now);
  const proposed = jobs.filter((j) => j.status === 'scheduled').length;
  console.log(
    `[Outreach] built ${type}: rows=${meta.rows} matched=${meta.matched} scheduled=${proposed} skipped=${jobs.length - proposed} duplicates=${duplicates}`
  );
  return { type, rows: meta.rows, matched: meta.matched, unusable: meta.unusable, window: meta.window, proposed, skipped, duplicates, short, jobs };
}

/** Confirm candidates from GetSchedule rows for [from, to] (shared with the projection). */
export async function confirmCandidates(
  unity: UnityLike,
  from: CalDate,
  to: CalDate
): Promise<{ rows: number; unusable: number; candidates: Candidate[]; alreadyConfirmed: number }> {
  // ASSUMPTION: GetSchedule (Veradigm® PM) Parameter1 = start date MM/DD/YYYY, Parameter2 = end date
  // MM/DD/YYYY. Other Parameters blank = all providers/locations. Rows are re-filtered by date below.
  const rows = await read(unity, UnityActions.Scheduling.GET_SCHEDULE, { Parameter1: mdy(from), Parameter2: mdy(to) });
  // Confirmation result codes (Appt_Confirmation_Result_ID on the row) → descriptions. Only read when a row
  // carries one; a failed read is an error (we can't tell who already confirmed).
  let results: Map<string, string> | null = null;
  if (rows.some((r) => pick(r, ...CONFIRM_RESULT))) {
    const list = await read(unity, UnityActions.Scheduling.GET_CONFIRMATION_RESULTS, {});
    results = new Map(
      list.map((r) => [pick(r, 'Appt_Confirmation_Result_ID', 'ConfirmationResultID', 'ID'), pick(r, 'Short_Description', 'Description', 'Long_Description')])
    );
  }
  let unusable = 0;
  let alreadyConfirmed = 0;
  const candidates: Candidate[] = [];
  for (const r of rows) {
    const a = appointmentOf(r);
    const d = parseDate(a.date);
    if (!d || cmpDate(d, from) < 0 || cmpDate(d, to) > 0) continue;
    if (isCancelled(a.status) || isNoShow(a.status)) continue;
    const code = pick(r, ...CONFIRM_RESULT);
    if (isConfirmedStatus(a.status) || isPositiveConfirmation(results?.get(code) || code)) {
      alreadyConfirmed++;
      continue;
    }
    const patientId = pick(r, ...PATIENT_ID);
    if (!patientId) {
      unusable++;
      continue;
    }
    candidates.push({ patientId, firstName: firstNameOf(r), appointment: { id: a.id, date: a.date, time: a.time, provider: a.provider } });
  }
  return { rows: rows.length, unusable, candidates, alreadyConfirmed };
}

/** Confirmation calls: visits 1–3 business days out that are not confirmed or cancelled. */
export async function buildConfirmList(ctx: BuildCtx): Promise<GenerateResult> {
  const today = todayInClinic(ctx.now);
  const from = shiftCallingDays(today, 1, ctx.settings);
  const to = shiftCallingDays(today, 3, ctx.settings);
  const c = await confirmCandidates(ctx.unity, from, to);
  const skipped: Record<string, number> = {};
  if (c.alreadyConfirmed) skipped['Already confirmed'] = c.alreadyConfirmed;
  return propose(ctx, 'confirm', c.candidates, {
    rows: c.rows,
    matched: c.candidates.length + c.unusable,
    unusable: c.unusable,
    window: `${mdy(from)} – ${mdy(to)}`,
    skipped,
  });
}

/** No-show follow-up: visits marked no show / missed since the previous business day. */
export async function buildNoShowList(ctx: BuildCtx): Promise<GenerateResult> {
  const today = todayInClinic(ctx.now);
  const start = shiftCallingDays(today, -1, ctx.settings);
  // ASSUMPTION: GetAppointmentsByChangeDTTM Parameter1 = changed-since "MM/DD/YYYY HH:MM:SS",
  // Parameter2 = changed-until. Rows are filtered by status and by visit date (not in the future) here.
  const rows = await read(ctx.unity, UnityActions.Scheduling.GET_APPOINTMENTS_BY_CHANGE, {
    Parameter1: `${mdy(start)} 00:00:00`,
    Parameter2: `${mdy(today)} 23:59:59`,
  });
  let unusable = 0;
  const candidates: Candidate[] = [];
  for (const r of rows) {
    const a = appointmentOf(r);
    if (!isNoShow(a.status)) continue;
    const d = parseDate(a.date);
    if (d && (cmpDate(d, today) > 0 || cmpDate(d, start) < 0)) continue;
    const patientId = pick(r, ...PATIENT_ID);
    if (!patientId) {
      unusable++;
      continue;
    }
    candidates.push({ patientId, firstName: firstNameOf(r), appointment: { id: a.id, date: a.date, time: a.time, provider: a.provider } });
  }
  return propose(ctx, 'no_show', candidates, { rows: rows.length, matched: candidates.length + unusable, unusable, window: `${mdy(start)} – ${mdy(today)}` });
}

export const recallDailyCap = () => {
  const n = Number(process.env.OUTREACH_RECALL_DAILY_CAP);
  return Number.isInteger(n) && n >= 0 ? n : 20;
};

/** Recall outreach: open recalls past their due date, with nothing booked. Oldest due first, capped per day. */
export async function buildRecallList(ctx: BuildCtx, opts: { lookbackDays?: number } = {}): Promise<GenerateResult> {
  const today = todayInClinic(ctx.now);
  const from = addDays(today, -(opts.lookbackDays ?? 365));
  const to = addDays(today, -1);
  // ASSUMPTION: GetRecalls Parameter1 = due-date start MM/DD/YYYY, Parameter2 = due-date end MM/DD/YYYY,
  // blank PatientID = all patients. Rows are re-filtered by due date below.
  const rows = await read(ctx.unity, UnityActions.Scheduling.GET_RECALLS, { Parameter1: mdy(from), Parameter2: mdy(to) });
  let unusable = 0;
  const due: Array<Candidate & { d: CalDate }> = [];
  for (const r of rows) {
    const status = pick(r, 'Status', 'RecallStatus', 'StatusDescription');
    if (/complete|closed|satisf|cancel|inactive/i.test(status)) continue;
    const dueText = splitDateTime(pick(r, 'DueDate', 'RecallDate', 'RecallDueDate', 'Due', 'DateDue', 'TargetDate')).date;
    const d = parseDate(dueText);
    if (!d || cmpDate(d, from) < 0 || cmpDate(d, to) > 0) continue;
    const patientId = pick(r, ...PATIENT_ID);
    if (!patientId) {
      unusable++;
      continue;
    }
    due.push({
      d,
      patientId,
      firstName: firstNameOf(r),
      recall: { type: pick(r, 'RecallType', 'RecallTypeDescription', 'RecallDescription', 'Description', 'RecallReason', 'Type', 'Reason'), due: dueText },
    });
  }
  due.sort((a, b) => cmpDate(a.d, b.d));

  // Nothing booked: one GetScheduleByPatientID per new candidate, up to the daily cap.
  const cap = recallDailyCap();
  const skipped: Record<string, number> = {};
  const candidates: Candidate[] = [];
  const checked = new Set<string>();
  const count = (reason: string) => (skipped[reason] = (skipped[reason] || 0) + 1);
  let accepted = 0;
  for (const c of due) {
    if (ctx.store.findByDedupeKey(`recall|${c.patientId}|${c.recall!.type}|${c.recall!.due}`) || ctx.store.isOptedOut(c.patientId)) {
      candidates.push(c); // propose() counts duplicates and opt-outs
      continue;
    }
    if (checked.has(c.patientId)) continue; // one recall job per patient per run
    if (accepted >= cap) {
      count('Over the daily recall cap (next run)');
      continue;
    }
    checked.add(c.patientId);
    if (bookedFrom(await patientSchedule(ctx.unity, c.patientId), today)) {
      count('Visit already booked');
      continue;
    }
    candidates.push(c);
    accepted++;
  }
  return propose(ctx, 'recall', candidates, {
    rows: rows.length,
    matched: due.length + unusable,
    unusable,
    window: `due before ${mdy(today)}`,
    skipped,
  });
}
