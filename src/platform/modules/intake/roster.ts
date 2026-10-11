import * as fs from 'fs';
import { normalizeDate } from './extract';

/**
 * Local patient roster: an optional patient search for an early start of shadow mode, before the
 * clinic's Veradigm® access exists. Once it does, leave this unset: the live read-only
 * unity_search_patients is the normal search.
 *
 *   INTAKE_ROSTER_CSV   path to a CSV exported from the practice system (IKI's patient list)
 *
 * When set, matchPatient() (match.ts) searches this roster instead of calling unity_search_patients.
 * The search answers in the same shape as unity_search_patients ({ patients, total, message }, each
 * row with patientId, chartPatientId, names, dateOfBirth, mrn / patientNumber and phone {home, cell,
 * work}) and filters the same way (date of birth exact, first two letters of first and last name),
 * so decideMatch() and its two-identifier rule are unchanged.
 *
 * Failures are never "no match": a missing, unreadable or empty roster, or one without the
 * required columns, makes the search return { success:false, error_code: ROSTER_* } and the item
 * ends 'failed' (staff retry once it is fixed). The file is re-read when its size or time changes.
 *
 * Columns (header row; case, spaces and punctuation ignored; comma, semicolon, tab or | separated):
 *   required   last name, first name, date of birth, MRN
 *              ("Patient Name" / "Name" as "LAST, FIRST M" stands in for last + first)
 *   optional   middle name, a second MRN (EHR chart MRN / PatientNumber), chart ID, patient ID,
 *              phones (home, cell, work, ...)
 * The chart ID is the patient key (what a document would be filed to); without that column the MRN
 * is the key. Rows with the same key, name and DOB (an export with one row per insurance or address)
 * are merged. Rows without a usable name or date of birth are skipped and counted, never guessed.
 *
 * Nothing here logs names, dates of birth, MRNs or file paths.
 */
export const ROSTER_COLUMNS: Record<string, string[]> = {
  last: ['last', 'lastname', 'lname', 'surname', 'familyname', 'patientlast', 'patientlastname', 'ptlast', 'ptlastname'],
  first: ['first', 'firstname', 'fname', 'givenname', 'patientfirst', 'patientfirstname', 'ptfirst', 'ptfirstname'],
  name: ['name', 'patientname', 'ptname', 'fullname', 'patient'],
  middle: ['middle', 'middlename', 'mi', 'middleinitial', 'mname'],
  dob: ['dob', 'dateofbirth', 'birthdate', 'birthday', 'birthdt', 'patientdob', 'ptdob', 'bdate'],
  mrn: ['mrn', 'medicalrecordnumber', 'medicalrecord', 'medicalrecordno', 'medrecno', 'medrecnum', 'medrec', 'mrnumber', 'mrno', 'patientmrn', 'pmmrn', 'chartnumber', 'chartno'],
  mrn2: ['mrn2', 'secondmrn', 'altmrn', 'alternatemrn', 'othermrn', 'ehrmrn', 'chartmrn', 'patientnumber', 'patientno'],
  chart: ['chartid', 'chartpatientid', 'ehrpatientid', 'ehrid', 'ehrchartid'],
  patientId: ['patientid', 'pmpatientid', 'personid', 'id'],
  phone: ['phone', 'homephone', 'cellphone', 'mobile', 'mobilephone', 'cell', 'workphone', 'phone1', 'phone2', 'phone3', 'primaryphone', 'telephone', 'phonenumber', 'contactphone', 'dayphone', 'eveningphone'],
};
export const ROSTER_REQUIRED = ['last name and first name (or "Patient Name")', 'date of birth', 'MRN'];

export interface RosterPatient {
  /** Patient key: chart ID when the export has one, else the MRN. */
  key: string;
  patientId: string;
  first: string;
  middle: string;
  last: string;
  /** MM/DD/YYYY */
  dob: string;
  mrns: string[];
  phones: string[];
}

export interface RosterStats {
  rows: number;
  patients: number;
  /** Rows without a usable name, DOB or key (counted, never guessed). */
  skipped: number;
  /** Rows folded into an earlier row with the same key, name and DOB. */
  merged: number;
  /** Keys used by two different people (both are kept; the search shows both to staff). */
  key_conflicts: number;
  columns: string[];
}

export class RosterError extends Error {
  constructor(
    readonly code: 'ROSTER_NOT_CONFIGURED' | 'ROSTER_UNAVAILABLE' | 'ROSTER_BAD_HEADER' | 'ROSTER_EMPTY',
    message: string
  ) {
    super(message);
    this.name = 'RosterError';
  }
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** RFC 4180 CSV (quotes, doubled quotes, CR/LF inside quotes) with the given separator. */
export function parseCsv(text: string, sep = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && !cell.trim()) {
      quoted = true;
      cell = '';
    } else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

/** The separator of the header line: the most frequent of , ; tab | outside quotes. */
export function detectSeparator(text: string): string {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, '');
  let best = ',';
  let n = 0;
  for (const sep of [',', ';', '\t', '|']) {
    const k = first.split(sep).length - 1;
    if (k > n) {
      best = sep;
      n = k;
    }
  }
  return best;
}

const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const letters = (s: unknown) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
export const normKey = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '');
const phone10 = (s: unknown) => String(s ?? '').replace(/\D/g, '').slice(-10);
const titleCase = (s: string) => s.trim().toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_, p, c) => p + c.toUpperCase());

/** Date of birth in an export: MM/DD/YYYY, M/D/YY, YYYY-MM-DD, YYYYMMDD, "Mar 14 1961", with or without a time. */
export function rosterDob(raw: string, now: Date = new Date()): string {
  const v = String(raw ?? '').trim();
  const compact = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return normalizeDate(`${compact[1]}-${compact[2]}-${compact[3]}`, { pastOnly: true, now });
  return normalizeDate(v, { pastOnly: true, now });
}

/** Which column holds what (first header that matches each role; every phone-like column). */
export function mapColumns(header: string[]): { cols: Record<string, number>; phones: number[] } {
  const keys = header.map(headerKey);
  const cols: Record<string, number> = {};
  const phones: number[] = [];
  keys.forEach((k, i) => {
    for (const [role, names] of Object.entries(ROSTER_COLUMNS)) {
      if (!names.includes(k)) continue;
      if (role === 'phone') phones.push(i);
      else if (cols[role] === undefined) cols[role] = i;
      break;
    }
  });
  return { cols, phones };
}

/** Parse an export into patients. Throws RosterError (ROSTER_BAD_HEADER, ROSTER_EMPTY). */
export function parseRoster(text: string, now: Date = new Date()): { patients: RosterPatient[]; stats: RosterStats } {
  const rows = parseCsv(text, detectSeparator(text));
  if (!rows.length) throw new RosterError('ROSTER_EMPTY', 'The patient list is empty.');
  const { cols, phones } = mapColumns(rows[0]);
  const hasName = (cols.last !== undefined && cols.first !== undefined) || cols.name !== undefined;
  if (!hasName || cols.dob === undefined || cols.mrn === undefined) {
    const missing = [!hasName && ROSTER_REQUIRED[0], cols.dob === undefined && ROSTER_REQUIRED[1], cols.mrn === undefined && ROSTER_REQUIRED[2]].filter(Boolean);
    throw new RosterError('ROSTER_BAD_HEADER', `The patient list has no column for: ${missing.join(', ')}.`);
  }
  const stats: RosterStats = { rows: rows.length - 1, patients: 0, skipped: 0, merged: 0, key_conflicts: 0, columns: Object.keys(cols).concat(phones.length ? ['phone'] : []).sort() };
  const byKey = new Map<string, RosterPatient[]>();
  const out: RosterPatient[] = [];
  const at = (r: string[], role: string) => (cols[role] === undefined ? '' : String(r[cols[role]] ?? '').trim());
  for (const r of rows.slice(1)) {
    let last = at(r, 'last');
    let first = at(r, 'first');
    let middle = at(r, 'middle');
    if ((!last || !first) && cols.name !== undefined) {
      // "LAST, FIRST M" (the usual export), else "First M Last"
      const full = at(r, 'name').replace(/\s+/g, ' ');
      const comma = full.match(/^([^,]+),\s*(\S+)(?:\s+(.+))?$/);
      const parts = full.split(' ');
      if (comma) [last, first, middle] = [comma[1], comma[2], comma[3] || middle];
      else if (parts.length >= 2) [first, last, middle] = [parts[0], parts[parts.length - 1], parts.slice(1, -1).join(' ') || middle];
    }
    const dob = rosterDob(at(r, 'dob'), now);
    const mrns = [at(r, 'mrn'), at(r, 'mrn2')].filter(Boolean);
    const key = at(r, 'chart') || at(r, 'mrn');
    if (letters(last).length < 1 || letters(first).length < 1 || !dob || !key) {
      stats.skipped++;
      continue;
    }
    const p: RosterPatient = {
      key,
      patientId: at(r, 'patientId'),
      first: titleCase(first),
      middle: titleCase(middle),
      last: titleCase(last),
      dob,
      mrns: [...new Set(mrns)],
      phones: [...new Set(phones.map((i) => phone10(r[i])).filter((x) => x.length === 10))],
    };
    const same = byKey.get(normKey(key)) || [];
    const twin = same.find((q) => letters(q.last) === letters(p.last) && letters(q.first) === letters(p.first) && q.dob === p.dob);
    if (twin) {
      twin.mrns = [...new Set([...twin.mrns, ...p.mrns])];
      twin.phones = [...new Set([...twin.phones, ...p.phones])];
      twin.patientId = twin.patientId || p.patientId;
      stats.merged++;
      continue;
    }
    if (same.length) stats.key_conflicts++;
    same.push(p);
    byKey.set(normKey(key), same);
    out.push(p);
  }
  stats.patients = out.length;
  if (!out.length) throw new RosterError('ROSTER_EMPTY', 'The patient list has no usable rows.');
  return { patients: out, stats };
}

// ── The index ────────────────────────────────────────────────────────────────

/** unity_search_patients-shaped row (see toCandidates in match.ts). */
function toRow(p: RosterPatient): Record<string, unknown> {
  const [home, cell, work] = p.phones;
  const [mrn, patientNumber, chartMrn] = p.mrns;
  return {
    id: p.patientId || p.key,
    patientId: p.patientId,
    chartPatientId: p.key,
    firstName: p.first,
    middleName: p.middle,
    lastName: p.last,
    dateOfBirth: p.dob,
    ...(mrn ? { mrn } : {}),
    ...(patientNumber ? { patientNumber } : {}),
    ...(chartMrn ? { chartMrn } : {}),
    phone: { ...(home ? { home } : {}), ...(cell ? { cell } : {}), ...(work ? { work } : {}) },
  };
}

export class Roster {
  private byDob = new Map<string, RosterPatient[]>();
  private byKey = new Map<string, RosterPatient[]>();

  constructor(
    readonly patients: RosterPatient[],
    readonly stats: RosterStats
  ) {
    for (const p of patients) {
      this.byDob.set(p.dob, [...(this.byDob.get(p.dob) || []), p]);
      this.byKey.set(normKey(p.key), [...(this.byKey.get(normKey(p.key)) || []), p]);
    }
  }

  static fromText(text: string, now?: Date): Roster {
    const { patients, stats } = parseRoster(text, now);
    return new Roster(patients, stats);
  }

  /** The search behind matchPatient: DOB exact, first two letters of first and last name (as the Veradigm® search filters). */
  search(args: { lastName?: string; firstName?: string; dateOfBirth?: string }): { patients: Record<string, unknown>[]; total: number; message: string } {
    const dob = rosterDob(String(args?.dateOfBirth ?? ''));
    const first = letters(args?.firstName).slice(0, 2);
    const last = letters(args?.lastName).slice(0, 2);
    const rows = !dob || !first || !last ? [] : (this.byDob.get(dob) || []).filter((p) => letters(p.first).startsWith(first) && letters(p.last).startsWith(last));
    return { patients: rows.map(toRow), total: rows.length, message: `${rows.length} patient(s) found in the local patient list` };
  }

  /** Patients with this key (normally one). */
  byPatientKey(key: string): RosterPatient[] {
    return this.byKey.get(normKey(key)) || [];
  }

  /** One patient by key, or by MRN when the key is unknown. Null when none or more than one. */
  resolve(id: string): RosterPatient | null {
    const k = normKey(id);
    if (!k) return null;
    const byKey = this.byPatientKey(id);
    if (byKey.length) return byKey.length === 1 ? byKey[0] : null;
    const byMrn = this.patients.filter((p) => p.mrns.some((m) => normKey(m) === k));
    return byMrn.length === 1 ? byMrn[0] : null;
  }

  /**
   * Staff search on the confirm panel: every word must match. A date matches the DOB; digits
   * match an MRN or key exactly, or the end of a phone; letters match the start of the last or first name.
   */
  find(q: string, max = 25): RosterPatient[] {
    const tokens = String(q ?? '').replace(/,/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
    if (!tokens.length) return [];
    const tests = tokens.map((t): ((p: RosterPatient) => boolean) => {
      if (/^\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}$|^\d{8}$/.test(t)) {
        const d = rosterDob(t);
        return (p) => !!d && p.dob === d;
      }
      if (/\d/.test(t)) {
        const k = normKey(t);
        const digits = t.replace(/\D/g, '');
        return (p) => normKey(p.key) === k || p.mrns.some((m) => normKey(m) === k) || (digits.length >= 4 && p.phones.some((ph) => ph.endsWith(digits)));
      }
      const l = letters(t);
      return (p) => !!l && (letters(p.last).startsWith(l) || letters(p.first).startsWith(l));
    });
    return this.patients
      .filter((p) => tests.every((f) => f(p)))
      .sort((a, b) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first) || a.dob.localeCompare(b.dob))
      .slice(0, max);
  }
}

// ── From the environment ─────────────────────────────────────────────────────

export const rosterPath = (): string => String(process.env.INTAKE_ROSTER_CSV || '').trim();

let cached: { path: string; size: number; mtimeMs: number; roster: Roster } | null = null;

/**
 * The roster from INTAKE_ROSTER_CSV, re-read when the file changes. Throws RosterError:
 * ROSTER_NOT_CONFIGURED (unset), ROSTER_UNAVAILABLE (missing or unreadable), ROSTER_BAD_HEADER, ROSTER_EMPTY.
 * A roster that can't be read now is an error even if an older copy was loaded before.
 */
export function loadRoster(file: string = rosterPath()): Roster {
  if (!file) throw new RosterError('ROSTER_NOT_CONFIGURED', 'INTAKE_ROSTER_CSV is not set.');
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    cached = null;
    throw new RosterError('ROSTER_UNAVAILABLE', 'The patient list file is missing or unreadable.');
  }
  if (cached && cached.path === file && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.roster;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    cached = null;
    throw new RosterError('ROSTER_UNAVAILABLE', 'The patient list file is missing or unreadable.');
  }
  cached = null;
  const roster = Roster.fromText(text);
  cached = { path: file, size: st.size, mtimeMs: st.mtimeMs, roster };
  console.log(`[Intake] patient list loaded: ${roster.stats.patients} patient(s), ${roster.stats.skipped} row(s) skipped, ${roster.stats.merged} merged`);
  return roster;
}

type RunTool = (name: string, args: any, ctx?: any) => Promise<any>;

const failure = (code: string, tool: string) => ({ success: false as const, error_code: code, retryable: code === 'ROSTER_UNAVAILABLE', tool, message: code });

/**
 * The patient search matchPatient() should use: the roster when INTAKE_ROSTER_CSV is set, otherwise
 * the given runTool (unity_search_patients, read-only, the normal path once the clinic's Veradigm
 * access exists).
 */
export function patientSearch(runTool: RunTool): RunTool {
  if (!rosterPath()) return runTool;
  return async (name, args) => {
    if (name !== 'unity_search_patients') return failure('UNKNOWN_TOOL', name);
    try {
      return loadRoster().search(args);
    } catch (e) {
      return failure(e instanceof RosterError ? e.code : 'ROSTER_UNAVAILABLE', name);
    }
  };
}
