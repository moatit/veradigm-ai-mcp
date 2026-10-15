import type { UnityService } from '../../../unity/services/unity.service';
import { UnityActions } from '../../../unity/config/unity-endpoints';
import { UnityErrorHandler, UnityMCPError } from '../../../unity/utils/error-handler';
import { pick, unityRows } from '../../../unity/utils/unity-rows';
import { NewJob, outreachJobs } from './store';
import { OutreachJob, OutreachType } from './types';
import { addDays, cmpDate, mdy, nextBusinessDay, parseDate, splitDateTime, todayInClinic, toE164 } from './util';

/**
 * Outreach generators: read Veradigm® PM and propose outreach jobs. They never write to
 * Veradigm and never dial; every job they create waits for a staff member's approval.
 *
 * Errors are never "nothing to do" (CLAUDE.md rule 5): if any read fails, the generator throws
 * and saves nothing, so staff see an error instead of an empty list.
 *
 * PARAMETER LAYOUTS ARE UNVERIFIED. Veradigm's PM reference lists action names only. Every
 * Parameter assumption below follows Unity conventions (MM/DD/YYYY dates, PatientID in the
 * envelope) and is marked ASSUMPTION; check each one with `npm run verify:sandbox` / sandbox
 * logs before the first real run. Field names are read with several candidates via pick().
 */
export type UnityLike = Pick<UnityService, 'executeAction'>;

export interface GenerateResult {
  type: OutreachType;
  /** Rows Veradigm® PM returned. */
  rows: number;
  /** Rows that matched the filter (not cancelled / was a no-show / recall due). */
  matched: number;
  proposed: number;
  /** Created as skipped (no phone, opted out); reasons with counts, no PHI. */
  skipped: Record<string, number>;
  /** Already had a job for the same patient and appointment/recall. */
  duplicates: number;
  /** Rows dropped because they had no patient ID. */
  unusable: number;
  window: string;
  jobs: OutreachJob[];
}

interface Candidate {
  patientId: string;
  firstName: string;
  appointment?: { id: string; date: string; time: string; provider: string };
  recall?: { type: string; due: string };
}

async function read(unity: UnityLike, action: string, params: Record<string, string>, patientId = ''): Promise<Record<string, any>[]> {
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

const PATIENT_ID = ['PatientID', 'PatID', 'PID', 'PatientNumber', 'Patient_ID'];
const APPT_ID = ['AppointmentID', 'ApptID', 'SchedulingID', 'AppointmentNumber', 'ID'];
const APPT_DATE = ['ApptDate', 'AppointmentDate', 'StartDate', 'Date', 'ApptDateTime', 'AppointmentDateTime', 'StartDateTime'];
const APPT_TIME = ['ApptTime', 'AppointmentTime', 'StartTime', 'Time'];
const PROVIDER = ['ResourceName', 'ProviderName', 'Provider', 'Resource', 'DoctorName', 'ResourceDescription', 'Doctor'];
const STATUS = ['Status', 'ApptStatus', 'AppointmentStatus', 'StatusDescription', 'ApptStatusDescription', 'StatusName'];
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

const isCancelled = (status: string) => /cancel|deleted|bumped|void/i.test(status);
export const isNoShow = (status: string) => /no[\s_-]?show|missed/i.test(status);

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

async function lookupPhones(unity: UnityLike, ids: string[]): Promise<Map<string, { phone: string; firstName: string }>> {
  const out = new Map<string, { phone: string; firstName: string }>();
  for (const id of ids) {
    if (out.has(id)) continue;
    // ASSUMPTION: GetPatient (Veradigm® PM) takes the patient in the PatientID envelope field;
    // Parameter1 = include picture Y/N, as the existing EHR call sends it.
    const rows = await read(unity, UnityActions.Patient.GET_PATIENT, { Parameter1: 'N' }, id);
    out.set(id, phoneFromPatientRows(rows));
  }
  return out;
}

// ---- Turning candidates into jobs ----

async function propose(
  unity: UnityLike,
  type: OutreachType,
  candidates: Candidate[],
  meta: { rows: number; matched: number; unusable: number; window: string },
  by: string
): Promise<GenerateResult> {
  const keyOf = (c: Candidate) =>
    `${type}|${c.patientId}|${c.appointment ? c.appointment.id || `${c.appointment.date} ${c.appointment.time}` : `${c.recall?.type}|${c.recall?.due}`}`;

  const fresh: Candidate[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const c of candidates) {
    const k = keyOf(c);
    if (seen.has(k) || outreachJobs.findByDedupeKey(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    fresh.push(c);
  }

  const needLookup = fresh.filter((c) => !outreachJobs.isOptedOut(c.patientId)).map((c) => c.patientId);
  // Any lookup failure throws here, before anything is saved.
  const phones = await lookupPhones(unity, needLookup);

  const skipped: Record<string, number> = {};
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
    if (outreachJobs.isOptedOut(c.patientId)) reason = 'Patient asked not to be called';
    else {
      const p = phones.get(c.patientId)!;
      if (!base.patient_first_name) base.patient_first_name = p.firstName;
      if (!p.phone) reason = 'No usable phone number on file';
      else base.phone = p.phone;
    }
    if (reason) {
      skipped[reason] = (skipped[reason] || 0) + 1;
      base.status = 'skipped';
      base.notes = reason;
    }
    return base;
  });

  const jobs = outreachJobs.addMany(items, by);
  console.log(
    `[Outreach] generated ${type}: rows=${meta.rows} matched=${meta.matched} proposed=${jobs.filter((j) => j.status === 'proposed').length} skipped=${jobs.filter((j) => j.status === 'skipped').length} duplicates=${duplicates}`
  );
  return {
    type,
    ...meta,
    proposed: jobs.filter((j) => j.status === 'proposed').length,
    skipped,
    duplicates,
    jobs,
  };
}

/**
 * Reminder calls for appointments on one date (default: next business day). Cancelled
 * appointments are skipped.
 */
export async function generateReminders(
  unity: UnityLike,
  opts: { date?: string; now?: Date; by?: string } = {}
): Promise<GenerateResult> {
  const target = (opts.date && parseDate(opts.date)) || nextBusinessDay(opts.now);
  if (opts.date && !parseDate(opts.date)) throw UnityErrorHandler.createValidationError('Date must be YYYY-MM-DD or MM/DD/YYYY');
  // ASSUMPTION: GetSchedule (Veradigm® PM) Parameter1 = start date MM/DD/YYYY,
  // Parameter2 = end date MM/DD/YYYY (same day). Other Parameters left blank = all
  // providers/locations. Rows are re-filtered by date below in case the range is ignored.
  const rows = await read(unity, UnityActions.Scheduling.GET_SCHEDULE, { Parameter1: mdy(target), Parameter2: mdy(target) });
  let unusable = 0;
  const candidates: Candidate[] = [];
  for (const r of rows) {
    const a = appointmentOf(r);
    if (isCancelled(a.status)) continue;
    const d = parseDate(a.date);
    if (d && cmpDate(d, target) !== 0) continue;
    const patientId = pick(r, ...PATIENT_ID);
    if (!patientId) {
      unusable++;
      continue;
    }
    candidates.push({ patientId, firstName: firstNameOf(r), appointment: { id: a.id, date: a.date || mdy(target), time: a.time, provider: a.provider } });
  }
  return propose(unity, 'reminder', candidates, { rows: rows.length, matched: candidates.length + unusable, unusable, window: mdy(target) }, opts.by || 'system');
}

/**
 * No-show follow-up: appointments changed in the last N days (default 3) whose status says
 * no show / missed.
 */
export async function generateNoShows(
  unity: UnityLike,
  opts: { days?: number; now?: Date; by?: string } = {}
): Promise<GenerateResult> {
  const days = Math.min(Math.max(Math.floor(opts.days ?? 3), 1), 30);
  const today = todayInClinic(opts.now);
  const start = addDays(today, -days);
  // ASSUMPTION: GetAppointmentsByChangeDTTM Parameter1 = changed-since date/time
  // "MM/DD/YYYY HH:MM:SS", Parameter2 = changed-until date/time. Rows are filtered by status
  // and by appointment date (not in the future) here.
  const rows = await read(unity, UnityActions.Scheduling.GET_APPOINTMENTS_BY_CHANGE, {
    Parameter1: `${mdy(start)} 00:00:00`,
    Parameter2: `${mdy(today)} 23:59:59`,
  });
  let unusable = 0;
  const candidates: Candidate[] = [];
  for (const r of rows) {
    const a = appointmentOf(r);
    if (!isNoShow(a.status)) continue;
    const d = parseDate(a.date);
    if (d && cmpDate(d, today) > 0) continue;
    const patientId = pick(r, ...PATIENT_ID);
    if (!patientId) {
      unusable++;
      continue;
    }
    candidates.push({ patientId, firstName: firstNameOf(r), appointment: { id: a.id, date: a.date, time: a.time, provider: a.provider } });
  }
  return propose(unity, 'no_show', candidates, { rows: rows.length, matched: candidates.length + unusable, unusable, window: `${mdy(start)} – ${mdy(today)}` }, opts.by || 'system');
}

/**
 * Recall outreach: recalls with a due date in [from, to] (default: today .. +30 days).
 * Closed/completed recalls are skipped.
 */
export async function generateRecalls(
  unity: UnityLike,
  opts: { from?: string; to?: string; now?: Date; by?: string } = {}
): Promise<GenerateResult> {
  const today = todayInClinic(opts.now);
  const from = (opts.from && parseDate(opts.from)) || today;
  const to = (opts.to && parseDate(opts.to)) || addDays(from, 30);
  if ((opts.from && !parseDate(opts.from)) || (opts.to && !parseDate(opts.to))) {
    throw UnityErrorHandler.createValidationError('Dates must be YYYY-MM-DD or MM/DD/YYYY');
  }
  if (cmpDate(from, to) > 0) throw UnityErrorHandler.createValidationError('The window start is after its end');
  // ASSUMPTION: GetRecalls Parameter1 = due-date start MM/DD/YYYY, Parameter2 = due-date end
  // MM/DD/YYYY, blank PatientID = all patients. Rows are re-filtered by due date below.
  const rows = await read(unity, UnityActions.Scheduling.GET_RECALLS, { Parameter1: mdy(from), Parameter2: mdy(to) });
  let unusable = 0;
  const candidates: Candidate[] = [];
  for (const r of rows) {
    const status = pick(r, 'Status', 'RecallStatus', 'StatusDescription');
    if (/complete|closed|satisf|cancel|inactive/i.test(status)) continue;
    const due = splitDateTime(pick(r, 'DueDate', 'RecallDate', 'RecallDueDate', 'Due', 'DateDue', 'TargetDate')).date;
    const d = parseDate(due);
    if (!d || cmpDate(d, from) < 0 || cmpDate(d, to) > 0) continue;
    const patientId = pick(r, ...PATIENT_ID);
    if (!patientId) {
      unusable++;
      continue;
    }
    candidates.push({
      patientId,
      firstName: firstNameOf(r),
      recall: { type: pick(r, 'RecallType', 'RecallTypeDescription', 'RecallDescription', 'Description', 'RecallReason', 'Type', 'Reason'), due },
    });
  }
  return propose(unity, 'recall', candidates, { rows: rows.length, matched: candidates.length + unusable, unusable, window: `${mdy(from)} – ${mdy(to)}` }, opts.by || 'system');
}

