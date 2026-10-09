import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { UnityService, UnityMagicResponse } from '../services/unity.service';
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
  locationId?: string;
  sortKey: number;
}

interface Resource {
  id: string;
  abbreviation: string;
  name: string;
  practitionerId: string;
}

const LOOKUP_TTL_MS = 10 * 60 * 1000;
const lookupCache: {
  resources?: { at: number; value: Resource[] };
  types?: { at: number; value: Map<string, string> };
} = {};

/** Veradigm® PM appointment status codes. */
const STATUS_LABELS: Record<string, string> = {
  S: 'Scheduled',
  C: 'Confirmed',
  X: 'Cancelled',
  N: 'No show',
  K: 'Checked in',
  O: 'Checked out',
  R: 'Rescheduled',
};

function isCancelledStatus(code: string): boolean {
  return /^(x|r|cancell?ed|rescheduled)$/i.test((code || '').trim());
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

/**
 * Turn GetAvailableSchedule day rows into open start times. Rows for the same day (one per
 * department/location) are combined: bookable if any row marks the cell bookable, booked if any
 * row marks it booked.
 */
function decodeAvailability(rows: Record<string, any>[], r: Resource, duration: number, now: Date, partOfDay?: string): OpenSlot[] {
  const days = new Map<string, { open: boolean[]; booked: boolean[]; locationId: string }>();
  for (const row of rows) {
    const date = mdy(pick(row, 'Available_Date', 'AvailableDate'));
    if (!date) continue;
    const template = (pick(row, 'Blocked_Slots1') + pick(row, 'Blocked_Slots2')).split('');
    const booked = (pick(row, 'Booked_Slots1') + pick(row, 'Booked_Slots2')).split('');
    const d = days.get(date) || { open: [], booked: [], locationId: pick(row, 'Scheduling_Location_ID') };
    template.forEach((c, i) => { if (c === '1') d.open[i] = true; });
    booked.forEach((c, i) => { if (c === '1') d.booked[i] = true; });
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
      out.push({ date, time: spokenTime(minutes), duration, providerId: r.id, providerName: r.name, locationId: d.locationId || undefined, sortKey: at });
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

/**
 * Appointment Data Structure for Save/Update operations
 */
export interface AppointmentData {
  patientId: string;
  appointmentDate: string; // Format: MM/DD/YYYY
  appointmentTime: string; // Format: HH:MM (24-hour)
  duration: number; // Duration in minutes
  providerId?: string;
  locationId?: string;
  appointmentType?: string;
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
 * Provides MCP tools for appointment write operations via Unity API:
 * - SaveAppointment: Create or update appointments
 * - CancelAppointment: Cancel appointments
 * - GetOpenSlots: Find available appointment slots
 */
export class UnityAppointmentTools {
  constructor(private unityService: UnityService) {}

  /**
   * Save (create or update) an appointment
   */
  async saveAppointment(args: AppointmentData): Promise<{
    success: boolean;
    appointmentId?: string;
    message: string;
    appointment?: ParsedAppointment;
  }> {
    try {
      // Validate required fields
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }
      if (!args.appointmentDate) {
        throw UnityErrorHandler.createValidationError('Appointment date is required');
      }
      if (!args.appointmentTime) {
        throw UnityErrorHandler.createValidationError('Appointment time is required');
      }
      if (!args.duration || args.duration <= 0) {
        throw UnityErrorHandler.createValidationError('Valid duration is required');
      }

      // Build appointment XML for Unity SaveAppointment action
      const appointmentXml = this.buildAppointmentXml(args);

      console.error(`[Unity Appointment] Saving appointment for patient ${args.patientId}`);
      console.error(`[Unity Appointment] Date: ${args.appointmentDate} Time: ${args.appointmentTime}`);

      // Execute SaveAppointment action
      // Parameter1: Appointment XML
      // Parameter2: Optional flags
      const response = await this.unityService.executeAction<any>(
        UnityActions.Scheduling.SAVE_APPOINTMENT,
        {
          Parameter1: appointmentXml,
          Parameter2: '' // Additional options if needed
        },
        args.patientId,
        'PM' // Appointments typically go to Practice Management
      );

      if (!response.success) {
        throw UnityErrorHandler.createAPIError(
          response.error || 'Failed to save appointment',
          'SaveAppointment'
        );
      }

      // Parse the response to get appointment ID and details
      const appointmentId = this.extractAppointmentId(response.data);
      const appointment = this.parseAppointmentResponse(response.data, args);

      return {
        success: true,
        appointmentId,
        message: 'Appointment saved successfully',
        appointment
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, 'SaveAppointment');
    }
  }

  /**
   * Cancel an existing appointment
   */
  async cancelAppointment(args: AppointmentCancelData): Promise<{
    success: boolean;
    message: string;
    appointmentId: string;
    cancellationReason?: string;
  }> {
    try {
      // Validate required fields
      if (!args.appointmentId) {
        throw UnityErrorHandler.createValidationError('Appointment ID is required');
      }
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }

      console.error(`[Unity Appointment] Cancelling appointment ${args.appointmentId}`);

      // SetAppointmentStatus: Parameter1 = appointment ID, Parameter2 = PM status (X = cancelled),
      // Parameter3 = reason from GetAppointmentCancellationReasons (Kanhaiya, main 0a4e3c4).
      const response = await this.unityService.executeAction<any>(
        UnityActions.Scheduling.CANCEL_APPOINTMENT,
        {
          Parameter1: args.appointmentId,
          Parameter2: process.env.UNITY_CANCELLED_STATUS || 'X',
          Parameter3: args.cancellationReason || 'Cancelled via API'
        },
        args.patientId,
        'PM'
      );

      if (!response.success) {
        throw UnityErrorHandler.createAPIError(
          response.error || 'Failed to cancel appointment',
          UnityActions.Scheduling.CANCEL_APPOINTMENT
        );
      }

      return {
        success: true,
        message: 'Appointment cancelled successfully',
        appointmentId: args.appointmentId,
        cancellationReason: args.cancellationReason
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, UnityActions.Scheduling.CANCEL_APPOINTMENT);
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
    slots: Omit<OpenSlot, 'sortKey'>[];
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
        const configured = (process.env.UNITY_SCHEDULING_RESOURCES || '').split(',').map((x) => x.trim()).filter(Boolean);
        chosen = configured.flatMap((c) => matchResources(resources, c)).slice(0, 10);
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

      const perProvider = await Promise.all(
        chosen.map(async (r) => {
          const response = await this.unityService.executeAction<any>(
            UnityActions.Scheduling.GET_OPEN_SLOTS,
            // The end date is exclusive in Veradigm® PM (10/13-10/13 returns nothing): ask for one more day.
            { Parameter1: r.abbreviation, Parameter2: start, Parameter3: nextDay(end) },
            '',
            'PM'
          );
          // A failed call is an error, never "no openings" (CLAUDE.md rule 5).
          if (!response.success) {
            throw UnityErrorHandler.createAPIError(
              response.error || 'Failed to get open slots',
              UnityActions.Scheduling.GET_OPEN_SLOTS
            );
          }
          const lastDay = mdyTime(end);
          const rows = unityRows(response.data).filter((row) => mdyTime(pick(row, 'Available_Date', 'AvailableDate')) <= lastDay);
          return decodeAvailability(rows, r, duration, now, args.partOfDay);
        })
      );

      let slots = perProvider.flat().sort((a, b) => a.sortKey - b.sortKey);
      if (args.locationId) slots = slots.filter((x) => !x.locationId || x.locationId === String(args.locationId));
      if (maxPerDay > 0) slots = spreadPerDay(slots, maxPerDay);

      return {
        slots: slots.map(({ sortKey: _sortKey, ...rest }) => rest),
        total: slots.length,
        providers: chosen.map((r) => r.name),
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, 'GetOpenSlots');
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
      throw UnityErrorHandler.handleUnknownError(error, 'GetScheduleByPatientID');
    }
  }

  /**
   * Valid cancellation reasons (GetAppointmentCancellationReasons).
   * cancel_appointment must use one of these (spec §4 rule 4).
   */
  async getCancellationReasons(): Promise<{
    success: true;
    reasons: Array<{ id: string; description: string }>;
    total: number;
  }> {
    const rows = await this.lookupList(UnityActions.Scheduling.GET_CANCELLATION_REASONS);
    const reasons = rows
      .map(r => ({
        id: pick(r, 'ID', 'ReasonID', 'CancelReasonID', 'Code', 'Value'),
        description: pick(r, 'Description', 'Reason', 'CancelReason', 'Name', 'DisplayName', 'Entry')
      }))
      .filter(r => r.id || r.description);
    return { success: true, reasons, total: reasons.length };
  }

  /**
   * Appointment type codes (GetAppointmentTypes).
   */
  async getAppointmentTypes(): Promise<{
    success: true;
    appointmentTypes: Array<{ id: string; description: string; duration?: number }>;
    total: number;
  }> {
    const rows = await this.lookupList(UnityActions.Scheduling.GET_APPOINTMENT_TYPES);
    const appointmentTypes = rows
      .map(r => ({
        id: pick(r, 'ID', 'AppointmentTypeID', 'ApptTypeID', 'Code', 'Abbreviation'),
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

  /**
   * Confirm an appointment (SetAppointmentStatus).
   * Parameter layout is UNVERIFIED against the sandbox: Parameter1 = appointment ID,
   * Parameter2 = status, Parameter3 = confirmation result from GetAppointmentConfirmationResults.
   */
  async confirmAppointment(args: { appointmentId: string; patientId: string; confirmationResult?: string }): Promise<{
    success: boolean;
    message: string;
    appointmentId: string;
  }> {
    try {
      if (!args.appointmentId) {
        throw UnityErrorHandler.createValidationError('Appointment ID is required');
      }
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }
      const response = await this.unityService.executeAction<any>(
        UnityActions.Scheduling.SET_APPOINTMENT_STATUS,
        {
          Parameter1: args.appointmentId,
          Parameter2: process.env.UNITY_CONFIRMED_STATUS || 'Confirmed',
          Parameter3: args.confirmationResult || ''
        },
        args.patientId,
        'PM'
      );
      if (!response.success) {
        throw UnityErrorHandler.createAPIError(
          response.error || 'Failed to confirm appointment',
          UnityActions.Scheduling.SET_APPOINTMENT_STATUS
        );
      }
      return { success: true, message: 'Appointment confirmed', appointmentId: args.appointmentId };
    } catch (error) {
      if (error instanceof UnityMCPError) throw error;
      throw UnityErrorHandler.handleUnknownError(error, UnityActions.Scheduling.SET_APPOINTMENT_STATUS);
    }
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

  /** Scheduling resources (GetResources), cached for 10 minutes. */
  private async resources(): Promise<Resource[]> {
    if (lookupCache.resources && Date.now() - lookupCache.resources.at < LOOKUP_TTL_MS) return lookupCache.resources.value;
    const rows = await this.lookupList(UnityActions.Scheduling.GET_RESOURCES);
    const value = rows
      .map((r) => ({
        id: pick(r, 'Resource_ID', 'ResourceID', 'ID'),
        abbreviation: pick(r, 'Abbreviation', 'Resource_Abbreviation'),
        name: displayName(pick(r, 'Description', 'Name', 'ResourceName')),
        practitionerId: pick(r, 'Practitioner_ID', 'PractitionerID'),
      }))
      .filter((r) => r.id && r.abbreviation && !/\*\*\*inactive\*\*\*/i.test(r.name));
    lookupCache.resources = { at: Date.now(), value };
    return value;
  }

  private async resourceNames(): Promise<Map<string, string>> {
    try {
      return new Map((await this.resources()).map((r) => [r.id, r.name] as [string, string]));
    } catch {
      return new Map(); // names are a nicety; the appointment list still answers
    }
  }

  /** Appointment type ID → description (GetAppointmentTypes), cached; empty on failure. */
  private async appointmentTypeNames(): Promise<Map<string, string>> {
    if (lookupCache.types && Date.now() - lookupCache.types.at < LOOKUP_TTL_MS) return lookupCache.types.value;
    try {
      const rows = await this.lookupList(UnityActions.Scheduling.GET_APPOINTMENT_TYPES);
      const value = new Map(
        rows.map((r) => [pick(r, 'Appointment_Type_ID', 'AppointmentTypeID', 'ID'), pick(r, 'Description', 'Abbreviation')] as [string, string])
      );
      lookupCache.types = { at: Date.now(), value };
      return value;
    } catch {
      return new Map();
    }
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

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Build appointment XML for SaveAppointment
   */
  private buildAppointmentXml(data: AppointmentData): string {
    let xml = '<appointment>';
    
    xml += `<PatientID>${this.escapeXml(data.patientId)}</PatientID>`;
    xml += `<AppointmentDate>${this.escapeXml(data.appointmentDate)}</AppointmentDate>`;
    xml += `<AppointmentTime>${this.escapeXml(data.appointmentTime)}</AppointmentTime>`;
    xml += `<Duration>${data.duration}</Duration>`;
    
    if (data.providerId) {
      xml += `<ProviderID>${this.escapeXml(data.providerId)}</ProviderID>`;
    }
    if (data.locationId) {
      xml += `<LocationID>${this.escapeXml(data.locationId)}</LocationID>`;
    }
    if (data.appointmentType) {
      xml += `<AppointmentType>${this.escapeXml(data.appointmentType)}</AppointmentType>`;
    }
    if (data.reasonForVisit) {
      xml += `<ReasonForVisit>${this.escapeXml(data.reasonForVisit)}</ReasonForVisit>`;
    }
    if (data.notes) {
      xml += `<Notes>${this.escapeXml(data.notes)}</Notes>`;
    }
    
    xml += '</appointment>';
    return xml;
  }

  /**
   * Extract appointment ID from response
   */
  private extractAppointmentId(data: any): string {
    if (!data) return '';
    
    // Try common response field names
    return data.AppointmentID || 
           data.appointmentid || 
           data.ID || 
           data.id || 
           '';
  }

  /**
   * Parse appointment response into structured format
   */
  private parseAppointmentResponse(data: any, original: AppointmentData): ParsedAppointment {
    return {
      id: this.extractAppointmentId(data),
      patientId: original.patientId,
      date: original.appointmentDate,
      time: original.appointmentTime,
      duration: original.duration,
      status: data?.Status || 'Scheduled',
      providerId: data?.ProviderID || original.providerId,
      providerName: data?.ProviderName,
      locationId: data?.LocationID || original.locationId,
      locationName: data?.LocationName,
      appointmentType: data?.AppointmentType || original.appointmentType,
      reasonForVisit: data?.ReasonForVisit || original.reasonForVisit,
      notes: data?.Notes || original.notes
    };
  }

  /**
   * Parse list of appointments from response
   */
  private parseAppointmentsList(data: any): ParsedAppointment[] {
    return unityRows(data).map(item => this.parseAppointmentRow(item));
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
   * Escape XML special characters
   */
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Get MCP tool definitions for appointment operations
   */
  getTools(): Tool[] {
    return [
      {
        name: 'unity_save_appointment',
        description: 'Create or update an appointment in Veradigm Practice Management via Unity API',
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
              description: 'Appointment time in HH:MM format (24-hour)'
            },
            duration: {
              type: 'number',
              description: 'Appointment duration in minutes'
            },
            providerId: {
              type: 'string',
              description: 'Provider/Practitioner ID (optional)'
            },
            locationId: {
              type: 'string',
              description: 'Location/Facility ID (optional)'
            },
            appointmentType: {
              type: 'string',
              description: 'Type of appointment (e.g., "Office Visit", "Follow-up")'
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
          'Returns up to maxPerDay times per day (default 3), soonest first.',
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
              description: 'Filter by appointment type (optional)'
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

