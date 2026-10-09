/**
 * Small helpers for the outreach module: phone numbers and clinic-local dates/times.
 */

export const clinicTz = () => process.env.CLINIC_TIMEZONE || 'America/Boise';

/** Normalize a US phone number to E.164 (+1XXXXXXXXXX). Returns '' if it is not usable. */
export function toE164(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  // Drop extensions ("x123", "ext. 4").
  const main = s.split(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i)[0];
  const digits = main.replace(/\D/g, '');
  if (main.startsWith('+')) return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : '';
  if (digits.length === 10 && /^[2-9]\d{2}[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1') && /^1[2-9]\d{2}[2-9]/.test(digits)) return `+${digits}`;
  return '';
}

/** Show only the last 4 digits: "•••-•••-1234". */
export function maskPhone(phone: string): string {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 4) return phone ? '••••' : '';
  return `•••-•••-${d.slice(-4)}`;
}

/** Parts of a Date in the clinic timezone. */
export function clinicParts(d: Date): { y: number; m: number; d: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: clinicTz(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: +get('year'), m: +get('month'), d: +get('day'), hour: +get('hour') % 24, minute: +get('minute'), weekday: wd };
}

/** Calendar date (no time) as a UTC-noon Date, safe for day arithmetic. */
export interface CalDate {
  y: number;
  m: number;
  d: number;
}

export function todayInClinic(now: Date = new Date()): CalDate {
  const p = clinicParts(now);
  return { y: p.y, m: p.m, d: p.d };
}

export function addDays(c: CalDate, n: number): CalDate {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export const weekday = (c: CalDate) => new Date(Date.UTC(c.y, c.m - 1, c.d, 12)).getUTCDay();

/** Next Monday–Friday after today (no holiday calendar yet). */
export function nextBusinessDay(now: Date = new Date()): CalDate {
  let c = addDays(todayInClinic(now), 1);
  while (weekday(c) === 0 || weekday(c) === 6) c = addDays(c, 1);
  return c;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** MM/DD/YYYY (the date format Veradigm® PM actions use). */
export const mdy = (c: CalDate) => `${pad(c.m)}/${pad(c.d)}/${c.y}`;

/** YYYY-MM-DD (HTML date inputs). */
export const isoDate = (c: CalDate) => `${c.y}-${pad(c.m)}-${pad(c.d)}`;

/** Parse "YYYY-MM-DD", "MM/DD/YYYY" or "M/D/YYYY[ time]" into a calendar date. */
export function parseDate(s: string): CalDate | null {
  const v = String(s || '').trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid({ y: +m[1], m: +m[2], d: +m[3] });
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return valid({ y: +m[3], m: +m[1], d: +m[2] });
  return null;
}

function valid(c: CalDate): CalDate | null {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d, 12));
  return t.getUTCFullYear() === c.y && t.getUTCMonth() === c.m - 1 && t.getUTCDate() === c.d ? c : null;
}

export const cmpDate = (a: CalDate, b: CalDate) => a.y - b.y || a.m - b.m || a.d - b.d;

/** "Tuesday, October 13" for the agent to say. Falls back to the raw text. */
export function spokenDate(s: string): string {
  const c = parseDate(s);
  if (!c) return s;
  return new Date(Date.UTC(c.y, c.m - 1, c.d, 12)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/** "9:00 AM" from "09:00", "14:30", "9:00 AM", "10/13/2026 09:00:00". Falls back to the raw text. */
export function spokenTime(s: string): string {
  const v = String(s || '').trim();
  const m = v.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (!m) return v;
  let h = +m[1];
  const min = m[2];
  if (m[3]) return `${h % 12 || 12}:${min} ${m[3].toUpperCase()}`;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${min} ${ap}`;
}

/** Split "10/13/2026 09:00 AM" into date and time parts when a row has them in one field. */
export function splitDateTime(s: string): { date: string; time: string } {
  const v = String(s || '').trim();
  const m = v.match(/^(\S+)[ T](.+)$/);
  if (m && parseDate(m[1])) return { date: m[1], time: m[2] };
  return { date: v, time: '' };
}
