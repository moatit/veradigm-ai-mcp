import { CallMode } from './call-records';

/**
 * After-hours mode (spec §5): on by schedule, with a manual override for the demo.
 *
 *   CLINIC_TIMEZONE=America/Boise
 *   CLINIC_HOURS=Mon-Fri 08:00-17:00        business hours; anything else is after hours
 *
 * The override is set from the on-call notebook ("Switch to after-hours") and lasts until
 * cleared or the process restarts.
 */
let override: CallMode | null = null;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseHours(spec: string): { days: Set<number>; open: number; close: number } {
  const m = spec.match(/^(\w{3})-(\w{3})\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return { days: new Set([1, 2, 3, 4, 5]), open: 8 * 60, close: 17 * 60 };
  const from = DAYS.indexOf(m[1]);
  const to = DAYS.indexOf(m[2]);
  const days = new Set<number>();
  for (let d = from; d !== (to + 1) % 7; d = (d + 1) % 7) days.add(d);
  return { days, open: +m[3] * 60 + +m[4], close: +m[5] * 60 + +m[6] };
}

export function scheduledMode(now = new Date()): CallMode {
  const tz = process.env.CLINIC_TIMEZONE || 'America/Boise';
  const { days, open, close } = parseHours(process.env.CLINIC_HOURS || 'Mon-Fri 08:00-17:00');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const day = DAYS.indexOf(get('weekday'));
  const minutes = +get('hour') * 60 + +get('minute');
  return days.has(day) && minutes >= open && minutes < close ? 'business_hours' : 'after_hours';
}

export function currentMode(): CallMode {
  return override || scheduledMode();
}

export function getOverride(): CallMode | null {
  return override;
}

export function setOverride(mode: CallMode | null): void {
  override = mode;
}
