import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { UnityActions, UnityTargetSystem } from '../../../unity/config/unity-endpoints';
import type { UnityService } from '../../../unity/services/unity.service';
import { UnityErrorHandler, UnityMCPError } from '../../../unity/utils/error-handler';
import { pick, unityRows } from '../../../unity/utils/unity-rows';
import { isMdy, normalizeDate, timeToMinutes } from './dates';

/**
 * Scheduling reads for the staff assistant and later modules (outreach, huddle). All read only,
 * Veradigm® PM unless noted. Every method throws on a failed Veradigm call (never an empty list);
 * the platform turns the throw into { success:false, error_code, retryable }.
 *
 * Result keys deliberately avoid the shapes the shared voice formatter special-cases
 * (appointments, slots, patients, appointment, reasons) so the agent hears our `message`.
 *
 * PARAMETER LAYOUTS ARE UNVERIFIED. Veradigm's reference lists action names only. Each action
 * below documents the layout we assume (Unity conventions: dates MM/DD/YYYY in Parameter1/2,
 * resource ID in Parameter3). Confirm with `npm run verify:sandbox` before relying on filters.
 */

export interface ScheduleEntry {
  appointmentId: string;
  patientId: string;
  patientName: string;
  date: string;
  time: string;
  providerId: string;
  providerName: string;
  type: string;
  status: string;
  duration: number;
}

export interface ChangedAppointment extends ScheduleEntry {
  changedAt: string;
}

export interface Provider {
  id: string;
  name: string;
  type: string;
}

export interface LocationInfo {
  id: string;
  name: string;
  address: string;
  phone: string;
  hours: string;
}

export interface Recall {
  id: string;
  type: string;
  dueDate: string;
  status: string;
  providerName: string;
}

const join = (...parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(' ');

function patientNameOf(r: Record<string, any>): string {
  const full = pick(r, 'PatientName', 'Patient', 'PatName', 'Name', 'PatientFullName');
  if (full) return full;
  const last = pick(r, 'PatientLastName', 'LastName', 'PatLastName');
  const first = pick(r, 'PatientFirstName', 'FirstName', 'PatFirstName');
  return last && first ? `${last}, ${first}` : last || first;
}

function scheduleEntryOf(r: Record<string, any>): ScheduleEntry {
  const rawDate = pick(r, 'AppointmentDate', 'ApptDate', 'Date', 'StartDate', 'ApptDateTime', 'StartDateTime', 'StartDTTM');
  const rawTime = pick(r, 'AppointmentTime', 'ApptTime', 'Time', 'StartTime', 'ApptDateTime', 'StartDateTime', 'StartDTTM');
  return {
    appointmentId: pick(r, 'AppointmentID', 'ApptID', 'AppointmentId', 'ID'),
    patientId: pick(r, 'PatientID', 'PatientId', 'PatID'),
    patientName: patientNameOf(r),
    date: normalizeDate(rawDate) || rawDate,
    time: rawTime,
    providerId: pick(r, 'ResourceID', 'ResourceId', 'ProviderID', 'ProviderId'),
    providerName: pick(r, 'ResourceName', 'ProviderName', 'Resource', 'Provider', 'ResourceDescription'),
    type: pick(r, 'AppointmentType', 'ApptType', 'AppointmentTypeDescription', 'ApptTypeDescription', 'Type'),
    status: pick(r, 'Status', 'AppointmentStatus', 'ApptStatus', 'StatusDescription'),
    duration: parseInt(pick(r, 'Duration', 'ApptDuration', 'Length'), 10) || 0,
  };
}

function byTime(a: ScheduleEntry, b: ScheduleEntry): number {
  const d = a.date.localeCompare(b.date);
  if (d) return d;
  return (timeToMinutes(a.time) ?? 9999) - (timeToMinutes(b.time) ?? 9999);
}

function countBy<T>(items: T[], key: (x: T) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const x of items) m.set(key(x), (m.get(key(x)) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export class SchedulingTools {
  constructor(private unity: UnityService) {}

  /** Run one Unity action; a failed call throws (CLAUDE.md rule 5). */
  private async rows(action: string, params: Record<string, string>, patientId: string, target: UnityTargetSystem) {
    try {
      const response = await this.unity.executeAction<any>(action, params, patientId, target);
      if (!response.success) throw UnityErrorHandler.createAPIError(response.error || `${action} failed`, action);
      return unityRows(response.data);
    } catch (error) {
      if (error instanceof UnityMCPError) throw error;
      throw UnityErrorHandler.handleUnknownError(error, action);
    }
  }

  /**
   * Day schedule. GetSchedule (Veradigm® PM).
   * Assumed layout: Parameter1 = start date MM/DD/YYYY, Parameter2 = end date (same day),
   * Parameter3 = resource (provider) ID or '' for all. Provider is also filtered here in case
   * Veradigm ignores Parameter3.
   */
  async getDaySchedule(args: { date: string; providerId?: string }) {
    if (!isMdy(args?.date)) throw UnityErrorHandler.createValidationError('date is required as MM/DD/YYYY');
    const providerId = String(args.providerId || '').trim();
    const rows = await this.rows(
      UnityActions.Scheduling.GET_SCHEDULE,
      { Parameter1: args.date, Parameter2: args.date, Parameter3: providerId },
      '',
      'PM'
    );
    const schedule = rows
      .map(scheduleEntryOf)
      .filter((e) => e.appointmentId || e.time || e.patientName)
      .filter((e) => !providerId || !e.providerId || e.providerId === providerId)
      .sort(byTime);
    // Counts only: names stay in the structured result for the staff screen, never in speech.
    const perProvider = countBy(schedule, (e) => e.providerName || 'Unassigned');
    const message =
      schedule.length === 0
        ? `There are no appointments on the schedule for ${args.date}.`
        : `There ${schedule.length === 1 ? 'is 1 appointment' : `are ${schedule.length} appointments`} on ${args.date}` +
          (perProvider.length > 1 || providerId ? `: ${perProvider.map(([p, n]) => `${p} ${n}`).join(', ')}.` : '.');
    return { success: true as const, date: args.date, providerId: providerId || undefined, schedule, total: schedule.length, message };
  }

  /**
   * Providers / schedulable resources. GetResources (Veradigm® PM), no parameters assumed.
   * No silent fallback to another action: if GetResources fails, this throws.
   */
  async getProviders() {
    const rows = await this.rows(UnityActions.Scheduling.GET_RESOURCES, {}, '', 'PM');
    const providers: Provider[] = rows
      .map((r) => {
        const name =
          pick(r, 'ResourceName', 'Name', 'ProviderName', 'Description', 'DisplayName', 'Resource') ||
          join(pick(r, 'FirstName', 'ProviderFirstName'), pick(r, 'LastName', 'ProviderLastName'));
        return {
          id: pick(r, 'ResourceID', 'ResourceId', 'ProviderID', 'ProviderId', 'ID', 'Code'),
          name,
          type: pick(r, 'ResourceType', 'Type', 'ResourceTypeDescription', 'Category'),
        };
      })
      .filter((p) => p.id && p.name);
    const message =
      providers.length === 0
        ? 'No providers are set up for scheduling.'
        : `${providers.length} provider${providers.length === 1 ? '' : 's'}: ${providers
            .slice(0, 10)
            .map((p) => p.name)
            .join(', ')}${providers.length > 10 ? ` and ${providers.length - 10} more` : ''}.`;
    return { success: true as const, providers, total: providers.length, message };
  }

  /**
   * Location name, address, phone and hours. GetLocation (Veradigm® EHR).
   * Assumed layout: Parameter1 = location ID ('' = all / default location). Veradigm's reference
   * says GetLocation includes business hours, but the field name is unknown; several are tried.
   * If none is present, hours come from CLINIC_HOURS and the message says so.
   */
  async getLocationHours(args: { locationId?: string } = {}) {
    const locationId = String(args?.locationId || process.env.CLINIC_LOCATION_ID || '').trim();
    const rows = await this.rows(UnityActions.Practice.GET_LOCATION, { Parameter1: locationId }, '', 'EHR');
    const locations: LocationInfo[] = rows
      .map((r) => {
        const perDay = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
          .map((d) => {
            const h = pick(r, `${d}Hours`, `${d.slice(0, 3)}Hours`, d);
            return h ? `${d.slice(0, 3)} ${h}` : '';
          })
          .filter(Boolean)
          .join(', ');
        const openClose = [pick(r, 'OpenTime', 'StartTime', 'OfficeOpen'), pick(r, 'CloseTime', 'EndTime', 'OfficeClose')];
        return {
          id: pick(r, 'LocationID', 'LocationId', 'ID', 'Code', 'Abbreviation'),
          name: pick(r, 'LocationName', 'Name', 'Description', 'DisplayName'),
          address: [
            join(pick(r, 'Address1', 'AddressLine1', 'Address', 'Street'), pick(r, 'Address2', 'AddressLine2')),
            pick(r, 'City'),
            join(pick(r, 'State', 'StateCode'), pick(r, 'Zip', 'ZipCode', 'PostalCode')),
          ]
            .filter(Boolean)
            .join(', '),
          phone: pick(r, 'Phone', 'PhoneNumber', 'MainPhone', 'OfficePhone', 'Telephone'),
          hours:
            pick(r, 'Hours', 'BusinessHours', 'OfficeHours', 'HoursOfOperation', 'OperatingHours') ||
            perDay ||
            (openClose[0] && openClose[1] ? `${openClose[0]}-${openClose[1]}` : ''),
        };
      })
      .filter((l) => l.id || l.name);
    if (locations.length === 0) {
      return { success: false as const, message: 'No location details are on file.', locations, total: 0 };
    }

    const location = (locationId && locations.find((l) => l.id === locationId)) || locations[0];
    let hoursSource: 'veradigm' | 'clinic_config' | 'none' = 'veradigm';
    if (!location.hours) {
      const configured = process.env.CLINIC_HOURS || '';
      location.hours = configured;
      hoursSource = configured ? 'clinic_config' : 'none';
    }
    const where = [location.name, location.address].filter(Boolean).join(', ');
    const hoursText =
      hoursSource === 'veradigm'
        ? `Hours: ${location.hours}.`
        : hoursSource === 'clinic_config'
          ? `Hours are not listed in the practice system; the clinic's configured hours are ${location.hours}.`
          : 'Hours are not listed in the practice system.';
    const message = `${where}.${location.phone ? ` Phone ${location.phone}.` : ''} ${hoursText}`.trim();
    return { success: true as const, location, locations, hours: location.hours || undefined, hoursSource, total: locations.length, message };
  }

  /**
   * Appointments changed since a date (no-show follow-up). GetAppointmentsByChangeDTTM (Veradigm® PM).
   * Assumed layout: Parameter1 = since (MM/DD/YYYY), Parameter2 = until (MM/DD/YYYY or '').
   */
  async getChangedAppointments(args: { since: string; until?: string }) {
    if (!isMdy(args?.since)) throw UnityErrorHandler.createValidationError('since is required as MM/DD/YYYY');
    if (args.until && !isMdy(args.until)) throw UnityErrorHandler.createValidationError('until must be MM/DD/YYYY');
    const rows = await this.rows(
      UnityActions.Scheduling.GET_APPOINTMENTS_BY_CHANGE,
      { Parameter1: args.since, Parameter2: args.until || '' },
      '',
      'PM'
    );
    const changedAppointments: ChangedAppointment[] = rows
      .map((r) => ({
        ...scheduleEntryOf(r),
        changedAt: pick(r, 'ChangeDTTM', 'ChangedDTTM', 'LastModified', 'ModifiedDate', 'ChangeDate', 'UpdatedDTTM'),
      }))
      .filter((e) => e.appointmentId || e.date);
    const byStatus = countBy(changedAppointments, (e) => (e.status || 'unknown status').toLowerCase());
    const range = args.until ? `between ${args.since} and ${args.until}` : `since ${args.since}`;
    const message =
      changedAppointments.length === 0
        ? `No appointments changed ${range}.`
        : `${changedAppointments.length} appointment${changedAppointments.length === 1 ? '' : 's'} changed ${range}: ${byStatus
            .map(([s, n]) => `${n} ${s}`)
            .join(', ')}.`;
    return { success: true as const, since: args.since, until: args.until || undefined, changedAppointments, total: changedAppointments.length, message };
  }

  /**
   * Recalls for one patient. GetRecalls (Veradigm® PM).
   * Assumed layout: patient ID in the PatientID field, no parameters.
   */
  async getPatientRecalls(args: { patientId: string }) {
    const patientId = String(args?.patientId || '').trim();
    if (!patientId) throw UnityErrorHandler.createValidationError('Patient ID is required');
    const rows = await this.rows(UnityActions.Scheduling.GET_RECALLS, {}, patientId, 'PM');
    const recalls: Recall[] = rows
      // A recall that belongs to another patient is never returned.
      .filter((r) => {
        const pid = pick(r, 'PatientID', 'PatientId');
        return !pid || pid === patientId;
      })
      .map((r) => ({
        id: pick(r, 'RecallID', 'RecallId', 'ID'),
        type: pick(r, 'RecallType', 'RecallTypeDescription', 'Type', 'Description', 'RecallReason', 'Reason'),
        dueDate: normalizeDate(pick(r, 'DueDate', 'RecallDate', 'RecallDueDate', 'Date')) || pick(r, 'DueDate', 'RecallDate', 'RecallDueDate', 'Date'),
        status: pick(r, 'Status', 'RecallStatus'),
        providerName: pick(r, 'ProviderName', 'ResourceName', 'Provider'),
      }))
      .filter((r) => r.id || r.type || r.dueDate);
    const message =
      recalls.length === 0
        ? 'There are no recalls on file for this patient.'
        : `${recalls.length === 1 ? '1 recall' : `${recalls.length} recalls`} on file: ${recalls
            .slice(0, 5)
            .map((r) => [r.type || 'Recall', r.dueDate ? `due ${r.dueDate}` : ''].filter(Boolean).join(' '))
            .join('; ')}.`;
    return { success: true as const, patientId, recalls, total: recalls.length, message };
  }

  /** Tool definitions (static: no Veradigm connection needed to list them). */
  static definitions(): Tool[] {
    return [
      {
        name: 'unity_get_day_schedule',
        description:
          "STAFF ONLY: never read other patients' details to a caller. The day's appointments from Veradigm PM (time, patient, provider, type, status), optionally for one provider.",
        inputSchema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Date in MM/DD/YYYY format' },
            providerId: { type: 'string', description: 'Provider (resource) ID from unity_get_providers (optional)' },
          },
          required: ['date'],
        },
      },
      {
        name: 'unity_get_providers',
        description: 'List the providers (schedulable resources) in Veradigm PM with their IDs.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'unity_get_location_hours',
        description: "The clinic location's name, address, phone and business hours from Veradigm EHR.",
        inputSchema: {
          type: 'object',
          properties: { locationId: { type: 'string', description: 'Location ID (optional; defaults to the main location)' } },
          required: [],
        },
      },
      {
        name: 'unity_get_changed_appointments',
        description:
          "STAFF ONLY: never read other patients' details to a caller. Appointments changed in Veradigm PM since a date, with their status (no-show follow-up).",
        inputSchema: {
          type: 'object',
          properties: {
            since: { type: 'string', description: 'Changed on or after this date, MM/DD/YYYY' },
            until: { type: 'string', description: 'Changed on or before this date, MM/DD/YYYY (optional)' },
          },
          required: ['since'],
        },
      },
      {
        name: 'unity_get_patient_recalls',
        description: "The verified patient's recalls in Veradigm PM (recall type and due date).",
        inputSchema: {
          type: 'object',
          properties: { patientId: { type: 'string', description: 'Verified patient ID' } },
          required: ['patientId'],
        },
      },
    ];
  }
}
