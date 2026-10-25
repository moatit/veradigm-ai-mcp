/**
 * Call & Confirm job model (outbound confirmation calls, no-show follow-up, recall outreach).
 *
 * A job is one patient + one reason to call (an appointment to confirm, a missed visit, a recall).
 * The list builders create jobs with an attempt plan (scheduler.ts). Each morning the day's
 * attempts go on a daily list; a staff member approves the list before anything is dialed.
 */
export type OutreachType = 'confirm' | 'no_show' | 'recall';
export const OUTREACH_TYPES: OutreachType[] = ['confirm', 'no_show', 'recall'];

/**
 *  scheduled    has planned attempts left, waiting for its next attempt day
 *  approved     today's attempt is on an approved daily list
 *  calling      an attempt is in progress
 *  completed    resolved (confirmed, moved, cancelled, booked, opted out) or all attempts used (no-show/recall)
 *  stopped      a stop rule ended it before an attempt (see `stop`)
 *  unconfirmed  confirm job: every attempt used and nobody confirmed (the "Unconfirmed" list, huddle flag)
 *  skipped      not callable when created (no usable phone, opted out) or skipped by staff
 */
export type OutreachStatus = 'scheduled' | 'approved' | 'calling' | 'completed' | 'stopped' | 'unconfirmed' | 'skipped';

/** What the agent may record at the end of a call (drawbridge_outreach_result). */
export type OutreachOutcome =
  | 'confirmed'
  | 'moved'
  | 'cancelled'
  | 'booked'
  | 'voicemail'
  | 'no_answer'
  | 'wrong_number'
  | 'opted_out'
  | 'callback_requested'
  | 'other';

export const OUTREACH_OUTCOMES: OutreachOutcome[] = [
  'confirmed',
  'moved',
  'cancelled',
  'booked',
  'voicemail',
  'no_answer',
  'wrong_number',
  'opted_out',
  'callback_requested',
  'other',
];

/** Older outcome names (outbound prompt before Oct 24, 2026) still accepted from the agent. */
export const LEGACY_OUTCOMES: Record<string, OutreachOutcome> = {
  reschedule_requested: 'moved',
  cancel_requested: 'cancelled',
  bad_number: 'wrong_number',
};

/** Outcomes that leave the job open for its next planned attempt. */
export const RETRY_OUTCOMES: OutreachOutcome[] = ['voicemail', 'no_answer'];

/**
 * Result buckets reported by the plan endpoint and the staff screen. `would_call` = dry run (nothing dialed),
 * `other` = answered but nothing changed (callback requested, not the patient, ...).
 */
export type ResultBucket = 'confirmed' | 'moved' | 'cancelled' | 'voicemail' | 'no_answer' | 'opted_out' | 'bad_number';
export const RESULT_BUCKETS: ResultBucket[] = ['confirmed', 'moved', 'cancelled', 'voicemail', 'no_answer', 'opted_out', 'bad_number'];

export function bucketOf(outcome: string | undefined): ResultBucket | null {
  switch (outcome) {
    case 'confirmed':
      return 'confirmed';
    case 'moved':
    case 'booked':
      return 'moved';
    case 'cancelled':
      return 'cancelled';
    case 'voicemail':
      return 'voicemail';
    case 'no_answer':
      return 'no_answer';
    case 'opted_out':
      return 'opted_out';
    case 'wrong_number':
    case 'bad_number':
      return 'bad_number';
    default:
      return null;
  }
}

export type AttemptState = 'planned' | 'listed' | 'approved' | 'done' | 'missed' | 'stopped' | 'dropped';

export interface PlannedAttempt {
  /** 1-based attempt number in the plan. */
  n: number;
  /** Clinic-local calendar date YYYY-MM-DD. */
  date: string;
  /** "HH:MM-HH:MM" clinic-local. */
  window: string;
  /** The final attempt: the only one that may leave a voicemail. */
  last: boolean;
  state: AttemptState;
  /** Outcome of a done attempt, `would_call` in dry run, `stop:<reason>` when a stop rule fired. */
  result?: string;
  at?: string;
  /** PHI-free note ("moved a day: patient call limit", "list not approved"). */
  note?: string;
}

export type StopReason = 'confirmed' | 'moved' | 'cancelled' | 'opted_out' | 'bad_number' | 'handled' | 'booked' | 'past';

export interface OutreachEvent {
  at: string;
  /** Staff username, "agent" (Retell tool call), "scheduler" or "system". */
  by: string;
  action: string;
  /** Short, PHI-free detail (counts, modes, reasons). */
  detail?: string;
}

export interface OutreachJob {
  id: string;
  type: OutreachType;
  patient_ref: { system: 'veradigm_pm'; id: string };
  patient_first_name: string;
  /** E.164 (+1XXXXXXXXXX), or '' when none was found (job is then skipped). */
  phone: string;
  appointment?: { id: string; date: string; time: string; provider: string };
  recall?: { type: string; due: string };
  status: OutreachStatus;
  /** Attempts actually dialed (live) or recorded (dry run / simulation). */
  attempts: number;
  /** The attempt plan from scheduler.ts; `short` = confirm job booked under 3 business days out. */
  plan: PlannedAttempt[];
  plan_kind?: 'standard' | 'short';
  outcome?: OutreachOutcome;
  stop?: { reason: StopReason; at: string };
  /** Bad number: a staff task to fix it (created through SaveTask when writes are on). */
  staff_task?: { state: 'pending' | 'created' | 'dry_run' | 'failed'; at: string; task_id?: string; error?: string };
  notes?: string;
  retell_call_id?: string;
  /** Last dial attempt: dry run, simulated, placed or refused (with a PHI-free reason). */
  last_result?: { at: string; mode: DialMode; result: 'would_call' | 'simulated' | 'placed' | 'refused' | 'error'; reason?: string };
  approved_by?: string;
  /** De-duplication key: type + patient + appointment/recall. */
  dedupe_key: string;
  events: OutreachEvent[];
  created_at: string;
  updated_at: string;
}

export type DialMode = 'dry_run' | 'live' | 'simulate';

/** The day's call list (built at 07:00 or by staff), approved with one click. */
export interface DailyList {
  date: string;
  built_at: string;
  built_by: string;
  approved_at?: string;
  approved_by?: string;
  entries: Array<{ job_id: string; n: number; type: OutreachType; window: string }>;
  /** What the list builders found (PHI-free counts), shown on the screen. */
  summary: string[];
}

/** Confirm attempts expected from appointments that are not jobs yet (built with the daily list). */
export interface Projection {
  built_at: string;
  /** date → window → type → count */
  counts: Record<string, Record<string, Partial<Record<OutreachType, number>>>>;
}
