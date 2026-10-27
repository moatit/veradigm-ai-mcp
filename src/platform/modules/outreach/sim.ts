import { UnityActions } from '../../../unity/config/unity-endpoints';
import { isCallingDay } from './scheduler';
import { CallConfirmSettings } from './settings';
import { addDays, CalDate, cmpDate, isoDate, mdy, parseDate } from './util';

/**
 * Synthetic clinic + fake Veradigm® PM client for Call & Confirm simulations and test calls.
 *
 * Everything here is made up: names come from fixed synthetic lists, phone numbers are in the fictional
 * 555-01XX range, IDs are invented. SimUnity answers the Veradigm® PM actions Call & Confirm and the phone
 * agent's tools use, with the row shapes and quirks seen in the Veradigm® PM sandbox on Oct 24, 2026 (field
 * names, date formats, status words; GetSchedule ranges as "a|b", a single date also returning the next day),
 * and keeps every write in `writes`, so a run can prove that only SetAppointmentStatus, SaveAppointment and
 * SaveTask were written. Nothing leaves the process.
 */
const S = UnityActions.Scheduling;

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Maya', 'Owen', 'Lucia', 'Theo', 'Nora', 'Eli', 'Ruth', 'Hugo', 'Ines', 'Abel', 'Avery', 'Blake', 'Casey', 'Dana', 'Emery', 'Finley', 'Harper', 'Jordan', 'Logan', 'Morgan', 'Noel', 'Parker', 'Quinn', 'Reese', 'Sage', 'Tatum', 'Wren', 'Iris', 'Felix', 'June'];
const LAST = ['Ashgrove', 'Birchfield', 'Coldwater', 'Dunmore', 'Elmsworth', 'Fairbrook', 'Glenhollow', 'Hartwell', 'Ivydale', 'Juniper', 'Kestrel', 'Larkspur', 'Millbrook', 'Northcott', 'Oakhurst', 'Pinecrest', 'Ravenhill', 'Stonebridge', 'Thornbury', 'Underhill', 'Westbrook', 'Yarrow'];
const AREA = ['208', '986', '435', '541', '775', '406'];

export const SIM_PROVIDERS = [
  { id: '61', abbr: 'CALDER', name: 'Calder, Iris MD' },
  { id: '62', abbr: 'VELEZ', name: 'Velez, Omar MD' },
  { id: '63', abbr: 'NAND', name: 'Nand, Priya MD' },
  { id: '64', abbr: 'MOREAU', name: 'Moreau, Felix DO' },
  { id: '65', abbr: 'HARLOW', name: 'Harlow, June NP' },
];
const TYPES = [
  { Appointment_Type_ID: '4', Abbreviation: 'FU', Description: 'Follow-up Visit', Duration: '20', Appointment_Category_ID: '2', Appt_Category_Abbreviation: 'OV' },
  { Appointment_Type_ID: '5', Abbreviation: 'NP', Description: 'New Patient Visit', Duration: '40', Appointment_Category_ID: '2', Appt_Category_Abbreviation: 'OV' },
  { Appointment_Type_ID: '6', Abbreviation: 'LABREV', Description: 'Lab Review', Duration: '20', Appointment_Category_ID: '2', Appt_Category_Abbreviation: 'OV' },
];
const CANCEL_REASONS = [
  { Cancellation_Reason_ID: '1', Description: 'Moved Appointment', Abbreviation: 'MOVED' },
  { Cancellation_Reason_ID: '3', Description: 'Patient Cancelled', Abbreviation: 'PAT CX' },
  { Cancellation_Reason_ID: '4', Description: 'Office Cancelled', Abbreviation: 'OFF CX' },
];
const CONFIRM_RESULTS = [
  { Appt_Confirmation_Result_ID: '1', Short_Description: 'Answered - Yes' },
  { Appt_Confirmation_Result_ID: '2', Short_Description: 'Left Message' },
  { Appt_Confirmation_Result_ID: '3', Short_Description: 'No Answer' },
  { Appt_Confirmation_Result_ID: '4', Short_Description: 'Confirmed by text' },
];
/** GetSchedule status words as the sandbox sends them (GetScheduleByPatientID / ByChangeDTTM send the letter). */
const STATUS_LABEL: Record<string, string> = { S: 'Scheduled', C: 'Confirmed', X: 'canceled', N: 'No Show', O: 'Checked Out' };

export interface SimPatient {
  id: string;
  first: string;
  last: string;
  /** MM/DD/YYYY */
  dob: string;
  /** As stored in Veradigm® PM ('' = none on file). */
  phone: string;
  /** false = a well-formed number that is not in service (found only by dialing). */
  inService: boolean;
}

export interface SimAppt {
  id: string;
  patientId: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM 24-hour */
  time: string;
  resourceId: string;
  typeId: string;
  duration: number;
  status: 'S' | 'C' | 'X' | 'N' | 'O';
  confirmResultId: string;
  /** "YYYY-MM-DD HH:MM" clinic-local */
  changedAt: string;
}

export interface SimRecall {
  patientId: string;
  type: string;
  due: string;
  status: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const ampm = (t: string) => {
  const m = toMin(t);
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${pad(m % 60)}:00 ${h >= 12 ? 'PM' : 'AM'}`;
};
/** "9:00am" (GetAppointmentsByChangeDTTM's Appointment_DateTime time, no seconds, no space). */
const ampmShort = (t: string) => {
  const m = toMin(t);
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${pad(m % 60)}${h >= 12 ? 'pm' : 'am'}`;
};
/** "9/15/2026" (no leading zeros, as GetRecalls and GetScheduleByPatientID send dates). */
const mdyLoose = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
};
const isoFromMdy = (s: string) => {
  const c = parseDate(s);
  return c ? isoDate(c) : '';
};
/** "MM/DD/YYYY HH:MM:SS" → "YYYY-MM-DD HH:MM" */
const stampFromParam = (s: string) => {
  const m = String(s || '').match(/^(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return '';
  return `${isoFromMdy(m[1])} ${pad(+(m[2] || 0))}:${m[3] || '00'}`;
};
const ok = (key: string, rows: any[]) => ({ success: true, data: [{ [key]: rows }] });

export class SimUnity {
  readonly patients = new Map<string, SimPatient>();
  readonly appts = new Map<string, SimAppt>();
  readonly recalls: SimRecall[] = [];
  readonly writes: Array<{ action: string; patientId: string; detail: string }> = [];
  readonly reads = new Map<string, number>();
  /** Actions that fail (tests of "errors are not empty results"). */
  readonly failing = new Set<string>();
  /** Clinic-local "YYYY-MM-DD HH:MM" stamped on status changes (the simulated clock). */
  clock = '2026-01-01 08:00';
  private nextAppt = 700100;
  private nextTask = 9100;

  addAppt(a: Omit<SimAppt, 'id' | 'changedAt' | 'confirmResultId'> & Partial<SimAppt>): SimAppt {
    const appt: SimAppt = { confirmResultId: '', changedAt: this.clock, ...a, id: a.id || String(this.nextAppt++) };
    this.appts.set(appt.id, appt);
    return appt;
  }

  setStatus(id: string, status: SimAppt['status'], at = this.clock): boolean {
    const a = this.appts.get(id);
    if (!a) return false;
    a.status = status;
    a.changedAt = at;
    return true;
  }

  /** GetSchedule row (sandbox shape: the date only in ApptTime2, no confirmation result). */
  private rowForSchedule(a: SimAppt) {
    const p = this.patients.get(a.patientId)!;
    const r = SIM_PROVIDERS.find((x) => x.id === a.resourceId);
    return {
      AppointmentID: a.id,
      patientID: a.patientId,
      PatientFirstName: p.first,
      PatientLastName: p.last,
      patient: `${p.last}, ${p.first}`,
      ApptTime: a.time,
      ApptTime2: `${mdy(parseDate(a.date)!)} ${ampm(a.time).padStart(11, '0')}`,
      Provider: r?.name || '',
      Practitioner_Name: r?.name || '',
      ProviderID: a.resourceId,
      Duration: String(a.duration),
      Status: STATUS_LABEL[a.status],
      appttype: TYPES.find((t) => t.Appointment_Type_ID === a.typeId)?.Abbreviation || '',
      type: TYPES.find((t) => t.Appointment_Type_ID === a.typeId)?.Description || '',
    };
  }

  /** GetAppointmentsByChangeDTTM row (sandbox shape: status letter, Attending* provider). */
  private rowForChange(a: SimAppt) {
    const p = this.patients.get(a.patientId)!;
    const r = SIM_PROVIDERS.find((x) => x.id === a.resourceId);
    const [last, first] = (r?.name || '').split(',').map((s) => s.trim());
    return {
      Appointment_ID: a.id,
      Patient_ID: a.patientId,
      Patient_First_Name: p.first,
      Appointment_DateTime: `${mdy(parseDate(a.date)!)} ${ampmShort(a.time)}`,
      Status: a.status === 'O' ? 'S' : a.status,
      DateTime_NoShow: a.status === 'N' ? `${mdyLoose(a.date)} 5:30:00 PM` : '',
      Resource_ID: a.resourceId,
      Resource_Abbr: r?.abbr || '',
      AttendingLastName: last || '',
      AttendingFirstName: (first || '').replace(/\s+(MD|DO|NP)$/, ''),
    };
  }

  /** GetScheduleByPatientID row (sandbox shape). */
  private rowForPatientSchedule(a: SimAppt) {
    return {
      Appointment_ID: a.id,
      Patient_ID: a.patientId,
      Appointment_DateTime: `${mdyLoose(a.date)} ${ampm(a.time)}`,
      Resource_ID: a.resourceId,
      Appointment_Type_ID: a.typeId,
      Status: a.status === 'O' ? 'S' : a.status,
      Appt_Confirmation_Result_ID: a.confirmResultId,
      Duration: String(a.duration),
    };
  }

  /** Two 144-character halves of a 288-cell (5-minute) day bitmap. */
  private bitmap(ranges: Array<[number, number]>): [string, string] {
    const cells = Array(288).fill('0');
    for (const [s, e] of ranges) for (let i = Math.floor(s / 5); i < Math.ceil(e / 5); i++) cells[i] = '1';
    const str = cells.join('');
    return [str.slice(0, 144), str.slice(144)];
  }

  async executeAction<T = any>(action: string, params: Record<string, any> = {}, patientId = '', _target = 'PM'): Promise<any> {
    this.reads.set(action, (this.reads.get(action) || 0) + 1);
    if (this.failing.has(action)) return { success: false, error: `Simulated ${action} failure` } as T;
    const all = [...this.appts.values()];
    switch (action) {
      case S.GET_SCHEDULE: {
        // Sandbox: a range is Parameter1 "a|b"; one date returns that day and the next; Parameter2 is not an end date.
        const [p1, p2] = String(params.Parameter1 || '').split('|');
        const from = isoFromMdy(p1);
        const to = p2 ? isoFromMdy(p2) : from ? isoDate(addDays(parseDate(from)!, 1)) : '';
        return ok('getscheduleinfo', all.filter((a) => a.date >= from && a.date <= to).map((a) => this.rowForSchedule(a)));
      }
      case S.GET_APPOINTMENTS_BY_CHANGE: {
        const from = stampFromParam(params.Parameter1);
        const to = stampFromParam(params.Parameter2);
        return ok('getappointmentsbychangedttminfo', all.filter((a) => a.changedAt >= from && a.changedAt <= to).map((a) => this.rowForChange(a)));
      }
      case S.GET_RECALLS: {
        // Sandbox: Parameter1 + Parameter2 = due-date range; Parameter1 alone returns nothing. No status field.
        if (!params.Parameter2) return ok('getrecallsinfo', []);
        const from = isoFromMdy(params.Parameter1);
        const to = isoFromMdy(params.Parameter2);
        return ok(
          'getrecallsinfo',
          this.recalls
            .filter((r) => r.status === 'Open' && r.due >= from && r.due <= to)
            .map((r, i) => ({
              Recall_ID: String(5000 + i),
              Patient_ID: r.patientId,
              Patient_First_Name: this.patients.get(r.patientId)?.first || '',
              Recall_Date: `${mdyLoose(r.due)} 12:00:00 AM`,
              Recall_Type_Desc: r.type,
              Recall_Type_Abbr: r.type.toUpperCase().slice(0, 8),
              Linked_Appointment_ID: String(600000 + i),
            }))
        );
      }
      case UnityActions.Patient.GET_PATIENT: {
        const p = this.patients.get(patientId);
        const digits = p ? p.phone.replace(/\D/g, '') : '';
        return ok(
          'getpatientinfo',
          p ? [{ Patient_ID: p.id, Patient_First_Name: p.first, Patient_Last_Name: p.last, Patient_DOB: p.dob, Patient_Cell_Phone: digits, Patient_Home_Phone: '', Patient_Work_Phone: '' }] : []
        );
      }
      case S.GET_APPOINTMENTS:
        return ok('getschedulebypatientidinfo', all.filter((a) => a.patientId === patientId).map((a) => this.rowForPatientSchedule(a)));
      case S.GET_CONFIRMATION_RESULTS:
        return ok('getappointmentconfirmationresultsinfo', CONFIRM_RESULTS);
      case S.GET_CANCELLATION_REASONS:
        return ok('getappointmentcancellationreasonsinfo', CANCEL_REASONS);
      case S.GET_RESOURCES:
        return ok(
          'getresourcesinfo',
          SIM_PROVIDERS.map((r, i) => ({ Resource_ID: r.id, Abbreviation: r.abbr, Description: r.name, Practitioner_ID: String(20 + i), Default_Appointment_Type_ID: '4' }))
        );
      case S.GET_APPOINTMENT_TYPES:
        return ok('getappointmenttypesinfo', TYPES);
      case S.GET_SCHEDULING_LOCATIONS:
        return ok('getschedulinglocationsinfo', [{ Scheduling_Location_ID: '1', Abbreviation: 'MAIN', Description: 'Main Clinic', Location_ID: '1' }]);
      case S.GET_SCHEDULING_DEPARTMENTS:
        return ok('getschedulingdepartmentsinfo', [{ Scheduling_Department_ID: '1', Abbreviation: 'NEPH', Description: 'Nephrology', Department_ID: '1' }]);
      case S.GET_OPEN_SLOTS: {
        const r = SIM_PROVIDERS.find((x) => x.abbr === String(params.Parameter1).trim());
        const start = parseDate(params.Parameter2);
        const end = parseDate(params.Parameter3);
        if (!r || !start || !end) return ok('getavailablescheduleinfo', []);
        const rows: any[] = [];
        for (let d = start; cmpDate(d, end) < 0; d = addDays(d, 1)) {
          const wd = new Date(Date.UTC(d.y, d.m - 1, d.d, 12)).getUTCDay();
          if (wd === 0 || wd === 6) continue;
          const booked = all
            .filter((a) => a.resourceId === r.id && a.date === isoDate(d) && a.status !== 'X')
            .map((a) => [toMin(a.time), toMin(a.time) + a.duration] as [number, number]);
          const [k1, k2] = this.bitmap([
            [8 * 60, 12 * 60],
            [13 * 60, 17 * 60],
          ]);
          const [b1, b2] = this.bitmap(booked);
          rows.push({
            Resource_Abbreviation: `${r.abbr}  `,
            Resource_ID: r.id,
            Available_Date: mdy(d),
            Scheduling_Location_ID: '1',
            Scheduling_Location_Abbreviation: 'MAIN  ',
            Scheduling_Department_ID: '1',
            Scheduling_Department_Abbreviation: 'NEPH  ',
            Blocked_Slots1: k1,
            Blocked_Slots2: k2,
            Booked_Slots1: b1,
            Booked_Slots2: b2,
            Elig_Appointment_Category_ID: '',
            Inelig_Appointment_Category_ID: '',
          });
        }
        return ok('getavailablescheduleinfo', rows);
      }
      case S.SAVE_APPOINTMENT: {
        const xml = String(params.Parameter1 || '');
        const tag = (n: string) => (xml.match(new RegExp(`<${n}>([^<]*)</${n}>`)) || [])[1] || '';
        const m = tag('appointmentDateTime').match(/^(\d{2}\/\d{2}\/\d{4}) (\d{2}:\d{2})/);
        const r = SIM_PROVIDERS.find((x) => x.abbr === tag('resource'));
        const type = TYPES.find((t) => t.Abbreviation === tag('appointmentType'));
        if (!m || !r) return { success: false, error: 'Magic Error - Action: SaveAppointment - invalid appointment' };
        const a = this.addAppt({
          patientId,
          date: isoFromMdy(m[1]),
          time: m[2],
          resourceId: r.id,
          typeId: type?.Appointment_Type_ID || '4',
          duration: Number(tag('appointmentDuration')) || 20,
          status: 'S',
        });
        this.writes.push({ action, patientId, detail: `new visit ${a.date} ${a.time} ${r.abbr}` });
        return ok('saveappointmentinfo', [{ Appointment_ID: a.id, Encounter_Number: String(8000 + this.writes.length) }]);
      }
      case S.SET_APPOINTMENT_STATUS: {
        const a = this.appts.get(String(params.Parameter1));
        if (!a) return ok('setappointmentstatusinfo', [{ Status: 'Appointment not found' }]);
        this.setStatus(a.id, params.Parameter2);
        this.writes.push({ action, patientId, detail: `${params.Parameter2}${params.Parameter6 ? ` reason ${params.Parameter6}` : ''}` });
        return ok('setappointmentstatusinfo', [{ Status: 'success' }]);
      }
      case UnityActions.Task.SAVE_TASK: {
        const id = String(this.nextTask++);
        this.writes.push({ action, patientId, detail: String(params.Parameter5 || '') });
        return ok('savetaskinfo', [{ TaskID: id }]);
      }
      default:
        return { success: false, error: `SimUnity does not answer ${action}` };
    }
  }

  /** SearchPatients: "Last, First" prefix match, like Veradigm (PM IDs; EHR rows carry other IDs). */
  async searchPatients(c: { lastName?: string; firstName?: string }, target?: string): Promise<any> {
    const last = String(c.lastName || '').trim().split(/[\s-]+/)[0].toLowerCase();
    const first = String(c.firstName || '').trim().toLowerCase();
    const rows = [...this.patients.values()]
      .filter((p) => p.last.toLowerCase().startsWith(last) && p.first.toLowerCase().startsWith(first))
      .map((p) => ({ ID: target === 'EHR' ? `9${p.id}` : p.id, lastname: p.last, firstname: p.first, dateofbirth: p.dob }));
    return { success: true, data: [{ searchpatientsinfo: rows }] };
  }
}

export interface ClinicOptions {
  seed?: number;
  /** First simulated day; the schedule covers a few days before it and three weeks after. */
  start: CalDate;
  settings: CallConfirmSettings;
  /** Visits per provider per day (average). IKI-scale default 13 × 5 providers ≈ 65 a day. */
  visitsPerProviderDay?: number;
}

/**
 * A synthetic nephrology clinic at IKI scale: 5 providers, about 65 visits a calling day, 20/40-minute slots in
 * 08:00–12:00 and 13:00–17:00. About 40% of future visits are already confirmed (text/portal), 2% cancelled;
 * about 6% of past visits are no-shows; 4% of phone numbers are not in service, 1% have none; about 40 patients
 * are past due for a recall with nothing booked, plus recall patients who already booked.
 */
export function syntheticClinic(o: ClinicOptions): SimUnity {
  const r = rng(o.seed ?? 20261026);
  const sim = new SimUnity();
  const perDay = o.visitsPerProviderDay ?? 13;
  let pid = 30100;
  const newPatient = (): SimPatient => {
    const roll = r();
    const p: SimPatient = {
      id: String(pid++),
      first: FIRST[Math.floor(r() * FIRST.length)],
      last: LAST[Math.floor(r() * LAST.length)],
      dob: `${pad(1 + Math.floor(r() * 12))}/${pad(1 + Math.floor(r() * 28))}/${1938 + Math.floor(r() * 62)}`,
      phone: roll < 0.01 ? '' : `(${AREA[Math.floor(r() * AREA.length)]}) 555-01${pad(Math.floor(r() * 100))}`,
      inService: roll >= 0.05,
    };
    sim.patients.set(p.id, p);
    return p;
  };
  const pool: SimPatient[] = [];
  const pickPatient = () => (pool.length > 40 && r() < 0.08 ? pool[Math.floor(r() * pool.length)] : (pool.push(newPatient()), pool[pool.length - 1]));

  const first = addDays(o.start, -4);
  const last = addDays(o.start, 24);
  for (let d = first; cmpDate(d, last) <= 0; d = addDays(d, 1)) {
    const wd = new Date(Date.UTC(d.y, d.m - 1, d.d, 12)).getUTCDay();
    if (wd === 0 || wd === 6 || !isCallingDay(d, o.settings)) continue;
    const past = cmpDate(d, o.start) < 0;
    for (const prov of SIM_PROVIDERS) {
      const n = Math.max(6, perDay + Math.floor(r() * 5) - 2);
      // 20-minute grid, 24 slots a day; a new-patient visit takes two.
      const free = Array.from({ length: 24 }, (_, i) => (i < 12 ? 8 * 60 + i * 20 : 13 * 60 + (i - 12) * 20));
      for (let k = 0; k < n && free.length; k++) {
        const t = free.splice(Math.floor(r() * free.length), 1)[0];
        const p = pickPatient();
        const np = r() < 0.12 && free.includes(t + 20);
        if (np) free.splice(free.indexOf(t + 20), 1);
        let status: SimAppt['status'] = 'S';
        let confirmResultId = '';
        const roll = r();
        if (past) status = roll < 0.06 ? 'N' : 'O';
        else if (roll < 0.02) status = 'X';
        else if (roll < 0.36) {
          status = 'C';
          confirmResultId = '4';
        } else if (roll < 0.42) confirmResultId = '1'; // answered yes on an earlier call, status not updated
        else if (roll < 0.5) confirmResultId = '2'; // left message: still to confirm
        sim.addAppt({
          patientId: p.id,
          date: isoDate(d),
          time: hhmm(t),
          resourceId: prov.id,
          typeId: np ? '5' : r() < 0.2 ? '6' : '4',
          duration: np ? 40 : 20,
          status,
          confirmResultId,
          changedAt: `${isoDate(past ? d : addDays(o.start, -10))} ${past ? '17:30' : '09:00'}`,
        });
      }
    }
  }
  // Recalls past due: 40 with nothing booked, plus 12 from the visit pool (most already booked).
  for (let i = 0; i < 40; i++) {
    const p = newPatient();
    sim.recalls.push({ patientId: p.id, type: r() < 0.5 ? 'Annual kidney follow-up' : 'Lab recheck', due: isoDate(addDays(o.start, -(3 + Math.floor(r() * 90)))), status: 'Open' });
  }
  for (let i = 0; i < 12; i++) {
    const p = pool[Math.floor(r() * pool.length)];
    sim.recalls.push({ patientId: p.id, type: 'Annual kidney follow-up', due: isoDate(addDays(o.start, -(5 + Math.floor(r() * 60)))), status: 'Open' });
  }
  sim.clock = `${isoDate(addDays(o.start, -1))} 18:00`;
  return sim;
}
