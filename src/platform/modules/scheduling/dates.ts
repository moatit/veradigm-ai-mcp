/**
 * Calendar-day and clock helpers for scheduling. Calendar days are Date objects at UTC midnight
 * so arithmetic never shifts across DST; "today" is taken in CLINIC_TIMEZONE.
 */

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function day(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * 86_400_000);
}

/** Today's calendar day in the clinic's timezone. */
export function clinicToday(now: Date = new Date()): Date {
  const tz = process.env.CLINIC_TIMEZONE || 'America/Boise';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return day(get('year'), get('month'), get('day'));
}

export function toMdy(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${date.getUTCFullYear()}`;
}

export function isMdy(s: unknown): s is string {
  return typeof s === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(s.trim()) && !!parseMdy(s);
}

/** "10/13/2026" → calendar day (null if not a real date). */
export function parseMdy(s: string): Date | null {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = day(+m[3], +m[1], +m[2]);
  return d.getUTCMonth() === +m[1] - 1 && d.getUTCDate() === +m[2] ? d : null;
}

/** Pull a date out of any common Veradigm shape ("10/13/2026 9:00 AM", "2026-10-13T09:00:00") → MM/DD/YYYY or ''. */
export function normalizeDate(raw: string): string {
  if (!raw) return '';
  let m = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return toMdy(day(+m[3], +m[1], +m[2]));
  m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return toMdy(day(+m[1], +m[2], +m[3]));
  return '';
}

/** Minutes after midnight from "13:30", "1:30 PM", "9 AM", "0930", "2026-10-13T13:30:00" (null if no time). */
export function timeToMinutes(raw: string): number | null {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*([ap])?\.?\s*m?\b/i);
  if (!m) m = s.match(/\b(\d{1,2})()\s*([ap])\.?\s*m\b/i);
  if (m) {
    let h = +m[1];
    const min = m[2] ? +m[2] : 0;
    const ap = (m[3] || '').toLowerCase();
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    return h < 24 && min < 60 ? h * 60 + min : null;
  }
  m = s.match(/^(\d{1,2})(\d{2})$/);
  if (m && +m[1] < 24 && +m[2] < 60) return +m[1] * 60 + +m[2];
  return null;
}

/** 780 → "1:00 PM". */
export function formatSpokenTime(minutes: number | null, fallback = ''): string {
  if (minutes === null) return fallback;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "10/13/2026" → "Tuesday 10/13". */
export function spokenDay(mdy: string): string {
  const d = parseMdy(mdy);
  return d ? `${WEEKDAYS[d.getUTCDay()]} ${mdy.slice(0, 5)}` : mdy;
}
