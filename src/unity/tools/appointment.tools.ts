import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { UnityService } from '../services/unity.service';
import { UnityErrorHandler, UnityMCPError } from '../utils/error-handler';
import { UnityActions } from '../config/unity-endpoints';
import { unityRows, pick } from '../utils/unity-rows';

/** One open appointment time. */
export interface OpenSlot {
  date: string; // MM/DD/YYYY
  time: string; // "9:15 AM"
  duration: number;
  providerId?: string;
  providerName?: string;
  locationId?: string; // Scheduling_Location_ID
  departmentId?: string; // Scheduling_Department_ID
  /** Appointment types this block allows (GetAppointmentTypes descriptions); absent = no restriction. */
  appointmentTypes?: string[];
  sortKey: number;
  /** Internal: the schedule row's category rule (not returned). */
  rule?: CategoryRule;
}

/** A GetAvailableSchedule row's appointment-category rule (Elig/Inelig_Appointment_Category_ID). */
export interface CategoryRule {
  elig: string[];
  inelig: string[];
}

interface Resource {
  id: string;
  abbreviation: string;
  name: string;
  practitionerId: string;
  defaultTypeId: string;
}

/** A GetAppointmentTypes row. */
export interface AppointmentTypeRow {
  id: string;
  abbreviation: string;
  description: string;
  duration: number;
  categoryId: string;
  categoryAbbreviation: string;
}

/** A GetSchedulingLocations / GetSchedulingDepartments row. */
export interface SchedulingPlace {
  id: string; // Scheduling_Location_ID / Scheduling_Department_ID
  abbreviation: string;
  description: string;
}

/** Where a slot is booked: one GetAvailableSchedule row (location + department). */
export interface SlotPlace {
  locationId: string;
  locationAbbreviation: string;
  departmentId: string;
  departmentAbbreviation: string;
}

/** Resources and appointment types: 10 minutes. Locations, departments, reasons: 1 hour. */
const LOOKUP_TTL_MS = 10 * 60 * 1000;
const REFERENCE_TTL_MS = 60 * 60 * 1000;
type LookupCache = Record<string, { at: number; value: unknown }>;
/** Lookup cache per Unity service instance (one per server; tests get their own). */
const lookupCaches = new WeakMap<object, LookupCache>();

/**
 * Veradigm® PM appointment status codes (SetAppointmentStatus Parameter2, Status in schedule rows).
 * Transitions (Veradigm PM 2019.3+): to Canceled only from Wait Listed, Confirmed, Acknowledged,
 * Canceled, No Show or Bumped (NOT from Scheduled); to Confirmed from Scheduled, Confirmed,
 * Wait Listed or No Show.
 */
export const APPT_STATUS = {
  ACKNOWLEDGED: 'A',
  BUMPED: 'B',
  CONFIRMED: 'C',
  CANCELLED: 'X',
  NO_SHOW: 'N',
  WAIT_LISTED: 'W',
  SCHEDULED: 'S',
} as const;

const STATUS_LABELS: Record<string, string> = {
  S: 'Scheduled',
  C: 'Confirmed',
  A: 'Acknowledged',
  B: 'Bumped',
  W: 'Wait listed',
  X: 'Cancelled',
  N: 'No show',
  K: 'Checked in',
  O: 'Checked out',
  R: 'Rescheduled',
};

function isCancelledStatus(code: string): boolean {
  return /^(x|r|cancell?ed|rescheduled)$/i.test((code || '').trim());
}

/** Schedule-row status ("S", "Scheduled", "Confirmed") → status letter ('' when unknown). */
function statusLetter(v: string): string {
  const s = (v || '').trim();
  if (/^[a-z]$/i.test(s)) return s.toUpperCase();
  const hit = Object.entries(STATUS_LABELS).find(([, label]) => label.toLowerCase() === s.toLowerCase());
  if (hit) return hit[0];
  if (/^cancel/i.test(s)) return 'X';
  return '';
}

/**
 * Veradigm® PM refused a status change because of the transition rules (e.g. Scheduled → Canceled).
 * Permission and token errors are never transition errors.
 */
export function isTransitionRejection(error: string): boolean {
  // "Magic Error - Action: SetAppointmentStatus - ..." names the action; that is not a status hint.
  const e = String(error || '').replace(/SetAppointmentStatus/gi, '');
  if (/security setting|Sched\.|permission|token/i.test(e)) return false;
  return /transition|status|not allowed|cannot be (changed|set|cancell?ed)|invalid.*(change|move)/i.test(e);
}

const CELL_MINUTES = 5;

function defaultSlotMinutes(): number {
  const n = Number(process.env.UNITY_SLOT_MINUTES);
  return n > 0 ? n : 15;
}

/** "3/5/2026" or "03/05/2026" → "03/05/2026"; '' when not M/D/YYYY. */
function mdy(v: string): string {
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}` : '';
}

/** Clinic wall-clock ms for an M/D/YYYY date plus `minutes` (UTC frame, same as clinicNow). */
function mdyTime(v: string, minutes = 0): number {
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) + minutes * 60_000 : NaN;
}

/** The clinic's current wall-clock time as a UTC-framed Date (same frame as mdyTime). */
function clinicNow(): Date {
  const tz = process.env.CLINIC_TIMEZONE || 'America/Boise';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')));
}

/** SetAppointmentStatus Parameter4: the clinic's current time as an integer HHMM ("1130", "905"). */
export function clinicHHMM(now: Date = clinicNow()): string {
  return String(now.getUTCHours() * 100 + now.getUTCMinutes());
}

/** "13:30", "1:30 PM", "9:05am", "0930" → minutes from midnight; NaN when not a clock time. */
export function parseClockTime(v: string): number {
  const s = String(v || '').trim().toUpperCase().replace(/\./g, '');
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(?::\d{2})?\s*(AM|PM|A|P)?$/);
  if (!m) return NaN;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (min > 59) return NaN;
  if (m[3]) {
    if (h < 1 || h > 12) return NaN;
    if (m[3].startsWith('P') && h < 12) h += 12;
    if (m[3].startsWith('A') && h === 12) h = 0;
  } else if (h > 23) {
    return NaN;
  }
  return h * 60 + min;
}

/** Appointment_DateTime "10/13/2026 10:00:00 AM" → clinic wall-clock ms (NaN if missing). */
function apptTime(row: Record<string, any>): number {
  const dt = pick(row, 'Appointment_DateTime', 'AppointmentDateTime');
  const m = dt.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?/i);
  if (!m) return NaN;
  let h = +m[2];
  const ap = (m[4] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return mdyTime(m[1], h * 60 + +m[3]);
}

/** "10/13/2026" → "10/14/2026". */
function nextDay(v: string): string {
  const d = new Date(mdyTime(v) + 86_400_000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function spokenTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${((h + 11) % 12) + 1}:${String(minutes % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "FEELGOOD, MARK M" → "Mark M Feelgood"; "Bailey MD, John" → "John Bailey MD". */
function displayName(raw: string): string {
  const [last, first] = raw.split(',').map((x) => x.trim());
  const cap = (w: string) => (w === w.toUpperCase() && w.length > 2 ? w[0] + w.slice(1).toLowerCase() : w);
  if (!first) return raw.trim();
  return `${first.split(/\s+/).map(cap).join(' ')} ${last.split(/\s+/).map(cap).join(' ')}`.trim();
}

/** Resources matching an ID, abbreviation or name words ("Feelgood", "Dr. Mark Feelgood"). */
function matchResources(resources: Resource[], q: string): Resource[] {
  const t = q.trim().toLowerCase();
  const exact = resources.filter((r) => r.id === q.trim() || r.abbreviation.toLowerCase() === t);
  if (exact.length) return exact;
  const words = t.replace(/\b(dr|doctor|md|do|np|pa)\b\.?/g, ' ').split(/[^a-z]+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  return resources.filter((r) => words.every((w) => r.name.toLowerCase().includes(w)));
}

/** Appointment type by ID, abbreviation or description (exact, then a unique partial description). */
export function matchAppointmentType(types: AppointmentTypeRow[], q: string): AppointmentTypeRow | undefined {
  const t = q.trim().toLowerCase();
  if (!t) return undefined;
  const exact =
    types.find((x) => x.id === q.trim()) ||
    types.find((x) => x.abbreviation.toLowerCase() === t) ||
    types.find((x) => x.description.toLowerCase() === t);
  if (exact) return exact;
  const partial = types.filter((x) => x.description.toLowerCase().includes(t));
  return partial.length === 1 ? partial[0] : undefined;
}

/** Day cells (5-minute) a [startMin, startMin + duration) window covers. */
function cellRange(startMin: number, duration: number): [number, number] {
  return [Math.floor(startMin / CELL_MINUTES), Math.ceil((startMin + duration) / CELL_MINUTES)];
}

const ids = (v: string) => v.split(/[\s,;|]+/).map((x) => x.trim()).filter(Boolean);

/** A row's template marks every cell in [from, to) bookable. */
function rowCovers(row: Record<string, any>, from: number, to: number): boolean {
  const template = pick(row, 'Blocked_Slots1') + pick(row, 'Blocked_Slots2');
  for (let i = from; i < to; i++) if (template[i] !== '1') return false;
  return to > from;
}

/** The row's appointment-category rule: eligible / ineligible category IDs ('' lists = no restriction). */
export function categoryRule(row: Record<string, any> | undefined): CategoryRule {
  return { elig: ids(pick(row, 'Elig_Appointment_Category_ID')), inelig: ids(pick(row, 'Inelig_Appointment_Category_ID')) };
}

const restricted = (rule: CategoryRule | undefined): boolean => !!rule && (rule.elig.length > 0 || rule.inelig.length > 0);

/** Does the rule allow this appointment category? */
export function categoryAllowed(rule: CategoryRule, categoryId: string): boolean {
  if (rule.elig.length && !rule.elig.includes(categoryId)) return false;
  return !rule.inelig.includes(categoryId);
}

/** The appointment types a rule allows; undefined when the row has no restriction (any type). */
export function allowedTypes(rule: CategoryRule | undefined, types: AppointmentTypeRow[]): AppointmentTypeRow[] | undefined {
  if (!restricted(rule)) return undefined;
  return types.filter((t) => t.categoryId && categoryAllowed(rule!, t.categoryId));
}

/**
 * The GetAvailableSchedule rows in which [startMin, startMin + duration) on `date` is open: the row's
 * template marks every cell bookable and no row for the day marks any of them booked.
 */
function rowsForSlot(rows: Record<string, any>[], date: string, startMin: number, duration: number): Record<string, any>[] {
  const day = rows.filter((r) => mdy(pick(r, 'Available_Date', 'AvailableDate')) === mdy(date));
  const [from, to] = cellRange(startMin, duration);
  if (from < 0 || to > 288) return [];
  for (const r of day) {
    const booked = pick(r, 'Booked_Slots1') + pick(r, 'Booked_Slots2');
    for (let i = from; i < to; i++) if (booked[i] === '1') return [];
  }
  return day.filter((r) => rowCovers(r, from, to));
}

function slotPlace(r: Record<string, any>): SlotPlace {
  return {
    locationId: pick(r, 'Scheduling_Location_ID'),
    locationAbbreviation: pick(r, 'Scheduling_Location_Abbreviation'),
    departmentId: pick(r, 'Scheduling_Department_ID'),
    departmentAbbreviation: pick(r, 'Scheduling_Department_Abbreviation'),
  };
}

/**
 * The places (location + department) where [startMin, startMin + duration) on `date` can be booked,
 * from GetAvailableSchedule rows: the row's template marks every cell bookable, no row for the day
 * marks any of them booked, and the row allows the appointment category (Elig/Inelig category IDs).
 */
export function placesForSlot(
  rows: Record<string, any>[],
  date: string,
  startMin: number,
  duration: number,
  categoryId = ''
): SlotPlace[] {
  return rowsForSlot(rows, date, startMin, duration)
    .filter((r) => !categoryId || categoryAllowed(categoryRule(r), categoryId))
    .map(slotPlace);
}

/**
 * Veradigm's SaveAppointment refusal for a type the block does not allow:
 * "Magic Error - Action: SaveAppointment - Appointment type is not valid for this day and time,
 *  requested=ACUTE, available=FOLLOWUP|OV|MEDREC" → { requested: 'ACUTE', available: ['FOLLOWUP', 'OV', 'MEDREC'] }.
 * null for any other error.
 */
export function parseTypeNotAllowed(error: string): { requested: string; available: string[] } | null {
  const e = String(error || '');
  if (!/appointment\s*type\s+is\s+not\s+valid/i.test(e)) return null;
  const requested = (/requested\s*=\s*([^,;|\r\n]*)/i.exec(e)?.[1] || '').trim();
  const available = (/available\s*=\s*([^,;\r\n]*)/i.exec(e)?.[1] || '')
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x && x !== '...' && /^[\w .\-\/&]{1,40}$/.test(x));
  return { requested, available: [...new Set(available)] };
}

/**
 * Abbreviations from Veradigm (type abbreviations, or category abbreviations) → the matching
 * GetAppointmentTypes rows; an unknown abbreviation is kept with itself as the name.
 */
export function typesForAbbreviations(abbrs: string[], types: AppointmentTypeRow[]): Array<{ abbreviation: string; name: string }> {
  const out = new Map<string, { abbreviation: string; name: string }>();
  const norm = (v: string) => v.trim().toLowerCase();
  for (const a of abbrs) {
    const exact = types.find((t) => norm(t.abbreviation) === norm(a));
    const hits = exact ? [exact] : types.filter((t) => norm(t.categoryAbbreviation) === norm(a));
    if (!hits.length) out.set(norm(a), { abbreviation: a, name: a });
    for (const t of hits) out.set(norm(t.abbreviation), { abbreviation: t.abbreviation, name: t.description || t.abbreviation });
  }
  return [...out.values()];
}

/** Most type names in one agent message; the rest are counted. */
const TYPE_NAMES_MAX = 6;

/**
 * The failure the agent acts on when the chosen time does not allow the requested appointment type:
 * nothing was booked, another type is never picked silently, the agent asks the caller and books again.
 */
export function typeNotAllowedError(
  requested: string,
  allowed: Array<{ abbreviation: string; name: string }>,
  source: 'schedule' | 'veradigm'
): UnityMCPError {
  const names = allowed.map((t) => t.name);
  const list = names.slice(0, TYPE_NAMES_MAX).join(', ') + (names.length > TYPE_NAMES_MAX ? `, and ${names.length - TYPE_NAMES_MAX} more` : '');
  const agentText = names.length
    ? `That time does not allow ${requested || 'that visit type'}. That time only allows: ${list}. ` +
      'Ask the caller which one fits their visit, then book again with that appointmentType. If none fits, offer other times.'
    : `That time does not allow ${requested || 'that visit type'}. Offer other times from unity_get_open_slots.`;
  return new UnityMCPError(
    `Appointment type ${requested || '?'} not allowed at that time (${source}); allowed: ${allowed.map((t) => t.abbreviation).join('|') || 'none known'}`,
    'APPOINTMENT_TYPE_NOT_ALLOWED',
    { agentText, allowedTypes: names },
    UnityActions.Scheduling.SAVE_APPOINTMENT
  );
}

/**
 * Turn GetAvailableSchedule day rows into open start times. Rows for the same day (one per
 * department/location) are combined: bookable if any row marks the cell bookable, booked if any
 * row marks it booked. Location and department come from the first row whose template covers the slot
 * (with `categoryId`: the first such row that allows that appointment category; none = slot left out).
 * The row's category rule rides along (`rule`) so the slot can list the appointment types it allows.
 */
function decodeAvailability(rows: Record<string, any>[], r: Resource, duration: number, now: Date, partOfDay?: string, categoryId = ''): OpenSlot[] {
  const days = new Map<string, { open: boolean[]; booked: boolean[]; rows: Record<string, any>[] }>();
  for (const row of rows) {
    const date = mdy(pick(row, 'Available_Date', 'AvailableDate'));
    if (!date) continue;
    const template = (pick(row, 'Blocked_Slots1') + pick(row, 'Blocked_Slots2')).split('');
    const booked = (pick(row, 'Booked_Slots1') + pick(row, 'Booked_Slots2')).split('');
    const d = days.get(date) || { open: [], booked: [], rows: [] };
    template.forEach((c, i) => { if (c === '1') d.open[i] = true; });
    booked.forEach((c, i) => { if (c === '1') d.booked[i] = true; });
    d.rows.push(row);
    days.set(date, d);
  }
  const cells = Math.max(1, Math.round(duration / CELL_MINUTES));
  const earliest = now.getTime() + 30 * 60_000; // never offer a time that has passed or starts within 30 minutes
  const out: OpenSlot[] = [];
  for (const [date, d] of days) {
    for (let i = 0; i + cells <= 288; i += cells) {
      let ok = true;
      for (let j = i; j < i + cells; j++) {
        if (!d.open[j] || d.booked[j]) { ok = false; break; }
      }
      if (!ok) continue;
      const minutes = i * CELL_MINUTES;
      if (partOfDay === 'morning' && minutes >= 12 * 60) continue;
      if (partOfDay === 'afternoon' && minutes < 12 * 60) continue;
      const at = mdyTime(date, minutes);
      if (at <= earliest) continue;
      const fits = (row: Record<string, any>) => !categoryId || categoryAllowed(categoryRule(row), categoryId);
      const place =
        d.rows.find((row) => rowCovers(row, i, i + cells) && fits(row)) ||
        d.rows.find((row) => rowCovers(row, i, i + 1) && fits(row));
      if (categoryId && !place) continue;
      out.push({
        date,
        time: spokenTime(minutes),
        duration,
        providerId: r.id,
        providerName: r.name,
        locationId: pick(place, 'Scheduling_Location_ID') || undefined,
        departmentId: pick(place, 'Scheduling_Department_ID') || undefined,
        sortKey: at,
        rule: place ? categoryRule(place) : undefined,
      });
    }
  }
  return out;
}

/** Keep at most n times per day and provider, spread across the day (first, middle, last...). */
function spreadPerDay(slots: OpenSlot[], n: number): OpenSlot[] {
  const groups = new Map<string, OpenSlot[]>();
  for (const s of slots) {
    const k = `${s.date}|${s.providerId}`;
    groups.set(k, [...(groups.get(k) || []), s]);
  }
  const out: OpenSlot[] = [];
  for (const g of groups.values()) {
    if (g.length <= n) { out.push(...g); continue; }
    const picks = new Set<number>();
    for (let i = 0; i < n; i++) picks.add(Math.round((i * (g.length - 1)) / Math.max(1, n - 1)));
    out.push(...[...picks].map((i) => g[i]));
  }
  return out.sort((a, b) => a.sortKey - b.sortKey);
}

function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The values of a Veradigm® PM SaveAppointment Parameter1 `<appt>` document. */
export interface SaveAppointmentXmlFields {
  appointmentDateTime: string; // "MM/DD/YYYY HH:mm" (24-hour)
  appointmentDuration?: number; // minutes; the only optional value per the spec
  appointmentType: string; // GetAppointmentTypes.Abbreviation
  schedulingLocation: string; // GetSchedulingLocations.Abbreviation
  schedulingDepartment: string; // GetSchedulingDepartments.Abbreviation
  resource: string; // GetResources.Abbreviation
  comments: string;
  referDr?: string; // GetPractitioners.Abbreviation
  coverageType?: string; // GetCoverageTypes.Abbreviation
  visitType?: string;
  referralRequired?: string;
  schedulingLocationId: string;
  schedulingDepartmentId: string;
  ailmentId?: string;
}

/**
 * SaveAppointment Parameter1 in the official layout (developer.veradigm.com, PM SaveAppointment,
 * updated 10/13/2026). The spec lists every element as required except the duration; on the sandbox
 * (Oct 15, 2026, appointments 369721/369722) referDr / coverageType / visitType / referralRequired /
 * ailmentID were not needed, so they are sent only when configured (UNITY_APPT_REFER_DR, UNITY_APPT_COVERAGE_TYPE,
 * UNITY_APPT_VISIT_TYPE, UNITY_APPT_REFERRAL_REQUIRED, UNITY_APPT_AILMENT_ID).
 */
export function buildAppointmentXml(f: SaveAppointmentXmlFields): string {
  const el = (name: string, v: string | number | undefined, always = false) =>
    always || (v !== undefined && v !== null && String(v).trim() !== '') ? `<${name}>${escapeXml(String(v ?? ''))}</${name}>` : '';
  return (
    '<appt>' +
    el('appointmentDateTime', f.appointmentDateTime, true) +
    el('appointmentDuration', f.appointmentDuration) +
    el('appointmentType', f.appointmentType, true) +
    el('schedulingLocation', f.schedulingLocation, true) +
    el('schedulingDepartment', f.schedulingDepartment, true) +
    el('resource', f.resource, true) +
    el('comments', f.comments, true) +
    el('referDr', f.referDr) +
    el('coverageType', f.coverageType) +
    el('visitType', f.visitType) +
    el('referralRequired', f.referralRequired) +
    el('schedulingLocationID', f.schedulingLocationId, true) +
    el('schedulingDepartmentID', f.schedulingDepartmentId, true) +
    el('ailmentID', f.ailmentId) +
    '</appt>'
  );
}

/** saveappointmentinfo → { Appointment_ID, Encounter_Number } ('' when missing). */
export function parseSaveAppointmentResult(data: any): { appointmentId: string; encounterNumber: string } {
  const rows = unityRows(data);
  const row = rows.find((r) => pick(r, 'Appointment_ID', 'AppointmentID')) || rows[0];
  return {
    appointmentId: pick(row, 'Appointment_ID', 'AppointmentID'),
    encounterNumber: pick(row, 'Encounter_Number', 'EncounterNumber'),
  };
}

/** setappointmentstatusinfo.Status: "success", or the error text. */
export function parseStatusResult(data: any): { ok: boolean; status: string } {
  const status = pick(unityRows(data)[0], 'Status');
  return { ok: /^success$/i.test(status), status };
}

/** "MM/DD/YYYY" + minutes → "MM/DD/YYYY HH:mm" (24-hour, Veradigm® PM appointmentDateTime). */
function apptDateTime(date: string, minutes: number): string {
  return `${date} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Appointment Data Structure for Save/Update operations
 */
export interface AppointmentData {
  patientId: string;
  appointmentDate: string; // Format: MM/DD/YYYY
  appointmentTime: string; // "HH:MM" (24-hour) or "9:15 AM"
  duration: number; // Duration in minutes
  providerId?: string; // Resource_ID, abbreviation or name (from unity_get_open_slots)
  locationId?: string; // Scheduling_Location_ID or abbreviation (from unity_get_open_slots)
  departmentId?: string; // Scheduling_Department_ID or abbreviation (from unity_get_open_slots)
  appointmentType?: string; // name, abbreviation or ID (GetAppointmentTypes)
  reasonForVisit?: string;
  notes?: string;
}

/**
 * Appointment Cancellation Data
 */
export interface AppointmentCancelData {
  appointmentId: string;
  patientId: string;
  cancellationReason?: string;
}

/**
 * Parsed Appointment Result
 */
export interface ParsedAppointment {
  id: string;
  patientId: string;
  date: string;
  time: string;
  duration: number;
  status: string;
  providerId?: string;
  providerName?: string;
  locationId?: string;
  locationName?: string;
  appointmentType?: string;
  reasonForVisit?: string;
  notes?: string;
}

/**
 * Unity Appointment Tools
 *
 * Provides MCP tools for appointment operations via Veradigm® PM:
 * - SaveAppointment: book an appointment in an open slot
 * - SetAppointmentStatus: cancel (X) or confirm (C)
 * - GetAvailableSchedule: open slots
 */
export class UnityAppointmentTools {
  constructor(private unityService: UnityService) {}

  /**
   * Book an appointment (SaveAppointment, official `<appt>` layout).
   *
   * 1. Provider → GetResources abbreviation (providerId, else the patient's usual provider, else
   *    the one UNITY_SCHEDULING_RESOURCES entry).
   * 2. Appointment type (name, abbreviation or ID) → GetAppointmentTypes abbreviation; default the
   *    resource's Default_Appointment_Type_ID, then UNITY_DEFAULT_APPOINTMENT_TYPE.
   * 3. GetAvailableSchedule for that day (Veradigm: validate the slot and allowed categories first):
   *    the row that covers the time gives Scheduling_Location_ID / Scheduling_Department_ID, mapped
   *    to abbreviations with GetSchedulingLocations / GetSchedulingDepartments. If the time is open but
   *    its block does not allow the type's category: APPOINTMENT_TYPE_NOT_ALLOWED with the allowed types.
   * 4. SaveAppointment → saveappointmentinfo { Appointment_ID, Encounter_Number }. No ID = failure.
   *    Veradigm's "Appointment type is not valid for this day and time, requested=X, available=A|B" →
   *    APPOINTMENT_TYPE_NOT_ALLOWED with A, B named from GetAppointmentTypes. Another type is never
   *    picked silently: the agent asks the caller and books again.
   * 5. Read back with GetScheduleByPatientID (best effort; a failed read-back never undoes the booking).
   */
  async saveAppointment(args: AppointmentData): Promise<{
    success: boolean;
    appointmentId?: string;
    encounterNumber?: string;
    message: string;
    appointment?: ParsedAppointment;
    verified?: boolean;
  }> {
    const action = UnityActions.Scheduling.SAVE_APPOINTMENT;
    try {
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }
      if (!args.appointmentDate) {
        throw UnityErrorHandler.createValidationError('Appointment date is required');
      }
      if (!args.appointmentTime) {
        throw UnityErrorHandler.createValidationError('Appointment time is required');
      }
      if (!args.duration || Number(args.duration) <= 0) {
        throw UnityErrorHandler.createValidationError('Valid duration is required');
      }
      const patientId = String(args.patientId);
      const date = mdy(args.appointmentDate);
      if (!date) throw UnityErrorHandler.createValidationError('Appointment date must be MM/DD/YYYY');
      const startMin = parseClockTime(args.appointmentTime);
      if (isNaN(startMin)) throw UnityErrorHandler.createValidationError('Appointment time must be HH:MM (24-hour) or like "9:15 AM"');
      if (mdyTime(date, startMin) <= clinicNow().getTime()) {
        throw UnityErrorHandler.createValidationError('That appointment time has already passed');
      }
      const duration = Math.round(Number(args.duration));

      const resource = await this.resolveResource(args.providerId, patientId);
      const type = await this.resolveAppointmentType(args.appointmentType, resource);
      const place = await this.placeForSlot(resource, date, startMin, duration, type, args.locationId, args.departmentId);

      const comments = [args.reasonForVisit, args.notes].map((x) => (x || '').trim()).filter(Boolean).join(' - ') ||
        process.env.UNITY_APPT_DEFAULT_COMMENT || 'Scheduled by phone (Drawbridge)';
      const xml = buildAppointmentXml({
        appointmentDateTime: apptDateTime(date, startMin),
        appointmentDuration: duration,
        appointmentType: type.abbreviation,
        schedulingLocation: place.locationAbbreviation,
        schedulingDepartment: place.departmentAbbreviation,
        resource: resource.abbreviation,
        comments: comments.slice(0, 255),
        referDr: process.env.UNITY_APPT_REFER_DR,
        coverageType: process.env.UNITY_APPT_COVERAGE_TYPE,
        visitType: process.env.UNITY_APPT_VISIT_TYPE,
        referralRequired: process.env.UNITY_APPT_REFERRAL_REQUIRED,
        schedulingLocationId: place.locationId,
        schedulingDepartmentId: place.departmentId,
        ailmentId: process.env.UNITY_APPT_AILMENT_ID,
      });

      console.error(`[Unity Appointment] Saving appointment for patient ${patientId}`);
      const response = await this.unityService.executeAction<any>(action, { Parameter1: xml }, patientId, 'PM');
      if (!response.success) {
        // "Appointment type is not valid for this day and time, requested=ACUTE, available=FOLLOWUP|OV|...":
        // tell the agent which types the time takes (names from GetAppointmentTypes) so it asks the caller.
        const refusal = parseTypeNotAllowed(response.error || '');
        if (refusal) {
          let allowed: Array<{ abbreviation: string; name: string }>;
          try {
            allowed = typesForAbbreviations(refusal.available, await this.appointmentTypes());
          } catch {
            allowed = refusal.available.map((a) => ({ abbreviation: a, name: a }));
          }
          throw typeNotAllowedError(type.description || type.abbreviation, allowed, 'veradigm');
        }
        throw UnityErrorHandler.createAPIError(response.error || 'Failed to save appointment', action);
      }
      const { appointmentId, encounterNumber } = parseSaveAppointmentResult(response.data);
      if (!appointmentId) {
        // Never report a booking Veradigm® PM did not confirm with an appointment ID.
        throw UnityErrorHandler.createAPIError('SaveAppointment returned no Appointment_ID', action);
      }

      let appointment: ParsedAppointment = {
        id: appointmentId,
        patientId,
        date,
        time: spokenTime(startMin),
        duration,
        status: 'Scheduled',
        providerId: resource.id,
        providerName: resource.name,
        locationId: place.locationId,
        appointmentType: type.description || type.abbreviation,
        reasonForVisit: args.reasonForVisit,
        notes: args.notes,
      };
      let verified = false;
      try {
        const row = (await this.patientScheduleRows(patientId)).find((r) => pick(r, 'Appointment_ID', 'AppointmentID') === appointmentId);
        if (row) {
          const [names, types] = await Promise.all([this.resourceNames(), this.appointmentTypeNames()]);
          appointment = { ...appointment, ...this.parseAppointmentRow(row, names, types) };
          verified = true;
        }
      } catch {
        // read-back is a check, not part of the booking
      }

      return {
        success: true,
        appointmentId,
        ...(encounterNumber ? { encounterNumber } : {}),
        message: 'Appointment saved successfully',
        appointment,
        verified,
      };
    } catch (error) {
      if (error instanceof UnityMCPError) throw error;
      throw UnityErrorHandler.handleUnknownError(error, action);
    }
  }

  /**
   * Cancel an appointment: SetAppointmentStatus X with a reason ID (Parameter6).
   *
   * Veradigm® PM does not allow Scheduled → Canceled (only Wait Listed, Confirmed, Acknowledged,
   * Canceled, No Show or Bumped → Canceled). Drawbridge sends X first; if Veradigm refuses it as a
   * status transition and the visit is Scheduled, it confirms (C) and then cancels (X). If the
   * confirm succeeds but the cancel still fails, the result is a failure that says so.
   * Sandbox Oct 15, 2026: X directly from Scheduled succeeded (appointment 369722), so the fallback is
   * for production PM versions that enforce the rule (docs/drawbridge/SCHEDULING_WRITE_TEST_2026-10-15.md).
   */
  async cancelAppointment(args: AppointmentCancelData): Promise<{
    success: boolean;
    message: string;
    appointmentId: string;
    cancellationReason?: string;
    cancellationReasonId?: string;
    confirmedFirst?: boolean;
    alreadyCancelled?: boolean;
  }> {
    const action = UnityActions.Scheduling.CANCEL_APPOINTMENT;
    try {
      if (!args.appointmentId) {
        throw UnityErrorHandler.createValidationError('Appointment ID is required');
      }
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }
      const appointmentId = String(args.appointmentId);
      const patientId = String(args.patientId);

      // SetAppointmentStatus ignores PatientID, so check here that the visit is this patient's.
      const row = await this.ownedAppointment(appointmentId, patientId);
      const current = statusLetter(pick(row, 'Status', 'AppointmentStatus', 'ApptStatus'));
      const reason = await this.resolveCancellationReason(args.cancellationReason);
      const base = {
        appointmentId,
        cancellationReason: reason?.description || args.cancellationReason,
        ...(reason?.id ? { cancellationReasonId: reason.id } : {}),
      };
      if (current === APPT_STATUS.CANCELLED) {
        return { success: true, message: 'Appointment is already cancelled', alreadyCancelled: true, ...base };
      }

      console.error(`[Unity Appointment] Cancelling appointment ${appointmentId}`);
      let result = await this.setStatus(appointmentId, patientId, APPT_STATUS.CANCELLED, { reasonId: reason?.id });
      let confirmedFirst = false;
      if (!result.ok && isTransitionRejection(result.error) && (current === APPT_STATUS.SCHEDULED || current === '')) {
        console.error(`[Unity Appointment] Cancel refused as a status transition; confirming ${appointmentId} first`);
        const confirmed = await this.setStatus(appointmentId, patientId, APPT_STATUS.CONFIRMED, {});
        if (!confirmed.ok) {
          throw UnityErrorHandler.createAPIError(`Cancel refused (${result.error}); confirm-first also failed (${confirmed.error})`, action);
        }
        confirmedFirst = true;
        result = await this.setStatus(appointmentId, patientId, APPT_STATUS.CANCELLED, { reasonId: reason?.id });
        if (!result.ok) {
          throw UnityErrorHandler.createAPIError(`Appointment ${appointmentId} is now Confirmed but the cancel failed (${result.error})`, action);
        }
      }
      if (!result.ok) {
        throw UnityErrorHandler.createAPIError(result.error || 'Failed to cancel appointment', action);
      }

      return { success: true, message: 'Appointment cancelled successfully', ...base, ...(confirmedFirst ? { confirmedFirst } : {}) };
    } catch (error) {
      if (error instanceof UnityMCPError) throw error;
      throw UnityErrorHandler.handleUnknownError(error, action);
    }
  }

  /**
   * Confirm an appointment: SetAppointmentStatus C (allowed from Scheduled, Confirmed, Wait Listed,
   * No Show). Parameter5 = confirmation result ID (GetAppointmentConfirmationResults) when given.
   */
  async confirmAppointment(args: { appointmentId: string; patientId: string; confirmationResult?: string }): Promise<{
    success: boolean;
    message: string;
    appointmentId: string;
    confirmationResult?: string;
    alreadyConfirmed?: boolean;
  }> {
    const action = UnityActions.Scheduling.SET_APPOINTMENT_STATUS;
    try {
      if (!args.appointmentId) {
        throw UnityErrorHandler.createValidationError('Appointment ID is required');
      }
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }
      const appointmentId = String(args.appointmentId);
      const patientId = String(args.patientId);
      const row = await this.ownedAppointment(appointmentId, patientId);
      const current = statusLetter(pick(row, 'Status', 'AppointmentStatus', 'ApptStatus'));
      if (current === APPT_STATUS.CONFIRMED) {
        return { success: true, message: 'Appointment is already confirmed', appointmentId, alreadyConfirmed: true };
      }
      const result = await this.resolveConfirmationResult(args.confirmationResult);
      const r = await this.setStatus(appointmentId, patientId, APPT_STATUS.CONFIRMED, { confirmationResultId: result?.id });
      if (!r.ok) {
        throw UnityErrorHandler.createAPIError(r.error || 'Failed to confirm appointment', action);
      }
      return {
        success: true,
        message: 'Appointment confirmed',
        appointmentId,
        ...(result ? { confirmationResult: result.description } : {}),
      };
    } catch (error) {
      if (error instanceof UnityMCPError) throw error;
      throw UnityErrorHandler.handleUnknownError(error, action);
    }
  }

  /**
   * Open appointment times for one or more providers (GetAvailableSchedule).
   *
   * Veradigm® PM answers per provider (resource abbreviation) and day with two 288-character
   * bitmaps of 5-minute cells from midnight: Blocked_Slots1+2 marks the provider's bookable template
   * time and Booked_Slots1+2 marks booked time. A slot is open when every cell it covers is bookable
   * and not booked. Verified Oct 9 against GetSchedule (FEELGOOD 10/13: 10:00-11:00 booked).
   *
   * Provider: providerId may be a Resource_ID, an abbreviation or part of a name. With none, the
   * patient's usual provider (latest appointment) is used, then UNITY_SCHEDULING_RESOURCES.
   */
  async getOpenSlots(args: {
    providerId?: string;
    locationId?: string;
    startDate: string;
    endDate: string;
    appointmentType?: string;
    duration?: number;
    patientId?: string;
    partOfDay?: string;
    maxPerDay?: number | string;
  }): Promise<{
    slots: Omit<OpenSlot, 'sortKey' | 'rule'>[];
    total: number;
    providers: string[];
  }> {
    try {
      if (!args.startDate || !args.endDate) {
        throw UnityErrorHandler.createValidationError('Start date and end date are required');
      }
      const start = mdy(args.startDate);
      const end = mdy(args.endDate);
      if (!start || !end) {
        throw UnityErrorHandler.createValidationError('Dates must be MM/DD/YYYY');
      }

      const resources = await this.resources();
      let chosen: Resource[] = [];
      if (args.providerId) {
        chosen = matchResources(resources, String(args.providerId));
        if (chosen.length === 0) {
          throw UnityErrorHandler.createValidationError(`No provider matches "${args.providerId}". Use unity_get_providers.`);
        }
      } else if (args.patientId) {
        const usual = await this.usualResourceId(String(args.patientId));
        chosen = resources.filter((r) => r.id === usual);
      }
      if (chosen.length === 0) {
        chosen = this.configuredResources(resources).slice(0, 10);
      }
      if (chosen.length === 0 && !args.patientId) {
        // No provider named and none configured: everyone who sees patients (first 10).
        chosen = resources.filter((r) => r.practitionerId).slice(0, 10);
      }
      if (chosen.length === 0) {
        throw UnityErrorHandler.createValidationError('Which provider? Pass providerId (see unity_get_providers).');
      }

      const duration = Number(args.duration) > 0 ? Math.max(5, Math.round(Number(args.duration) / 5) * 5) : defaultSlotMinutes();
      const maxPerDay = args.maxPerDay === undefined || args.maxPerDay === '' ? 3 : Number(args.maxPerDay) || 0;
      const now = clinicNow();

      console.error(`[Unity Appointment] Open slots ${start}-${end} for ${chosen.map((r) => r.abbreviation).join(',')}`);

      // Appointment types: only looked up when needed (a type filter, or a block that restricts categories).
      // A failed lookup never hides open times; the slots then carry no type list and booking still validates.
      let types: AppointmentTypeRow[] | null = null;
      const loadTypes = async () => {
        if (types === null) {
          try {
            types = await this.appointmentTypes();
          } catch {
            types = [];
          }
        }
        return types;
      };
      const wanted = args.appointmentType && String(args.appointmentType).trim()
        ? matchAppointmentType(await loadTypes(), String(args.appointmentType))
        : undefined;

      const perProvider = await Promise.all(
        chosen.map(async (r) => {
          const lastDay = mdyTime(end);
          const rows = (await this.availabilityRows(r, start, end)).filter((row) => mdyTime(pick(row, 'Available_Date', 'AvailableDate')) <= lastDay);
          return decodeAvailability(rows, r, duration, now, args.partOfDay, wanted?.categoryId || '');
        })
      );

      let slots = perProvider.flat().sort((a, b) => a.sortKey - b.sortKey);
      if (args.locationId) slots = slots.filter((x) => !x.locationId || x.locationId === String(args.locationId));
      if (maxPerDay > 0) slots = spreadPerDay(slots, maxPerDay);
      if (slots.some((s) => restricted(s.rule))) {
        const all = await loadTypes();
        for (const s of slots) {
          const allowed = all.length ? allowedTypes(s.rule, all) : undefined;
          if (allowed?.length) s.appointmentTypes = [...new Set(allowed.map((t) => t.description || t.abbreviation))];
        }
      }

      return {
        slots: slots.map(({ sortKey: _sortKey, rule: _rule, ...rest }) => rest),
        total: slots.length,
        providers: chosen.map((r) => r.name),
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, UnityActions.Scheduling.GET_OPEN_SLOTS);
    }
  }

  /**
   * A patient's appointments (GetScheduleByPatientID): upcoming, not cancelled, soonest first.
   * Pass startDate/endDate for another range, or status "all" to include cancelled visits.
   */
  async getPatientAppointments(args: {
    patientId: string;
    startDate?: string;
    endDate?: string;
    status?: string;
  }): Promise<{
    appointments: ParsedAppointment[];
    total: number;
  }> {
    try {
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }

      console.error(`[Unity Appointment] Getting appointments for patient ${args.patientId}`);

      const rows = await this.patientScheduleRows(String(args.patientId));
      const from = args.startDate ? mdyTime(args.startDate) : clinicNow().getTime();
      const to = args.endDate ? mdyTime(args.endDate) + 86_400_000 : Infinity;
      const includeCancelled = /^(all|any)$/i.test(args.status || '');

      const [names, types] = await Promise.all([this.resourceNames(), this.appointmentTypeNames()]);
      const appointments = rows
        .filter((row) => {
          const pid = pick(row, 'Patient_ID', 'PatientID');
          return !pid || pid === String(args.patientId);
        })
        .map((row) => ({ row, at: apptTime(row) }))
        .filter(({ at }) => !isNaN(at) && at >= from && at < to)
        .filter(({ row }) => includeCancelled || !isCancelledStatus(pick(row, 'Status')))
        .sort((a, b) => a.at - b.at)
        .map(({ row }) => this.parseAppointmentRow(row, names, types));

      return {
        appointments,
        total: appointments.length
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, UnityActions.Scheduling.GET_APPOINTMENTS);
    }
  }

  /**
   * Valid cancellation reasons (GetAppointmentCancellationReasons).
   * cancel_appointment must use one of these (spec §4 rule 4).
   */
  async getCancellationReasons(): Promise<{
    success: true;
    reasons: Array<{ id: string; description: string; abbreviation?: string }>;
    total: number;
  }> {
    const reasons = await this.cancellationReasons();
    return { success: true, reasons, total: reasons.length };
  }

  /**
   * Appointment type codes (GetAppointmentTypes).
   */
  async getAppointmentTypes(): Promise<{
    success: true;
    appointmentTypes: Array<{ id: string; abbreviation?: string; description: string; duration?: number }>;
    total: number;
  }> {
    const rows = await this.lookupList(UnityActions.Scheduling.GET_APPOINTMENT_TYPES);
    const appointmentTypes = rows
      .map(r => ({
        id: pick(r, 'Appointment_Type_ID', 'ID', 'AppointmentTypeID', 'ApptTypeID', 'Code', 'Abbreviation'),
        abbreviation: pick(r, 'Abbreviation') || undefined,
        description: pick(r, 'Description', 'AppointmentType', 'Name', 'DisplayName'),
        duration: parseInt(pick(r, 'Duration', 'DefaultDuration')) || undefined
      }))
      .filter(t => t.id || t.description);
    return { success: true, appointmentTypes, total: appointmentTypes.length };
  }

  /**
   * Details for one appointment. With a patient ID this reads the patient's own schedule
   * (GetScheduleByPatientID, verified), so another patient's visit can never come back.
   */
  async getAppointmentDetails(args: { appointmentId: string; patientId?: string }): Promise<{
    success: boolean;
    appointment?: ParsedAppointment;
    message: string;
  }> {
    try {
      if (!args.appointmentId) {
        throw UnityErrorHandler.createValidationError('Appointment ID is required');
      }
      if (args.patientId) {
        const rows = await this.patientScheduleRows(String(args.patientId));
        const row = rows.find((r) => pick(r, 'Appointment_ID', 'AppointmentID') === String(args.appointmentId));
        if (!row) {
          return { success: false, message: "That appointment is not on this patient's schedule." };
        }
        const [names, types] = await Promise.all([this.resourceNames(), this.appointmentTypeNames()]);
        return { success: true, appointment: this.parseAppointmentRow(row, names, types), message: 'Appointment retrieved' };
      }
      const response = await this.unityService.executeAction<any>(
        UnityActions.Scheduling.GET_APPOINTMENT_BY_ID,
        { Parameter1: args.appointmentId },
        '',
        'PM'
      );
      if (!response.success) {
        throw UnityErrorHandler.createAPIError(
          response.error || 'Failed to get appointment',
          UnityActions.Scheduling.GET_APPOINTMENT_BY_ID
        );
      }
      const rows = unityRows(response.data);
      if (rows.length === 0) {
        return { success: false, message: 'No appointment found with that ID.' };
      }
      const appointment = this.parseAppointmentRow(rows[0]);
      if (!appointment.id) appointment.id = args.appointmentId;
      return { success: true, appointment, message: 'Appointment retrieved' };
    } catch (error) {
      if (error instanceof UnityMCPError) throw error;
      throw UnityErrorHandler.handleUnknownError(error, UnityActions.Scheduling.GET_APPOINTMENT_BY_ID);
    }
  }

  // ============================================
  // SetAppointmentStatus
  // ============================================

  /**
   * One SetAppointmentStatus call (Veradigm® PM spec): Parameter1 appointment ID, Parameter2 status
   * letter, Parameter3 update date (optional, left blank = today), Parameter4 update time HHMM in the
   * clinic's time zone (required), Parameter5 confirmation result ID, Parameter6 cancel/bump reason ID.
   * PatientID is unused by Veradigm; it is sent for the audit trail. Never throws for a Veradigm refusal.
   */
  private async setStatus(
    appointmentId: string,
    patientId: string,
    status: string,
    opts: { confirmationResultId?: string; reasonId?: string }
  ): Promise<{ ok: boolean; error: string }> {
    const response = await this.unityService.executeAction<any>(
      UnityActions.Scheduling.SET_APPOINTMENT_STATUS,
      {
        Parameter1: appointmentId,
        Parameter2: status,
        Parameter3: '',
        Parameter4: clinicHHMM(),
        Parameter5: opts.confirmationResultId || '',
        Parameter6: opts.reasonId || '',
      },
      patientId,
      'PM'
    );
    if (!response.success) return { ok: false, error: String(response.error || 'SetAppointmentStatus failed') };
    const r = parseStatusResult(response.data);
    // "success" or Veradigm's error text; anything else (including no status) is a failure.
    return r.ok ? { ok: true, error: '' } : { ok: false, error: r.status || 'empty reply from SetAppointmentStatus' };
  }

  /** The patient's schedule row for an appointment; NOT_FOUND when it is not theirs. */
  private async ownedAppointment(appointmentId: string, patientId: string): Promise<Record<string, any>> {
    const row = (await this.patientScheduleRows(patientId)).find((r) => {
      const pid = pick(r, 'Patient_ID', 'PatientID');
      return pick(r, 'Appointment_ID', 'AppointmentID') === appointmentId && (!pid || pid === patientId);
    });
    if (!row) {
      throw UnityErrorHandler.createNotFoundError("That appointment is not on this patient's schedule.");
    }
    return row;
  }

  // ============================================
  // Lookups (cached)
  // ============================================

  private get lookupCache(): LookupCache {
    let c = lookupCaches.get(this.unityService);
    if (!c) lookupCaches.set(this.unityService, (c = {}));
    return c;
  }

  /** A cached lookup; failures are not cached and propagate. */
  private async cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = this.lookupCache[key];
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
    const value = await load();
    this.lookupCache[key] = { at: Date.now(), value };
    return value;
  }

  /** Run a parameterless PM lookup action and return its rows; failures throw. */
  private async lookupList(action: string): Promise<Record<string, any>[]> {
    try {
      const response = await this.unityService.executeAction<any>(action, {}, '', 'PM');
      if (!response.success) {
        throw UnityErrorHandler.createAPIError(response.error || `${action} failed`, action);
      }
      return unityRows(response.data);
    } catch (error) {
      if (error instanceof UnityMCPError) throw error;
      throw UnityErrorHandler.handleUnknownError(error, action);
    }
  }

  /** All of a patient's PM appointment rows (GetScheduleByPatientID); failures throw. */
  private async patientScheduleRows(patientId: string): Promise<Record<string, any>[]> {
    const response = await this.unityService.executeAction<any>(
      UnityActions.Scheduling.GET_APPOINTMENTS,
      {},
      patientId,
      'PM'
    );
    // A failed call is an error, never "no appointments" (CLAUDE.md rule 5).
    if (!response.success) {
      throw UnityErrorHandler.createAPIError(
        response.error || 'Failed to get appointments',
        UnityActions.Scheduling.GET_APPOINTMENTS
      );
    }
    return unityRows(response.data);
  }

  /** GetAvailableSchedule rows for one resource, start..end inclusive; failures throw. */
  private async availabilityRows(r: Resource, start: string, end: string): Promise<Record<string, any>[]> {
    const response = await this.unityService.executeAction<any>(
      UnityActions.Scheduling.GET_OPEN_SLOTS,
      // The end date is exclusive in Veradigm® PM (10/13-10/13 returns nothing): ask for one more day.
      { Parameter1: r.abbreviation, Parameter2: start, Parameter3: nextDay(end) },
      '',
      'PM'
    );
    // A failed call is an error, never "no openings" (CLAUDE.md rule 5).
    if (!response.success) {
      throw UnityErrorHandler.createAPIError(response.error || 'Failed to get open slots', UnityActions.Scheduling.GET_OPEN_SLOTS);
    }
    return unityRows(response.data);
  }

  /** Scheduling resources (GetResources), cached for 10 minutes. */
  private async resources(): Promise<Resource[]> {
    return this.cached('resources', LOOKUP_TTL_MS, async () =>
      (await this.lookupList(UnityActions.Scheduling.GET_RESOURCES))
        .map((r) => ({
          id: pick(r, 'Resource_ID', 'ResourceID', 'ID'),
          abbreviation: pick(r, 'Abbreviation', 'Resource_Abbreviation'),
          name: displayName(pick(r, 'Description', 'Name', 'ResourceName')),
          practitionerId: pick(r, 'Practitioner_ID', 'PractitionerID'),
          defaultTypeId: pick(r, 'Default_Appointment_Type_ID'),
        }))
        .filter((r) => r.id && r.abbreviation && !/\*\*\*inactive\*\*\*/i.test(r.name))
    );
  }

  private configuredResources(resources: Resource[]): Resource[] {
    const configured = (process.env.UNITY_SCHEDULING_RESOURCES || '').split(',').map((x) => x.trim()).filter(Boolean);
    return configured.flatMap((c) => matchResources(resources, c));
  }

  private async resourceNames(): Promise<Map<string, string>> {
    try {
      return new Map((await this.resources()).map((r) => [r.id, r.name] as [string, string]));
    } catch {
      return new Map(); // names are a nicety; the appointment list still answers
    }
  }

  /** Appointment types (GetAppointmentTypes), cached for 10 minutes; failures throw. */
  private async appointmentTypes(): Promise<AppointmentTypeRow[]> {
    return this.cached('types', LOOKUP_TTL_MS, async () =>
      (await this.lookupList(UnityActions.Scheduling.GET_APPOINTMENT_TYPES))
        .map((r) => ({
          id: pick(r, 'Appointment_Type_ID', 'AppointmentTypeID', 'ID'),
          abbreviation: pick(r, 'Abbreviation'),
          description: pick(r, 'Description'),
          duration: parseInt(pick(r, 'Duration', 'DefaultDuration')) || 0,
          categoryId: pick(r, 'Appointment_Category_ID'),
          categoryAbbreviation: pick(r, 'Appt_Category_Abbreviation'),
        }))
        .filter((t) => t.id || t.abbreviation)
    );
  }

  /** Appointment type ID → description; empty on failure. */
  private async appointmentTypeNames(): Promise<Map<string, string>> {
    try {
      return new Map((await this.appointmentTypes()).map((t) => [t.id, t.description || t.abbreviation] as [string, string]));
    } catch {
      return new Map();
    }
  }

  /** Scheduling locations (GetSchedulingLocations), cached for 1 hour; failures throw. */
  private async schedulingLocations(): Promise<SchedulingPlace[]> {
    return this.cached('locations', REFERENCE_TTL_MS, async () =>
      (await this.lookupList(UnityActions.Scheduling.GET_SCHEDULING_LOCATIONS))
        .map((r) => ({
          id: pick(r, 'Scheduling_Location_ID', 'SchedulingLocationID', 'ID'),
          abbreviation: pick(r, 'Abbreviation', 'Location_Abbreviation'),
          description: pick(r, 'Description', 'Location_Name'),
        }))
        .filter((x) => x.id && x.abbreviation)
    );
  }

  /** Scheduling departments (GetSchedulingDepartments), cached for 1 hour; failures throw. */
  private async schedulingDepartments(): Promise<SchedulingPlace[]> {
    return this.cached('departments', REFERENCE_TTL_MS, async () =>
      (await this.lookupList(UnityActions.Scheduling.GET_SCHEDULING_DEPARTMENTS))
        .map((r) => ({
          id: pick(r, 'Scheduling_Department_ID', 'SchedulingDepartmentID', 'ID'),
          abbreviation: pick(r, 'Abbreviation'),
          description: pick(r, 'Description'),
        }))
        .filter((x) => x.id && x.abbreviation)
    );
  }

  /** Cancellation reasons (GetAppointmentCancellationReasons), cached for 1 hour; failures throw. */
  private async cancellationReasons(): Promise<Array<{ id: string; description: string; abbreviation?: string }>> {
    return this.cached('cancelReasons', REFERENCE_TTL_MS, async () =>
      (await this.lookupList(UnityActions.Scheduling.GET_CANCELLATION_REASONS))
        .map((r) => ({
          id: pick(r, 'Cancellation_Reason_ID', 'ID', 'ReasonID', 'CancelReasonID', 'Code', 'Value'),
          description: pick(r, 'Description', 'Reason', 'CancelReason', 'Name', 'DisplayName', 'Entry'),
          abbreviation: pick(r, 'Abbreviation') || undefined,
        }))
        .filter((r) => r.id || r.description)
    );
  }

  /** Confirmation results (GetAppointmentConfirmationResults), cached for 1 hour; failures throw. */
  private async confirmationResults(): Promise<Array<{ id: string; description: string }>> {
    return this.cached('confirmResults', REFERENCE_TTL_MS, async () =>
      (await this.lookupList(UnityActions.Scheduling.GET_CONFIRMATION_RESULTS))
        .map((r) => ({
          id: pick(r, 'Appt_Confirmation_Result_ID', 'ID'),
          description: pick(r, 'Short_Description', 'Description', 'Long_Description'),
        }))
        .filter((r) => r.id)
    );
  }

  /**
   * Cancellation reason (ID, abbreviation or description; then a unique partial description) → its ID.
   * Unknown or missing: UNITY_DEFAULT_CANCEL_REASON (same matching), then the "Patient Cancelled"
   * style reason, else none (Parameter6 is optional).
   */
  private async resolveCancellationReason(input?: string): Promise<{ id: string; description: string } | undefined> {
    const reasons = (await this.cancellationReasons()).filter((r) => r.id);
    const find = (q?: string) => {
      const t = (q || '').trim().toLowerCase();
      if (!t) return undefined;
      const exact = reasons.find(
        (r) => r.id === t || (r.abbreviation || '').toLowerCase() === t || r.description.toLowerCase() === t
      );
      if (exact) return exact;
      const partial = reasons.filter((r) => r.description.toLowerCase().includes(t) || t.includes(r.description.toLowerCase()));
      return partial.length === 1 ? partial[0] : undefined;
    };
    const hit = find(input) || find(process.env.UNITY_DEFAULT_CANCEL_REASON) || reasons.find((r) => /patient/i.test(r.description) && /cancel/i.test(r.description));
    return hit ? { id: hit.id, description: hit.description } : undefined;
  }

  /** Confirmation result (ID or description) → its ID; none when not given or not found. */
  private async resolveConfirmationResult(input?: string): Promise<{ id: string; description: string } | undefined> {
    const t = (input || '').trim().toLowerCase();
    if (!t) return undefined;
    const results = await this.confirmationResults();
    const exact = results.find((r) => r.id === t || r.description.toLowerCase() === t);
    if (exact) return exact;
    const partial = results.filter((r) => r.description.toLowerCase().includes(t));
    return partial.length === 1 ? partial[0] : undefined;
  }

  /** The resource to book: providerId, else the patient's usual provider, else the single configured one. */
  private async resolveResource(providerId: string | undefined, patientId: string): Promise<Resource> {
    const resources = await this.resources();
    if (providerId) {
      const matches = matchResources(resources, String(providerId));
      if (matches.length === 1) return matches[0];
      if (matches.length === 0) {
        throw UnityErrorHandler.createValidationError(`No provider matches "${providerId}". Use unity_get_providers.`);
      }
      throw UnityErrorHandler.createValidationError(`More than one provider matches "${providerId}". Pass the providerId from unity_get_open_slots.`);
    }
    const usual = await this.usualResourceId(patientId);
    const byUsual = resources.find((r) => r.id === usual);
    if (byUsual) return byUsual;
    const configured = this.configuredResources(resources);
    if (configured.length === 1) return configured[0];
    throw UnityErrorHandler.createValidationError('Which provider? Pass the providerId from unity_get_open_slots.');
  }

  /** Appointment type by name/abbreviation/ID; default: the resource's default type, then UNITY_DEFAULT_APPOINTMENT_TYPE. */
  private async resolveAppointmentType(input: string | undefined, resource: Resource): Promise<AppointmentTypeRow> {
    const types = await this.appointmentTypes();
    if (input && String(input).trim()) {
      const hit = matchAppointmentType(types, String(input));
      if (!hit) {
        throw UnityErrorHandler.createValidationError(`Unknown appointment type "${input}". Use unity_get_appointment_types.`);
      }
      return hit;
    }
    const fallback =
      (process.env.UNITY_DEFAULT_APPOINTMENT_TYPE && matchAppointmentType(types, process.env.UNITY_DEFAULT_APPOINTMENT_TYPE)) ||
      (resource.defaultTypeId && types.find((t) => t.id === resource.defaultTypeId));
    if (!fallback) {
      throw UnityErrorHandler.createValidationError('Appointment type is required (see unity_get_appointment_types).');
    }
    return fallback;
  }

  /**
   * Check the requested time against GetAvailableSchedule and return where it is booked (location and
   * department IDs + abbreviations). An explicit locationId / departmentId (ID or abbreviation) must
   * match; otherwise UNITY_DEFAULT_SCHEDULING_DEPARTMENT is preferred, then Veradigm's row order.
   */
  private async placeForSlot(
    resource: Resource,
    date: string,
    startMin: number,
    duration: number,
    type: AppointmentTypeRow,
    locationHint?: string,
    departmentHint?: string
  ): Promise<SlotPlace> {
    const rows = await this.availabilityRows(resource, date, date);
    const is = (hint: string, id: string, abbr: string) =>
      hint.trim() === id || hint.trim().toLowerCase() === abbr.trim().toLowerCase();
    let places = placesForSlot(rows, date, startMin, duration, type.categoryId);
    if (places.length === 0) {
      // Open, but not for this appointment type (the block's eligible categories): say which types it takes,
      // never book another type silently.
      const open = rowsForSlot(rows, date, startMin, duration).filter((r) => {
        const p = slotPlace(r);
        return (!locationHint || is(String(locationHint), p.locationId, p.locationAbbreviation)) &&
          (!departmentHint || is(String(departmentHint), p.departmentId, p.departmentAbbreviation));
      });
      if (open.length) {
        const types = await this.appointmentTypes();
        const allowed = new Map<string, { abbreviation: string; name: string }>();
        for (const r of open) {
          for (const t of allowedTypes(categoryRule(r), types) || []) allowed.set(t.abbreviation, { abbreviation: t.abbreviation, name: t.description || t.abbreviation });
        }
        throw typeNotAllowedError(type.description || type.abbreviation, [...allowed.values()], 'schedule');
      }
      throw UnityErrorHandler.createValidationError(
        `${spokenTime(startMin)} on ${date} is not open for ${resource.name} (${type.abbreviation}). Offer a time from unity_get_open_slots.`
      );
    }
    if (locationHint && String(locationHint).trim()) {
      places = places.filter((p) => is(String(locationHint), p.locationId, p.locationAbbreviation));
      if (!places.length) throw UnityErrorHandler.createValidationError(`That time is not open at location ${locationHint}.`);
    }
    if (departmentHint && String(departmentHint).trim()) {
      places = places.filter((p) => is(String(departmentHint), p.departmentId, p.departmentAbbreviation));
      if (!places.length) throw UnityErrorHandler.createValidationError(`That time is not open in department ${departmentHint}.`);
    }
    const preferred = process.env.UNITY_DEFAULT_SCHEDULING_DEPARTMENT;
    const place = (preferred && places.find((p) => is(preferred, p.departmentId, p.departmentAbbreviation))) || places[0];

    // IDs come from the schedule row; abbreviations from the 1-hour lookups (row abbreviation as fallback).
    const abbrFor = async (load: () => Promise<SchedulingPlace[]>, id: string, rowAbbr: string, what: string) => {
      try {
        const hit = (await load()).find((x) => x.id === id);
        if (hit) return hit.abbreviation;
      } catch (e) {
        if (!rowAbbr) throw e;
      }
      if (rowAbbr) return rowAbbr;
      throw UnityErrorHandler.createAPIError(`No abbreviation for scheduling ${what} ${id}`, UnityActions.Scheduling.SAVE_APPOINTMENT);
    };
    if (!place.locationId || !place.departmentId) {
      throw UnityErrorHandler.createAPIError('GetAvailableSchedule row has no scheduling location/department', UnityActions.Scheduling.GET_OPEN_SLOTS);
    }
    return {
      locationId: place.locationId,
      departmentId: place.departmentId,
      locationAbbreviation: await abbrFor(() => this.schedulingLocations(), place.locationId, place.locationAbbreviation, 'location'),
      departmentAbbreviation: await abbrFor(() => this.schedulingDepartments(), place.departmentId, place.departmentAbbreviation, 'department'),
    };
  }

  /** Resource of the patient's most recent non-cancelled appointment ('' when none). */
  private async usualResourceId(patientId: string): Promise<string> {
    try {
      const horizon = clinicNow().getTime() + 90 * 86_400_000;
      const rows = (await this.patientScheduleRows(patientId))
        .filter((r) => !isCancelledStatus(pick(r, 'Status')))
        .map((r) => ({ r, at: apptTime(r) }))
        .filter(({ at }) => !isNaN(at) && at <= horizon)
        .sort((a, b) => b.at - a.at);
      return rows.length ? pick(rows[0].r, 'Resource_ID', 'ResourceID') : '';
    } catch {
      return '';
    }
  }

  /** One Unity appointment row → ParsedAppointment (field names vary by action/product). */
  private parseAppointmentRow(
    item: Record<string, any>,
    resourceNames: Map<string, string> = new Map(),
    typeNames: Map<string, string> = new Map()
  ): ParsedAppointment {
    // GetScheduleByPatientID: Appointment_DateTime "10/13/2026 10:00:00 AM"
    const dt = pick(item, 'Appointment_DateTime', 'AppointmentDateTime');
    const dtMatch = dt.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?/i);
    const resourceId = pick(item, 'Resource_ID', 'ResourceID', 'ProviderID');
    const typeId = pick(item, 'Appointment_Type_ID', 'AppointmentTypeID');
    const status = pick(item, 'Status', 'AppointmentStatus', 'ApptStatus');
    return {
      id: pick(item, 'Appointment_ID', 'AppointmentID', 'ApptID', 'ID'),
      patientId: pick(item, 'Patient_ID', 'PatientID'),
      date: dtMatch ? mdy(dtMatch[1]) || dtMatch[1] : pick(item, 'AppointmentDate', 'ApptDate', 'Date', 'StartDate'),
      time: dtMatch
        ? `${+dtMatch[2]}:${dtMatch[3]}${dtMatch[4] ? ' ' + dtMatch[4].toUpperCase() : ''}`
        : pick(item, 'AppointmentTime', 'ApptTime', 'Time', 'StartTime'),
      duration: parseInt(pick(item, 'Duration', 'ApptDuration')) || 0,
      status: STATUS_LABELS[status.toUpperCase()] || status,
      providerId: resourceId || undefined,
      providerName:
        resourceNames.get(resourceId) || pick(item, 'Practitioner_Name', 'ProviderName', 'ResourceName', 'Provider') || undefined,
      locationId: pick(item, 'Scheduling_Location_ID', 'LocationID', 'LocationId') || undefined,
      locationName: pick(item, 'LocationName', 'Location') || undefined,
      appointmentType:
        typeNames.get(typeId) || pick(item, 'AppointmentType', 'ApptType', 'appttype', 'AppointmentTypeDescription') || undefined,
      reasonForVisit: pick(item, 'ReasonForVisit', 'Reason', 'Comment') || undefined,
      notes: pick(item, 'Notes') || undefined
    };
  }

  /**
   * Get MCP tool definitions for appointment operations
   */
  getTools(): Tool[] {
    return [
      {
        name: 'unity_save_appointment',
        description:
          'Book an appointment in Veradigm Practice Management in an open time from unity_get_open_slots. ' +
          'Read back the date, time and provider and get a clear yes first. Pass providerId, locationId and departmentId from the chosen slot.',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: {
              type: 'string',
              description: 'Patient ID in the Veradigm system'
            },
            appointmentDate: {
              type: 'string',
              description: 'Appointment date in MM/DD/YYYY format'
            },
            appointmentTime: {
              type: 'string',
              description: 'Appointment time: HH:MM (24-hour) or the slot time, e.g. "9:15 AM"'
            },
            duration: {
              type: 'number',
              description: 'Appointment duration in minutes'
            },
            providerId: {
              type: 'string',
              description: "Provider (resource) ID from unity_get_open_slots (optional; default: the patient's usual provider)"
            },
            locationId: {
              type: 'string',
              description: 'Scheduling location ID from unity_get_open_slots (optional)'
            },
            departmentId: {
              type: 'string',
              description: 'Scheduling department ID from unity_get_open_slots (optional)'
            },
            appointmentType: {
              type: 'string',
              description: 'Appointment type name or code (e.g. "Office Visit"): one the chosen slot allows (its appointmentTypes from unity_get_open_slots). Optional, default the provider\'s usual type. If the time does not allow it, nothing is booked and the allowed types come back.'
            },
            reasonForVisit: {
              type: 'string',
              description: 'Reason for the appointment'
            },
            notes: {
              type: 'string',
              description: 'Additional notes for the appointment'
            }
          },
          required: ['patientId', 'appointmentDate', 'appointmentTime', 'duration']
        }
      },
      {
        name: 'unity_cancel_appointment',
        description: 'Cancel an existing appointment in Veradigm Practice Management via Unity API',
        inputSchema: {
          type: 'object',
          properties: {
            appointmentId: {
              type: 'string',
              description: 'The appointment ID to cancel'
            },
            patientId: {
              type: 'string',
              description: 'Patient ID associated with the appointment'
            },
            cancellationReason: {
              type: 'string',
              description: 'Cancellation reason from unity_get_cancellation_reasons that matches what the caller said'
            }
          },
          required: ['appointmentId', 'patientId']
        }
      },
      {
        name: 'unity_get_open_slots',
        description:
          "Find open appointment times in Veradigm Practice Management for one provider (or the patient's usual provider when patientId is given). " +
          'Returns up to maxPerDay times per day (default 3), soonest first. A time whose block takes only some visit types lists them (appointmentTypes).',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: {
              type: 'string',
              description: 'Start date for slot search in MM/DD/YYYY format'
            },
            endDate: {
              type: 'string',
              description: 'End date for slot search in MM/DD/YYYY format'
            },
            providerId: {
              type: 'string',
              description: 'Provider: resource ID, abbreviation or last name (optional)'
            },
            patientId: {
              type: 'string',
              description: "Verified patientId; with no providerId, searches the patient's usual provider (optional)"
            },
            partOfDay: {
              type: 'string',
              enum: ['morning', 'afternoon', 'any'],
              description: 'morning = before 12:00, afternoon = 12:00 and later (optional)'
            },
            maxPerDay: {
              type: 'number',
              description: 'Most times to return per day; 0 = all (optional, default 3)'
            },
            locationId: {
              type: 'string',
              description: 'Filter by location ID (optional)'
            },
            appointmentType: {
              type: 'string',
              description: 'Only times whose block allows this appointment type (name or code; optional)'
            },
            duration: {
              type: 'number',
              description: 'Required slot duration in minutes (optional)'
            }
          },
          required: ['startDate', 'endDate']
        }
      },
      {
        name: 'unity_get_patient_appointments',
        description: 'Upcoming appointments for a verified patient from Veradigm Practice Management, soonest first (cancelled visits left out).',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: {
              type: 'string',
              description: 'Patient ID to get appointments for'
            },
            startDate: {
              type: 'string',
              description: 'Start date filter in MM/DD/YYYY format (optional)'
            },
            endDate: {
              type: 'string',
              description: 'End date filter in MM/DD/YYYY format (optional)'
            },
            status: {
              type: 'string',
              description: 'Pass "all" to include cancelled visits (optional)'
            }
          },
          required: ['patientId']
        }
      },
      {
        name: 'unity_get_cancellation_reasons',
        description: 'List valid appointment cancellation reasons in Veradigm Practice Management. Call before unity_cancel_appointment and pass the matching reason.',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'unity_get_appointment_types',
        description: 'List appointment type codes in Veradigm Practice Management',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'unity_get_appointment_details',
        description: 'Get details for one appointment by ID from Veradigm Practice Management',
        inputSchema: {
          type: 'object',
          properties: {
            appointmentId: { type: 'string', description: 'Appointment ID' },
            patientId: { type: 'string', description: 'Verified patient ID (the appointment must belong to this patient)' }
          },
          required: ['appointmentId']
        }
      },
      {
        name: 'unity_confirm_appointment',
        description: 'Confirm an existing appointment in Veradigm Practice Management. Read back the appointment and get a clear yes first.',
        inputSchema: {
          type: 'object',
          properties: {
            appointmentId: { type: 'string', description: 'Appointment ID to confirm' },
            patientId: { type: 'string', description: 'Patient ID associated with the appointment' },
            confirmationResult: { type: 'string', description: 'Confirmation result code (optional)' }
          },
          required: ['appointmentId', 'patientId']
        }
      }
    ];
  }
}
