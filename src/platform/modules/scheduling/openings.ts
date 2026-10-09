import { UnityErrorCode, UnityErrorHandler, UnityMCPError } from '../../../unity/utils/error-handler';
import { isToolFailure } from '../../../unity/utils/tool-result';
import type { PlatformDeps, ToolContext } from '../../registry';
import { addDays, clinicToday, formatSpokenTime, isMdy, normalizeDate, parseMdy, spokenDay, timeToMinutes, toMdy } from './dates';
import type { Provider } from './scheduling.tools';

/**
 * Staff assistant: "who has an opening Tuesday afternoon?" (deck slides 6 and 9).
 * A small deterministic parser (no LLM) turns the question into a date range, part of day and
 * provider words; open slots come from unity_get_open_slots through deps.runTool so action
 * config, structured errors and the audit trail apply. A failed lookup is thrown, never "no openings".
 */

export type PartOfDay = 'morning' | 'afternoon' | 'any';

export interface OpeningsQuery {
  startDate: string; // MM/DD/YYYY
  endDate: string; // MM/DD/YYYY
  partOfDay: PartOfDay;
  /** Only these dates (MM/DD/YYYY) when the question named specific days. */
  dates?: string[];
  /** Words that may be a provider name ("lee" from "Dr. Lee"). */
  providerTerms: string[];
  /** The question explicitly pointed at a provider ("Dr.", "doctor", "provider"). */
  providerCue: boolean;
  /** Human label for messages: "Tuesday 10/13 afternoon", "next week". */
  label: string;
}

const MORNING_END = 12 * 60;
const AFTERNOON_END = 17 * 60;

const WEEKDAY_WORDS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

const STOPWORDS = new Set(
  (
    'who whos has have having had any anyone anybody someone somebody an a the opening openings open opens slot slots spot spots ' +
    'availability available avail appointment appointments appt appts for with on in at of is are was be there does do did what ' +
    'when which where how many much free time times me find show get see can could would will i we us our my your book schedule ' +
    'need needs want wants like please and or between from to until thru through earliest first soonest soon asap possible ' +
    'anything something left still room this that day days week weeks weekday weekdays provider providers doctor doctors dr ' +
    'new established patient patients follow up followup visit visits consult consultation check checkup physical quick short ' +
    'long minute minutes hour hours min mins all every each about around after before early late noon lunch midday o clock ' +
    'let know tell them they he she it its next coming upcoming rest also too either both else other than more most just only ' +
    'today tomorrow tmrw tonight morning mornings afternoon afternoons am pm evening evenings np pa md'
  ).split(/\s+/)
);

const PROVIDER_CUES = new Set(['dr', 'doctor', 'provider', 'np', 'pa']);
const CREDENTIALS = new Set(['md', 'do', 'np', 'pa', 'pac', 'dr', 'rn', 'fnp', 'aprn', 'dnp', 'phd', 'mph', 'facp', 'jr', 'sr']);

function mondayOf(d: Date): Date {
  return addDays(d, -((d.getUTCDay() + 6) % 7));
}

/** Next occurrence of a weekday on or after `from`. */
function upcoming(from: Date, wd: number): Date {
  return addDays(from, (wd - from.getUTCDay() + 7) % 7);
}

/**
 * Parse a staff question into a search. `today` is the clinic's calendar day (UTC midnight).
 *
 *  - today / tomorrow / MM/DD[/YYYY]
 *  - weekday names ("Tuesday" = the next Tuesday, today included; "next Tuesday" = Tuesday of next week)
 *  - "this week" (today through Friday) / "next week" (Monday-Friday of next week; with a weekday, that day next week)
 *  - morning (before 12:00, also "AM", "before noon") / afternoon (12:00-17:00, also "PM", "after lunch", "evening")
 *  - nothing about dates → the next 7 days
 *  - leftover words are provider name candidates, matched later against unity_get_providers
 */
export function parseOpeningsQuestion(question: string, today: Date): OpeningsQuery {
  const text = String(question || '')
    .toLowerCase()
    .replace(/\ba\.\s?m\.?/g, ' am ')
    .replace(/\bp\.\s?m\.?/g, ' pm ')
    .replace(/[^a-z0-9/\s]/g, ' ');
  const tokens = text.split(/\s+/).filter(Boolean);

  const days: Date[] = [];
  const weekdays: Array<{ wd: number; next: boolean }> = [];
  let nextWeek = false;
  let thisWeek = false;
  let morning = false;
  let afternoon = false;
  let providerCue = false;
  const providerTerms: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1] || '';

    const date = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
    if (date) {
      let y = date[3] ? +date[3] : today.getUTCFullYear();
      if (y < 100) y += 2000;
      let d = parseMdy(`${date[1]}/${date[2]}/${y}`);
      // No year and already past → next year.
      if (d && !date[3] && d < today) d = parseMdy(`${date[1]}/${date[2]}/${y + 1}`);
      if (d) days.push(d);
      continue;
    }
    if (t === 'today' || t === 'tonight') days.push(today);
    else if (t === 'tomorrow' || t === 'tmrw') days.push(addDays(today, 1));
    else if (t === 'week' && (prev === 'next' || prev === 'coming')) nextWeek = true;
    else if (t === 'week' && (prev === 'this' || prev === 'the')) thisWeek = true;
    else if (WEEKDAY_WORDS[t.replace(/s$/, '')] !== undefined || WEEKDAY_WORDS[t] !== undefined) {
      const wd = WEEKDAY_WORDS[t] ?? WEEKDAY_WORDS[t.replace(/s$/, '')];
      weekdays.push({ wd, next: prev === 'next' });
    } else if (t === 'morning' || t === 'mornings' || t === 'am' || (t === 'noon' && prev === 'before')) morning = true;
    else if (
      t === 'afternoon' ||
      t === 'afternoons' ||
      t === 'pm' ||
      ((t === 'noon' || t === 'lunch') && prev === 'after') ||
      (t === 'evening' || t === 'evenings')
    )
      afternoon = true;
    else if (PROVIDER_CUES.has(t)) providerCue = true;
    else if (!STOPWORDS.has(t) && /^[a-z][a-z'-]+$/.test(t)) providerTerms.push(t);
  }

  // Resolve weekdays to dates.
  for (const { wd, next } of weekdays) {
    if (nextWeek || next) days.push(addDays(mondayOf(today), 7 + ((wd + 6) % 7)));
    else days.push(upcoming(today, wd));
  }

  let start: Date;
  let end: Date;
  let dates: string[] | undefined;
  let label: string;
  if (days.length) {
    const uniq = [...new Map(days.map((d) => [d.getTime(), d])).values()].sort((a, b) => a.getTime() - b.getTime());
    start = uniq[0];
    end = uniq[uniq.length - 1];
    dates = uniq.map(toMdy);
    label = uniq
      .map((d) => (d.getTime() === today.getTime() ? 'today' : d.getTime() === addDays(today, 1).getTime() ? 'tomorrow' : spokenDay(toMdy(d))))
      .join(' and ');
  } else if (nextWeek) {
    start = addDays(mondayOf(today), 7);
    end = addDays(start, 4);
    label = 'next week';
  } else if (thisWeek) {
    start = today;
    const friday = addDays(mondayOf(today), 4);
    end = friday < today ? today : friday;
    label = 'this week';
  } else {
    start = today;
    end = addDays(today, 6);
    label = 'in the next 7 days';
  }

  const partOfDay: PartOfDay = morning && !afternoon ? 'morning' : afternoon && !morning ? 'afternoon' : 'any';
  if (partOfDay !== 'any') label += ` ${partOfDay}`;
  return { startDate: toMdy(start), endDate: toMdy(end), partOfDay, dates, providerTerms, providerCue, label };
}

/** Name words for matching ("Lee, Andrew MD" → ["lee", "andrew"]). */
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !CREDENTIALS.has(w));
}

/** Providers whose name contains one of the terms (exact word, or a prefix of 3+ letters). */
export function matchProviders(terms: string[], providers: Provider[]): Provider[] {
  if (!terms.length) return [];
  return providers.filter((p) => {
    const words = nameTokens(p.name);
    return terms.some((t) => words.some((w) => w === t || (t.length >= 3 && w.startsWith(t))));
  });
}

export function inPartOfDay(minutes: number | null, part: PartOfDay): boolean {
  if (part === 'any') return true;
  if (minutes === null) return false;
  return part === 'morning' ? minutes < MORNING_END : minutes >= MORNING_END && minutes < AFTERNOON_END;
}

export interface OpenSlot {
  date: string;
  time: string;
  duration?: number;
  providerId?: string;
  locationId?: string;
}

export interface Opening {
  date: string;
  time: string;
  minutes: number | null;
  duration: number;
  locationId?: string;
}

export interface ProviderOpenings {
  providerId: string;
  providerName: string;
  count: number;
  slots: Opening[];
}

/** Filter slots by part of day / dates / providers and group them by provider, earliest first. */
export function groupOpenings(
  slots: OpenSlot[],
  opts: { partOfDay: PartOfDay; dates?: string[]; providerIds?: string[]; providers?: Provider[] }
): { groups: ProviderOpenings[]; skippedNoTime: number } {
  const names = new Map((opts.providers || []).map((p) => [p.id, p.name]));
  const dateSet = opts.dates?.length ? new Set(opts.dates) : null;
  const providerSet = opts.providerIds?.length ? new Set(opts.providerIds) : null;
  const groups = new Map<string, ProviderOpenings>();
  let skippedNoTime = 0;

  for (const s of slots) {
    const date = normalizeDate(s.date) || normalizeDate(s.time) || s.date;
    const minutes = timeToMinutes(s.time);
    if (dateSet && !dateSet.has(date)) continue;
    const pid = String(s.providerId || '');
    if (providerSet && !providerSet.has(pid)) continue;
    if (opts.partOfDay !== 'any' && minutes === null) {
      skippedNoTime++;
      continue;
    }
    if (!inPartOfDay(minutes, opts.partOfDay)) continue;
    const key = pid || '_';
    if (!groups.has(key)) {
      groups.set(key, {
        providerId: pid,
        providerName: names.get(pid) || (pid ? `Provider ${pid}` : 'Any provider'),
        count: 0,
        slots: [],
      });
    }
    const g = groups.get(key)!;
    g.slots.push({ date, time: formatSpokenTime(minutes, s.time), minutes, duration: s.duration || 0, locationId: s.locationId });
    g.count++;
  }

  const sortKey = (o: Opening) => `${(parseMdy(o.date)?.getTime() ?? 0).toString().padStart(15, '0')}${String(o.minutes ?? 9999).padStart(4, '0')}`;
  const out = [...groups.values()];
  for (const g of out) g.slots.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  out.sort((a, b) => sortKey(a.slots[0]).localeCompare(sortKey(b.slots[0])) || a.providerName.localeCompare(b.providerName));
  return { groups: out, skippedNoTime };
}

/** Short speakable summary. */
export function openingsMessage(groups: ProviderOpenings[], label: string, multiDay: boolean): string {
  const total = groups.reduce((n, g) => n + g.count, 0);
  if (total === 0) return `No openings ${label}.`;
  const parts = groups.slice(0, 4).map((g) => {
    const first = g.slots[0];
    const when = `${multiDay ? `${spokenDay(first.date)} ` : ''}${first.time}`;
    return g.count === 1 ? `${g.providerName} has one at ${when}` : `${g.providerName} has ${g.count}, first at ${when}`;
  });
  const more = groups.length > 4 ? `, and ${groups.length - 4} more providers` : '';
  return `${total} opening${total === 1 ? '' : 's'} ${label}: ${parts.join('; ')}${more}.`;
}

export interface FindOpeningsArgs {
  question?: string;
  startDate?: string;
  endDate?: string;
  partOfDay?: PartOfDay;
  providerId?: string;
  /** Testing only: clinic "today" as MM/DD/YYYY. */
  today?: string;
}

/** Re-throw a structured tool failure so the platform returns the same error_code. */
function rethrow(result: any): never {
  throw new UnityMCPError(result.message || `${result.tool} failed`, result.error_code as UnityErrorCode, undefined, result.tool);
}

export async function findOpenings(deps: Pick<PlatformDeps, 'runTool'>, args: FindOpeningsArgs, ctx: ToolContext = {}) {
  const today = (args?.today && parseMdy(args.today)) || clinicToday();
  const question = String(args?.question || '').trim();
  const q = parseOpeningsQuestion(question, today);

  // Structured fields override what the question said.
  if (args?.startDate) {
    if (!isMdy(args.startDate)) throw UnityErrorHandler.createValidationError('startDate must be MM/DD/YYYY');
    q.startDate = args.startDate;
    q.dates = undefined;
    q.label = args.endDate && args.endDate !== args.startDate ? `${args.startDate} to ${args.endDate}` : spokenDay(args.startDate);
    q.endDate = args.endDate || args.startDate;
  }
  if (args?.endDate) {
    if (!isMdy(args.endDate)) throw UnityErrorHandler.createValidationError('endDate must be MM/DD/YYYY');
    q.endDate = args.endDate;
    if (!args.startDate) {
      q.dates = undefined;
      q.label = `${q.startDate} to ${q.endDate}`;
    }
  }
  if (parseMdy(q.endDate)! < parseMdy(q.startDate)!) throw UnityErrorHandler.createValidationError('endDate is before startDate');
  if (args?.partOfDay && args.partOfDay !== q.partOfDay) {
    if (!['morning', 'afternoon', 'any'].includes(args.partOfDay)) {
      throw UnityErrorHandler.createValidationError("partOfDay must be 'morning', 'afternoon' or 'any'");
    }
    q.label = q.label.replace(/ (morning|afternoon)$/, '') + (args.partOfDay === 'any' ? '' : ` ${args.partOfDay}`);
    q.partOfDay = args.partOfDay;
  }

  // Providers: names for grouping and for matching "Dr. Lee".
  const explicitProvider = String(args?.providerId || '').trim();
  const needMatch = !explicitProvider && q.providerTerms.length > 0;
  const prov = await deps.runTool('unity_get_providers', {}, ctx);
  let providers: Provider[] = [];
  let providerNamesUnavailable = false;
  if (isToolFailure(prov)) {
    // Can't tell who "Dr. Lee" is without the list: fail rather than answer for everyone.
    if (needMatch && q.providerCue) rethrow(prov);
    providerNamesUnavailable = true;
  } else {
    providers = prov.providers || [];
  }

  let providerIds: string[] | undefined;
  if (explicitProvider) {
    providerIds = [explicitProvider];
  } else if (needMatch && !providerNamesUnavailable) {
    const matched = matchProviders(q.providerTerms, providers);
    if (matched.length) {
      providerIds = matched.map((p) => p.id);
      q.label = `for ${matched.map((p) => p.name).join(' or ')} ${q.label}`;
    } else if (q.providerCue) {
      // Genuine "no such provider" from a successful lookup; not a Veradigm failure.
      return {
        success: false as const,
        reason: 'provider_not_found',
        query: q,
        message: `I couldn't find a provider named ${q.providerTerms.join(' ')}. Ask for the provider's last name.`,
      };
    }
  }
  // Provider list unavailable and no "Dr." cue: leftover words are probably not a name; search everyone.

  const slotArgs: Record<string, string> = { startDate: q.startDate, endDate: q.endDate };
  if (providerIds?.length === 1) slotArgs.providerId = providerIds[0];
  const res = await deps.runTool('unity_get_open_slots', slotArgs, ctx);
  if (isToolFailure(res)) rethrow(res);
  if (!res || !Array.isArray(res.slots)) {
    throw UnityErrorHandler.createAPIError('Open slot lookup returned no slot list', 'unity_get_open_slots');
  }

  const { groups, skippedNoTime } = groupOpenings(res.slots, { partOfDay: q.partOfDay, dates: q.dates, providerIds, providers });
  const total = groups.reduce((n, g) => n + g.count, 0);
  return {
    success: true as const,
    query: {
      question: question || undefined,
      startDate: q.startDate,
      endDate: q.endDate,
      partOfDay: q.partOfDay,
      dates: q.dates,
      providerIds,
      label: q.label,
    },
    openings: groups,
    total,
    skippedNoTime: skippedNoTime || undefined,
    providerNamesUnavailable: providerNamesUnavailable || undefined,
    message: openingsMessage(groups, q.label, q.startDate !== q.endDate),
  };
}
