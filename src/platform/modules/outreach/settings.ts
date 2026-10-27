import * as fs from 'fs';
import * as path from 'path';
import { toE164 } from './util';

/**
 * Call & Confirm settings, one object per practice. The admin portal builds against this exact
 * shape (GET/PUT /api/outreach/settings), so field names and nesting must not change.
 *
 * Stored in $CALL_RECORDS_DIR/outreach-settings.json as { practices: { <id>: settings } } (mode 0600).
 * The practice is OUTREACH_PRACTICE_ID (default "default"). Numbers in test_allowlist are E.164.
 *
 * mode "live" is refused unless OUTBOUND_ENABLED=true and the allowlist (test_allowlist or
 * OUTBOUND_ALLOWLIST) is set; the dialer checks it again before every call.
 */
export interface AttemptByDaysBefore {
  days_before: number;
  window: string;
}
export interface AttemptByOffset {
  day_offset: number;
  window: string;
}

export interface CallConfirmSettings {
  enabled: boolean;
  mode: 'dry_run' | 'live';
  call_types: { confirm: boolean; no_show: boolean; recall: boolean };
  confirm: { attempts: AttemptByDaysBefore[] };
  no_show: { attempts: AttemptByOffset[] };
  recall: { attempts: AttemptByOffset[] };
  limits: {
    max_per_day: number;
    max_per_7_days: number;
    calling_hours: string;
    weekdays_only: boolean;
    /** YYYY-MM-DD */
    holidays: string[];
  };
  voicemail: 'last_attempt' | 'never';
  approval: 'daily_list';
  test_allowlist: string[];
}

export function defaultSettings(): CallConfirmSettings {
  return {
    enabled: false,
    mode: 'dry_run',
    call_types: { confirm: true, no_show: true, recall: true },
    confirm: {
      attempts: [
        { days_before: 3, window: '10:00-11:30' },
        { days_before: 2, window: '15:00-16:30' },
        { days_before: 1, window: '17:00-18:30' },
      ],
    },
    no_show: {
      attempts: [
        { day_offset: 0, window: '14:00-16:00' },
        { day_offset: 1, window: '10:00-11:30' },
      ],
    },
    recall: {
      attempts: [
        { day_offset: 0, window: '10:00-11:30' },
        { day_offset: 3, window: '15:00-16:30' },
        { day_offset: 7, window: '17:00-18:30' },
      ],
    },
    limits: {
      max_per_day: 1,
      max_per_7_days: 3,
      calling_hours: '09:00-19:00',
      weekdays_only: true,
      holidays: [],
    },
    voicemail: 'last_attempt',
    approval: 'daily_list',
    test_allowlist: [],
  };
}

/** "HH:MM-HH:MM" → minutes from midnight; null when malformed or empty. */
export function parseWindow(w: string): { start: number; end: number } | null {
  const m = String(w || '').trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const start = +m[1] * 60 + +m[2];
  const end = +m[3] * 60 + +m[4];
  if (+m[1] > 23 || +m[3] > 24 || +m[2] > 59 || +m[4] > 59 || end <= start) return null;
  return { start, end };
}

/** TCPA healthcare-exemption ceilings: settings may lower these, never raise them. */
export const HARD_LIMITS = { max_per_day: 1, max_per_7_days: 3, max_attempts: 3, earliest: 8 * 60, latest: 21 * 60 };

const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SettingsCheck {
  ok: boolean;
  errors: string[];
  settings?: CallConfirmSettings;
}

/**
 * Validate a full settings object (the PUT body). Unknown fields are refused so a typo can't silently
 * fall back to a default. Returns a normalized copy (allowlist numbers in E.164).
 */
export function validateSettings(input: any, env: NodeJS.ProcessEnv = process.env): SettingsCheck {
  const errors: string[] = [];
  const s = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!s) return { ok: false, errors: ['Settings must be a JSON object'] };
  const keys = ['enabled', 'mode', 'call_types', 'confirm', 'no_show', 'recall', 'limits', 'voicemail', 'approval', 'test_allowlist'];
  for (const k of Object.keys(s)) if (!keys.includes(k)) errors.push(`Unknown field "${k}"`);
  for (const k of keys) if (!(k in s)) errors.push(`Missing field "${k}"`);
  if (errors.length) return { ok: false, errors };

  if (typeof s.enabled !== 'boolean') errors.push('enabled must be true or false');
  if (s.mode !== 'dry_run' && s.mode !== 'live') errors.push('mode must be "dry_run" or "live"');
  const ct = s.call_types || {};
  for (const t of ['confirm', 'no_show', 'recall']) if (typeof ct[t] !== 'boolean') errors.push(`call_types.${t} must be true or false`);
  if (Object.keys(ct).some((k) => !['confirm', 'no_show', 'recall'].includes(k))) errors.push('call_types has an unknown type');

  const lim = s.limits || {};
  const hours = parseWindow(lim.calling_hours);
  if (!hours) errors.push('limits.calling_hours must be "HH:MM-HH:MM"');
  else if (hours.start < HARD_LIMITS.earliest || hours.end > HARD_LIMITS.latest) errors.push('limits.calling_hours must stay between 08:00 and 21:00');
  if (!isInt(lim.max_per_day, 1, HARD_LIMITS.max_per_day)) errors.push(`limits.max_per_day must be 1 to ${HARD_LIMITS.max_per_day}`);
  if (!isInt(lim.max_per_7_days, 1, HARD_LIMITS.max_per_7_days)) errors.push(`limits.max_per_7_days must be 1 to ${HARD_LIMITS.max_per_7_days}`);
  if (typeof lim.weekdays_only !== 'boolean') errors.push('limits.weekdays_only must be true or false');
  if (!Array.isArray(lim.holidays) || lim.holidays.some((h: unknown) => typeof h !== 'string' || !DATE_RE.test(h))) {
    errors.push('limits.holidays must be a list of YYYY-MM-DD dates');
  }

  const checkAttempts = (name: string, list: any, field: 'days_before' | 'day_offset', min: number, max: number) => {
    if (!Array.isArray(list) || list.length < 1 || list.length > HARD_LIMITS.max_attempts) {
      errors.push(`${name}.attempts must list 1 to ${HARD_LIMITS.max_attempts} attempts`);
      return;
    }
    let prev: number | null = null;
    list.forEach((a: any, i: number) => {
      const w = parseWindow(a?.window);
      if (!isInt(a?.[field], min, max)) errors.push(`${name}.attempts[${i}].${field} must be ${min} to ${max}`);
      if (!w) errors.push(`${name}.attempts[${i}].window must be "HH:MM-HH:MM"`);
      else if (hours && (w.start < hours.start || w.end > hours.end)) errors.push(`${name}.attempts[${i}].window must be inside calling hours ${lim.calling_hours}`);
      if (prev !== null && isInt(a?.[field], min, max)) {
        // Attempts run in order: days_before counts down, day_offset counts up, and never two on one day.
        if (field === 'days_before' ? a[field] >= prev : a[field] <= prev) errors.push(`${name}.attempts must be on different days, in order`);
      }
      if (isInt(a?.[field], min, max)) prev = a[field];
    });
  };
  checkAttempts('confirm', s.confirm?.attempts, 'days_before', 1, 10);
  checkAttempts('no_show', s.no_show?.attempts, 'day_offset', 0, 10);
  checkAttempts('recall', s.recall?.attempts, 'day_offset', 0, 30);

  if (s.voicemail !== 'last_attempt' && s.voicemail !== 'never') errors.push('voicemail must be "last_attempt" or "never"');
  if (s.approval !== 'daily_list') errors.push('approval must be "daily_list"');
  let allow: string[] = [];
  if (!Array.isArray(s.test_allowlist)) errors.push('test_allowlist must be a list of phone numbers');
  else {
    allow = s.test_allowlist.map((n: unknown) => toE164(String(n)));
    if (allow.some((n) => !n)) errors.push('test_allowlist has a number that is not a valid US phone number');
  }

  if (s.mode === 'live') {
    if (env.OUTBOUND_ENABLED !== 'true') errors.push('mode "live" is refused: OUTBOUND_ENABLED is not true on this server');
    if (!allow.length && !envAllowlist(env).length) errors.push('mode "live" is refused: the test allowlist is empty');
  }
  if (errors.length) return { ok: false, errors };

  const settings: CallConfirmSettings = {
    enabled: s.enabled,
    mode: s.mode,
    call_types: { confirm: ct.confirm, no_show: ct.no_show, recall: ct.recall },
    confirm: { attempts: s.confirm.attempts.map((a: any) => ({ days_before: a.days_before, window: normWindow(a.window) })) },
    no_show: { attempts: s.no_show.attempts.map((a: any) => ({ day_offset: a.day_offset, window: normWindow(a.window) })) },
    recall: { attempts: s.recall.attempts.map((a: any) => ({ day_offset: a.day_offset, window: normWindow(a.window) })) },
    limits: {
      max_per_day: lim.max_per_day,
      max_per_7_days: lim.max_per_7_days,
      calling_hours: normWindow(lim.calling_hours),
      weekdays_only: lim.weekdays_only,
      holidays: [...new Set<string>(lim.holidays)].sort(),
    },
    voicemail: s.voicemail,
    approval: 'daily_list',
    test_allowlist: [...new Set(allow)],
  };
  return { ok: true, errors: [], settings };
}

const pad = (n: number) => String(n).padStart(2, '0');
function normWindow(w: string): string {
  const p = parseWindow(w)!;
  const f = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return `${f(p.start)}-${f(p.end)}`;
}

/** OUTBOUND_ALLOWLIST (comma-separated) in E.164. */
export function envAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.OUTBOUND_ALLOWLIST || '')
    .split(',')
    .map((s) => toE164(s) || s.trim())
    .filter(Boolean);
}

// ---- Per-practice file store ----

export const practiceId = () => String(process.env.OUTREACH_PRACTICE_ID || 'default').trim() || 'default';
const dir = () => process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data');
const file = () => path.join(dir(), 'outreach-settings.json');

function readAll(): Record<string, CallConfirmSettings> {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return data && typeof data.practices === 'object' ? data.practices : {};
  } catch {
    return {};
  }
}

/**
 * Settings for one practice. A stored object that no longer validates (for example mode "live" after
 * OUTBOUND_ENABLED was turned off) falls back to dry run, never to live.
 */
export function loadSettings(practice: string = practiceId()): CallConfirmSettings {
  const stored = readAll()[practice];
  if (!stored) return defaultSettings();
  const check = validateSettings(stored);
  if (check.ok) return check.settings!;
  const relaxed = validateSettings({ ...stored, mode: 'dry_run' });
  return relaxed.ok ? relaxed.settings! : defaultSettings();
}

export function saveSettings(input: unknown, practice: string = practiceId()): SettingsCheck {
  const check = validateSettings(input);
  if (!check.ok) return check;
  const all = readAll();
  all[practice] = check.settings!;
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ practices: all }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
  return check;
}
