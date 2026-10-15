/**
 * Outreach job model (reminder calls, no-show follow-up, recall outreach; deck slide 9).
 *
 * A job is one outbound call the VeradigmAI agent may place for one patient. Jobs are created as
 * `proposed` by the generators, and a staff member must approve them before anything is dialed.
 */
export type OutreachType = 'reminder' | 'no_show' | 'recall';

export type OutreachStatus = 'proposed' | 'approved' | 'calling' | 'completed' | 'failed' | 'skipped';

export type OutreachOutcome =
  | 'confirmed'
  | 'reschedule_requested'
  | 'cancel_requested'
  | 'voicemail'
  | 'no_answer'
  | 'wrong_number'
  | 'opted_out'
  | 'other';

export const OUTREACH_OUTCOMES: OutreachOutcome[] = [
  'confirmed',
  'reschedule_requested',
  'cancel_requested',
  'voicemail',
  'no_answer',
  'wrong_number',
  'opted_out',
  'other',
];

/** Outcomes that leave the job open for another attempt (staff re-approves; max 2 attempts). */
export const RETRY_OUTCOMES: OutreachOutcome[] = ['voicemail', 'no_answer'];

export const MAX_ATTEMPTS = 2;

export interface OutreachEvent {
  at: string;
  /** Staff username, "agent" (Retell tool call) or "system". */
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
  attempts: number;
  outcome?: OutreachOutcome;
  notes?: string;
  retell_call_id?: string;
  /** Last dial attempt: dry run, placed or refused (with a PHI-free reason). */
  last_result?: { at: string; mode: 'dry_run' | 'live'; result: 'would_call' | 'placed' | 'refused' | 'error'; reason?: string };
  approved_by?: string;
  /** De-duplication key: type + patient + appointment/recall. */
  dedupe_key: string;
  events: OutreachEvent[];
  created_at: string;
  updated_at: string;
}
