/**
 * Date/time helpers for the huddle module. Dates are carried as clinic-local "YYYY-MM-DD" keys;
 * Veradigm® PM gets MM/DD/YYYY. Times from Veradigm are clinic-local wall-clock strings.
 */
export const clinicTz = (): string => process.env.CLINIC_TIMEZONE || 'America/Boise';

/** "YYYY-MM-DD" + n days (calendar arithmetic, no timezone involved). */
export function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today's date (plus offset days) in the clinic timezone, as "YYYY-MM-DD". */
export function clinicDateKey(now: Date = new Date(), offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: clinicTz(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const key = `${get('year')}-${get('month')}-${get('day')}`;
  return offsetDays ? addDays(key, offsetDays) : key;
}

/** Minutes since midnight right now in the clinic timezone. */
export function clinicMinutesNow(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: clinicTz(),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  return get('hour') * 60 + get('minute');
}

/**
 * Read a calendar date from the start of a string: "YYYY-MM-DD…", "MM/DD/YYYY…" or "M/D/YYYY…".
 * Returns "YYYY-MM-DD", or null when there's no valid date.
 */
export function parseDateKey(input: unknown): string | null {
  const s = String(input ?? '').trim();
  let y: number, mo: number, d: number;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) [y, mo, d] = [+m[3], +m[1], +m[2]];
  else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, 12));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** User/agent date input → "YYYY-MM-DD". Empty / "today" / "tomorrow" / "yesterday" are clinic-relative. */
export function normalizeDate(input: unknown, now: Date = new Date()): string | null {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s || s === 'today') return clinicDateKey(now);
  if (s === 'tomorrow') return clinicDateKey(now, 1);
  if (s === 'yesterday') return clinicDateKey(now, -1);
  return parseDateKey(s);
}

/** "YYYY-MM-DD" → "MM/DD/YYYY" (Veradigm® PM convention). */
export function toUnityDate(key: string): string {
  const [y, m, d] = key.split('-');
  return `${m}/${d}/${y}`;
}

/** "Thursday, October 8, 2026" (or without the year). */
export function dateLabel(key: string, withYear = true): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/**
 * Clock time out of a Veradigm field: "09:00", "9:00 AM", "10/08/2026 09:00:00 AM", "2026-10-08T14:30:00".
 * Returns minutes since midnight, or null.
 */
export function parseClock(input: unknown): number | null {
  const m = String(input ?? '').match(/(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*([AaPp])?\.?[Mm]?\.?/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'P' && h < 12) h += 12;
  if (ap === 'A' && h === 12) h = 0;
  return h * 60 + min;
}

/** Minutes since midnight → "9:05 AM". */
export function clockLabel(minutes: number | null): string {
  if (minutes === null || minutes === undefined) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
