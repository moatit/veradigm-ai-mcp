import { UnityActions } from '../../../unity/config/unity-endpoints';
import { UnityErrorHandler, UnityMCPError } from '../../../unity/utils/error-handler';
import { isToolFailure, toToolFailure } from '../../../unity/utils/tool-result';
import { pick, unityRows } from '../../../unity/utils/unity-rows';
import type { PlatformDeps } from '../../registry';
import { clockLabel, dateLabel, money, normalizeDate, parseClock, parseDateKey, toUnityDate } from './dates';

/**
 * Morning huddle brief (deck slide 9).
 *
 * 1. GetSchedule (Veradigm® PM) for one clinic date → the day's visits.
 * 2. Each patient is enriched through deps.runTool (same path as the phone agent, so structured
 *    errors and audit apply): balance, insurance, allergies, problems.
 * 3. A failed enrichment is recorded as "couldn't check", never as "none" (CLAUDE.md rule 5).
 *
 * If GetSchedule itself fails the builder throws; callers show "Couldn't reach Veradigm PM".
 * Read only. Logs carry the date, counts and error codes, never patient names or IDs.
 */

export type Check<T> = { ok: true; value: T } | { ok: false; code: string };

export type FlagTone = 'urgent' | 'warn' | 'ok' | 'info' | 'unknown';
export interface HuddleFlag {
  key: string;
  label: string;
  tone: FlagTone;
}

export interface ScheduledVisit {
  appointmentId: string;
  patientId: string;
  patientName: string;
  minutes: number | null;
  time: string;
  provider: string;
  visitType: string;
  status: string;
  location: string;
  /** true/false when the schedule row says so (or the visit type is a "new patient" type); null = unknown. */
  newPatient: boolean | null;
}

export interface HuddleVisit extends ScheduledVisit {
  balance: Check<number>;
  insurance: Check<{ carrier: string; policies: number }>;
  allergies: Check<number>;
  problems: Check<number>;
  flags: HuddleFlag[];
}

export interface HuddleSummary {
  visits: number;
  providers: number;
  patients: number;
  /** Patients with a balance due > 0. */
  balancesDue: number;
  /** Patients whose insurance lookup succeeded and returned no policy. */
  missingInsurance: number;
  allergiesOnFile: number;
  newPatients: number;
  /** Individual checks (balance/insurance/allergies/problems per patient) that couldn't be completed. */
  failedChecks: number;
  patientsWithFailedChecks: number;
}

export interface HuddleBrief {
  date: string; // YYYY-MM-DD (clinic local)
  dateLabel: string;
  generatedAt: string;
  fromCache: boolean;
  /** The time budget ran out before every check finished (unfinished checks show "couldn't check"). */
  timedOut: boolean;
  summary: HuddleSummary;
  providers: Array<{ name: string; visits: HuddleVisit[] }>;
}

export interface HuddleOptions {
  now?: () => number;
  concurrency?: number;
  /** Total time budget for one brief's enrichment calls. */
  budgetMs?: number;
  cacheMs?: number;
  /** Cache lifetime for a brief that has failed checks (so a retry soon after picks up a recovered Veradigm). */
  cacheFailedMs?: number;
}

export const UNASSIGNED_PROVIDER = 'Provider not listed';
const CANCELLED = /cancel|no[\s-]?show|deleted|bumped|rescheduled/i;

const yesNo = (v: string): boolean | null => (/^(y|yes|true|1)$/i.test(v) ? true : /^(n|no|false|0)$/i.test(v) ? false : null);

/**
 * GetSchedule rows → visits for one date. Field names vary by product/version, so each value is
 * read from several candidates (case-insensitive). Rows without a patient (blocks, lunch, holds)
 * and cancelled visits are dropped. When a row carries a date that isn't `dateKey` it's dropped too
 * (guards against GetSchedule returning a wider range than asked).
 */
export function parseSchedule(data: any, dateKey: string): ScheduledVisit[] {
  const out: ScheduledVisit[] = [];
  for (const row of unityRows(data)) {
    const patientId = pick(row, 'PatientID', 'PatientId', 'PatID', 'PatientNumber', 'Patient_ID');
    if (!patientId) continue;
    const status = pick(row, 'Status', 'AppointmentStatus', 'ApptStatus', 'StatusDescription');
    if (status && CANCELLED.test(status)) continue;

    const dateField = pick(row, 'AppointmentDate', 'ApptDate', 'Date', 'StartDate', 'ApptDateTime', 'StartDateTime', 'AppointmentDateTime');
    const rowDate = parseDateKey(dateField);
    if (rowDate && rowDate !== dateKey) continue;

    const timeField = pick(row, 'AppointmentTime', 'ApptTime', 'StartTime', 'Time', 'ApptStartTime');
    const minutes = parseClock(timeField) ?? parseClock(dateField);

    const first = pick(row, 'PatientFirstName', 'FirstName', 'PatFirstName');
    const last = pick(row, 'PatientLastName', 'LastName', 'PatLastName');
    const patientName =
      pick(row, 'PatientName', 'PatientFullName', 'PatientDisplayName', 'Patient', 'Name') ||
      [first, last].filter(Boolean).join(' ') ||
      'Name not listed';

    const visitType = pick(row, 'AppointmentType', 'ApptType', 'AppointmentTypeDescription', 'ApptTypeDescription', 'VisitType', 'Type');
    let newPatient = yesNo(pick(row, 'NewPatient', 'IsNewPatient', 'NewPatientFlag', 'NewPt', 'NewPatientYN'));
    if (newPatient === null && /\bnew\b/i.test(visitType)) newPatient = true;

    out.push({
      appointmentId: pick(row, 'AppointmentID', 'ApptID', 'AppointmentId', 'ScheduleID', 'ID'),
      patientId,
      patientName,
      minutes,
      time: minutes !== null ? clockLabel(minutes) : timeField,
      provider:
        pick(row, 'ProviderName', 'ResourceName', 'ProviderDisplayName', 'Provider', 'Resource', 'SchedulingProvider', 'DoctorName') ||
        UNASSIGNED_PROVIDER,
      visitType,
      status,
      location: pick(row, 'LocationName', 'Location', 'SchedulingLocation', 'Department'),
      newPatient,
    });
  }
  return out;
}

type CallOutcome = { ok: true; result: any } | { ok: false; code: string };

/**
 * Run an agent tool with a hard deadline. Never throws: a thrown error, a structured failure,
 * a restricted result or a timeout all become { ok:false, code }.
 */
export async function runChecked(
  deps: PlatformDeps,
  tool: string,
  args: any,
  deadline: number,
  now: () => number = Date.now
): Promise<CallOutcome> {
  const remaining = deadline - now();
  if (remaining <= 0) return { ok: false, code: 'TIMEOUT_ERROR' };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<'__timeout__'>((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), remaining);
    });
    const r = await Promise.race([deps.runTool(tool, args), timeout]);
    if (r === '__timeout__') return { ok: false, code: 'TIMEOUT_ERROR' };
    if (isToolFailure(r)) return { ok: false, code: r.error_code };
    if (!r || typeof r !== 'object' || r.success === false) return { ok: false, code: 'API_ERROR' };
    if (r.redacted === true) return { ok: false, code: 'RESTRICTED' };
    return { ok: true, result: r };
  } catch (e) {
    return { ok: false, code: toToolFailure(e, tool).error_code };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run fn over items with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

interface Enrichment {
  balance: Check<number>;
  insurance: Check<{ carrier: string; policies: number }>;
  allergies: Check<number>;
  problems: Check<number>;
}

const ENRICHERS: Array<{ key: keyof Enrichment; tool: string; read: (r: any) => any }> = [
  { key: 'balance', tool: 'unity_get_account_balance', read: (r) => (typeof r.balance === 'number' && isFinite(r.balance) ? r.balance : undefined) },
  {
    key: 'insurance',
    tool: 'unity_get_insurance_policy',
    read: (r) =>
      Array.isArray(r.policies)
        ? { carrier: String(r.policies[0]?.carrier || r.policies[0]?.plan || ''), policies: r.policies.length }
        : undefined,
  },
  { key: 'allergies', tool: 'unity_get_patient_allergies', read: (r) => (Array.isArray(r.allergies) ? r.allergies.length : undefined) },
  { key: 'problems', tool: 'unity_get_patient_problems', read: (r) => (Array.isArray(r.problems) ? r.problems.length : undefined) },
];

export const COULDNT_CHECK = "couldn't check";

export function flagsFor(v: Omit<HuddleVisit, 'flags'>): HuddleFlag[] {
  const f: HuddleFlag[] = [];
  if (v.newPatient === true) f.push({ key: 'new_patient', label: 'New patient', tone: 'info' });
  if (!v.balance.ok) f.push({ key: 'balance_failed', label: `Balance: ${COULDNT_CHECK}`, tone: 'unknown' });
  else if (v.balance.value > 0) f.push({ key: 'balance_due', label: `Balance due ${money(v.balance.value)}`, tone: 'warn' });
  if (!v.insurance.ok) f.push({ key: 'insurance_failed', label: `Insurance: ${COULDNT_CHECK}`, tone: 'unknown' });
  else if (v.insurance.value.policies === 0) f.push({ key: 'no_insurance', label: 'No insurance on file', tone: 'urgent' });
  if (!v.allergies.ok) f.push({ key: 'allergies_failed', label: `Allergies: ${COULDNT_CHECK}`, tone: 'unknown' });
  else if (v.allergies.value > 0) f.push({ key: 'allergies', label: `Allergies on file (${v.allergies.value})`, tone: 'warn' });
  if (!v.problems.ok) f.push({ key: 'problems_failed', label: `Problems: ${COULDNT_CHECK}`, tone: 'unknown' });
  return f;
}

export class HuddleService {
  private cache = new Map<string, { at: number; ttl: number; brief: HuddleBrief }>();
  private inflight = new Map<string, Promise<HuddleBrief>>();
  private readonly now: () => number;

  constructor(
    readonly deps: PlatformDeps,
    private opts: HuddleOptions = {}
  ) {
    this.now = opts.now || Date.now;
  }

  private get concurrency(): number {
    return this.opts.concurrency ?? 4;
  }
  private get budgetMs(): number {
    return this.opts.budgetMs ?? (Number(process.env.HUDDLE_TIME_BUDGET_MS) || 45_000);
  }
  private get cacheMs(): number {
    return this.opts.cacheMs ?? 10 * 60_000;
  }
  private get cacheFailedMs(): number {
    return this.opts.cacheFailedMs ?? 60_000;
  }

  /** Resolve a date input ("", "today", "tomorrow", YYYY-MM-DD, MM/DD/YYYY) to a clinic date key; throws VALIDATION_ERROR. */
  dateKey(input?: unknown): string {
    const key = normalizeDate(input, new Date(this.now()));
    if (!key) throw UnityErrorHandler.createValidationError('Date must be YYYY-MM-DD, MM/DD/YYYY, today or tomorrow');
    return key;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Brief for one date. Cached 10 minutes per date (1 minute when checks failed); refresh bypasses the cache. */
  async getBrief(dateInput?: unknown, o: { refresh?: boolean } = {}): Promise<HuddleBrief> {
    const key = this.dateKey(dateInput);
    const hit = this.cache.get(key);
    if (!o.refresh && hit && this.now() - hit.at < hit.ttl) return { ...hit.brief, fromCache: true };

    const running = this.inflight.get(key);
    if (running) return running;

    const p = this.build(key);
    this.inflight.set(key, p);
    try {
      const brief = await p;
      const ttl = brief.summary.failedChecks > 0 || brief.timedOut ? this.cacheFailedMs : this.cacheMs;
      this.cache.set(key, { at: this.now(), ttl, brief });
      for (const [k, v] of this.cache) if (this.now() - v.at >= v.ttl) this.cache.delete(k);
      return brief;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** GetSchedule for one date; throws a UnityMCPError when the call fails (never an empty day). */
  async fetchSchedule(key: string): Promise<ScheduledVisit[]> {
    const action = UnityActions.Scheduling.GET_SCHEDULE;
    try {
      // ASSUMPTION (unverified against the sandbox): GetSchedule follows the Unity convention
      // Parameter1 = date as MM/DD/YYYY (a "start|end" range may also be accepted),
      // Parameter2 = changed-since (blank), Parameter3 = include pictures (blank), Parameter4 =
      // resource/provider filter (blank = everything the service user can see). Called against
      // Veradigm® PM. If the sandbox wants another layout, change it here only.
      const res = await this.deps.unity.executeAction<any>(action, { Parameter1: toUnityDate(key) }, '', 'PM');
      if (!res || !res.success) {
        throw UnityErrorHandler.createAPIError(res?.error || 'GetSchedule failed', action);
      }
      return parseSchedule(res.data, key);
    } catch (error) {
      if (error instanceof UnityMCPError) throw error;
      throw UnityErrorHandler.handleUnknownError(error, action);
    }
  }

  private async build(key: string): Promise<HuddleBrief> {
    const started = this.now();
    let visits: ScheduledVisit[];
    try {
      visits = await this.fetchSchedule(key);
    } catch (e) {
      console.error(`[Huddle] GetSchedule failed for ${key}: ${(e as UnityMCPError).code || 'UNKNOWN_ERROR'}`);
      throw e;
    }

    // One enrichment per patient (a patient with two visits is checked once).
    const patientIds = [...new Set(visits.map((v) => v.patientId))];
    const results = new Map<string, Partial<Enrichment>>();
    for (const id of patientIds) results.set(id, {});
    const tasks = patientIds.flatMap((patientId) => ENRICHERS.map((e) => ({ patientId, e })));
    const deadline = started + this.budgetMs;
    let timedOut = false;

    await pool(tasks, this.concurrency, async ({ patientId, e }) => {
      const out = await runChecked(this.deps, e.tool, { patientId }, deadline, this.now);
      let check: Check<any>;
      if (!out.ok) {
        if (out.code === 'TIMEOUT_ERROR' && this.now() >= deadline) timedOut = true;
        check = { ok: false, code: out.code };
      } else {
        const value = e.read(out.result);
        check = value === undefined ? { ok: false, code: 'UNREADABLE' } : { ok: true, value };
      }
      (results.get(patientId) as any)[e.key] = check;
    });

    const missing: Check<any> = { ok: false, code: 'NOT_RUN' };
    const enriched: HuddleVisit[] = visits.map((v) => {
      const r = results.get(v.patientId) || {};
      const base = {
        ...v,
        balance: r.balance || missing,
        insurance: r.insurance || missing,
        allergies: r.allergies || missing,
        problems: r.problems || missing,
      };
      return { ...base, flags: flagsFor(base) };
    });

    // Group by provider, then time (unknown times last).
    const byProvider = new Map<string, HuddleVisit[]>();
    for (const v of enriched) {
      if (!byProvider.has(v.provider)) byProvider.set(v.provider, []);
      byProvider.get(v.provider)!.push(v);
    }
    const providers = [...byProvider.entries()]
      .map(([name, list]) => ({
        name,
        visits: list.sort((a, b) => (a.minutes ?? 24 * 60) - (b.minutes ?? 24 * 60) || a.patientName.localeCompare(b.patientName)),
      }))
      .sort((a, b) =>
        a.name === UNASSIGNED_PROVIDER ? 1 : b.name === UNASSIGNED_PROVIDER ? -1 : a.name.localeCompare(b.name)
      );

    // Per-patient counts (first visit of each patient).
    const perPatient = new Map<string, HuddleVisit>();
    for (const v of enriched) if (!perPatient.has(v.patientId)) perPatient.set(v.patientId, v);
    const pts = [...perPatient.values()];
    const failedOf = (v: HuddleVisit) => [v.balance, v.insurance, v.allergies, v.problems].filter((c) => !c.ok).length;
    const summary: HuddleSummary = {
      visits: enriched.length,
      providers: providers.length,
      patients: pts.length,
      balancesDue: pts.filter((v) => v.balance.ok && v.balance.value > 0).length,
      missingInsurance: pts.filter((v) => v.insurance.ok && v.insurance.value.policies === 0).length,
      allergiesOnFile: pts.filter((v) => v.allergies.ok && v.allergies.value > 0).length,
      newPatients: pts.filter((v) => v.newPatient === true).length,
      failedChecks: pts.reduce((n, v) => n + failedOf(v), 0),
      patientsWithFailedChecks: pts.filter((v) => failedOf(v) > 0).length,
    };

    console.error(
      `[Huddle] brief ${key}: ${summary.visits} visits, ${summary.providers} providers, ${summary.failedChecks} failed checks${timedOut ? ', time budget ran out' : ''} (${this.now() - started} ms)`
    );

    return {
      date: key,
      dateLabel: dateLabel(key),
      generatedAt: new Date(this.now()).toISOString(),
      fromCache: false,
      timedOut,
      summary,
      providers,
    };
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Agent-facing summary (staff voice assistant). Counts only: no patient names or IDs, so nothing
 * patient-identifying is read aloud even if the tool were called on the wrong line.
 */
export function agentBrief(b: HuddleBrief) {
  const s = b.summary;
  const providerLines = b.providers.map((p) => {
    const first = p.visits.find((v) => v.minutes !== null);
    const ids = [...new Set(p.visits.map((v) => v.patientId))];
    const pv = ids.map((id) => p.visits.find((v) => v.patientId === id)!);
    const bal = pv.filter((v) => v.balance.ok && v.balance.value > 0).length;
    const noIns = pv.filter((v) => v.insurance.ok && v.insurance.value.policies === 0).length;
    const failed = pv.reduce((n, v) => n + [v.balance, v.insurance, v.allergies, v.problems].filter((c) => !c.ok).length, 0);
    const bits = [plural(p.visits.length, 'visit')];
    if (first) bits.push(`first at ${first.time}`);
    if (bal) bits.push(`${bal} with a balance due`);
    if (noIns) bits.push(`${noIns} with no insurance on file`);
    if (failed) bits.push(`${plural(failed, 'check')} couldn't be completed`);
    return `${p.name}: ${bits.join(', ')}`;
  });

  const day = dateLabel(b.date, false);
  let message: string;
  if (s.visits === 0) {
    message = `There are no visits on the schedule for ${day}.`;
  } else {
    message =
      `${day}: ${plural(s.visits, 'visit')} with ${plural(s.providers, 'provider')}. ` +
      `${plural(s.balancesDue, 'patient')} with a balance due, ${s.missingInsurance} with no insurance on file` +
      (s.newPatients ? `, ${plural(s.newPatients, 'new patient')}` : '') +
      '.' +
      (s.failedChecks ? ` ${plural(s.failedChecks, 'check')} couldn't be completed, so those items are unknown, not clear.` : '');
    const per = b.providers.map((p) => `${p.name} ${p.visits.length}`).join(', ');
    if (message.length + per.length + 14 <= 500) message += ` By provider: ${per}.`;
  }
  return {
    success: true as const,
    date: b.date,
    dateLabel: b.dateLabel,
    summary: s,
    providerLines,
    timedOut: b.timedOut,
    message,
  };
}
