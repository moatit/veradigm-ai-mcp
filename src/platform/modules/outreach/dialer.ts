import axios from 'axios';
import { outreachJobs } from './store';
import { MAX_ATTEMPTS, OutreachJob } from './types';
import { clinicParts, clinicTz, spokenDate, spokenTime, toE164 } from './util';

/**
 * Outbound calls through Retell (POST /v2/create-phone-call).
 *
 * Safety rules, all enforced here (the only place Drawbridge dials):
 *  (a) DRY RUN unless RETELL_API_KEY and RETELL_OUTBOUND_AGENT_ID are both set. A dry run
 *      records "would call" on the job and logs it without the number.
 *  (b) OUTBOUND_ALLOWLIST (comma-separated E.164): when non-empty, any other number is refused.
 *      OUTBOUND_ENABLED must be exactly "true" for any real call.
 *  (c) Quiet hours: calls only 09:00–19:00 in CLINIC_TIMEZONE (default America/Boise).
 *  (d) Only jobs a staff member approved (status "approved"). Nothing dials automatically.
 *  (e) At most MAX_ATTEMPTS (2) dial attempts per job.
 * Retell receives only the dynamic variables below: never diagnoses, medications or other
 * chart data.
 */
export const RETELL_CREATE_CALL_URL = 'https://api.retellai.com/v2/create-phone-call';
export const CLINIC_NAME = 'Idaho Kidney Institute';
const QUIET_START = 9; // 09:00
const QUIET_END = 19; // 19:00
const MAX_PER_RUN = 25;

export interface OutboundConfig {
  dryRun: boolean;
  enabled: boolean;
  allowlist: string[];
  hasFromNumber: boolean;
  timezone: string;
}

export function outboundConfig(): OutboundConfig {
  return {
    dryRun: !(process.env.RETELL_API_KEY && process.env.RETELL_OUTBOUND_AGENT_ID),
    enabled: process.env.OUTBOUND_ENABLED === 'true',
    allowlist: (process.env.OUTBOUND_ALLOWLIST || '')
      .split(',')
      .map((s) => toE164(s) || s.trim())
      .filter(Boolean),
    hasFromNumber: !!process.env.RETELL_FROM_NUMBER,
    timezone: clinicTz(),
  };
}

export function withinCallingHours(now: Date = new Date()): boolean {
  const { hour } = clinicParts(now);
  return hour >= QUIET_START && hour < QUIET_END;
}

/** Dynamic variables for the outbound agent. Nothing else about the patient goes to Retell. */
export function dynamicVariables(job: OutreachJob): Record<string, string> {
  return {
    patient_first_name: job.patient_first_name || '',
    appointment_date: job.appointment ? spokenDate(job.appointment.date) : '',
    appointment_time: job.appointment ? spokenTime(job.appointment.time) : '',
    provider_name: job.appointment?.provider || '',
    outreach_type: job.type,
    clinic_name: CLINIC_NAME,
  };
}

/** Why this job can't be dialed right now, or '' if it can. Checked before every call. */
export function refusalReason(job: OutreachJob, cfg: OutboundConfig, now: Date): string {
  if (job.status !== 'approved') return 'Not approved by staff';
  if (job.attempts >= MAX_ATTEMPTS) return `Already tried ${MAX_ATTEMPTS} times`;
  if (!job.phone) return 'No phone number';
  if (outreachJobs.isOptedOut(job.patient_ref.id)) return 'Patient asked not to be called';
  if (cfg.allowlist.length && !cfg.allowlist.includes(job.phone)) return 'Number is not on the outbound allowlist';
  if (!withinCallingHours(now)) return `Outside calling hours (9 AM–7 PM ${cfg.timezone})`;
  if (!cfg.dryRun) {
    if (!cfg.enabled) return 'Outbound calling is turned off (OUTBOUND_ENABLED is not true)';
    if (!cfg.hasFromNumber) return 'RETELL_FROM_NUMBER is not set';
  }
  return '';
}

export interface DialResult {
  jobId: string;
  result: 'would_call' | 'placed' | 'refused' | 'error';
  reason?: string;
}

export interface DialRun {
  mode: 'dry_run' | 'live';
  results: DialResult[];
  counts: Record<DialResult['result'], number>;
}

async function createCall(job: OutreachJob): Promise<string> {
  const res = await axios.post(
    RETELL_CREATE_CALL_URL,
    {
      from_number: process.env.RETELL_FROM_NUMBER,
      to_number: job.phone,
      override_agent_id: process.env.RETELL_OUTBOUND_AGENT_ID,
      metadata: { drawbridge_job_id: job.id },
      retell_llm_dynamic_variables: dynamicVariables(job),
    },
    {
      headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    }
  );
  const callId = res?.data?.call_id;
  if (!callId) throw new Error('Retell did not return a call_id');
  return String(callId);
}

/**
 * Dial approved jobs (all of them, or the given IDs). One staff click = one run. Jobs are
 * dialed one after another; a job is marked "calling" before the request so a second click
 * can't dial it twice.
 */
export async function callApproved(opts: { ids?: string[]; by: string; now?: Date }): Promise<DialRun> {
  const cfg = outboundConfig();
  const now = opts.now || new Date();
  const mode = cfg.dryRun ? 'dry_run' : 'live';
  const wanted = opts.ids ? new Set(opts.ids) : null;
  const jobs = outreachJobs
    .list()
    .filter((j) => (wanted ? wanted.has(j.id) : j.status === 'approved'))
    .slice(0, MAX_PER_RUN);
  const results: DialResult[] = [];

  for (const job of jobs) {
    const at = new Date().toISOString();
    const reason = refusalReason(job, cfg, now);
    if (reason) {
      // Only record the refusal on jobs that were waiting to be called.
      if (job.status === 'approved') {
        outreachJobs.update(job.id, opts.by, 'refused', (j) => (j.last_result = { at, mode, result: 'refused', reason }), reason);
      }
      console.log(`[Outreach] job ${job.id} (${job.type}): refused (${reason})`);
      results.push({ jobId: job.id, result: 'refused', reason });
      continue;
    }

    if (cfg.dryRun) {
      outreachJobs.update(
        job.id,
        opts.by,
        'dry_run',
        (j) => (j.last_result = { at, mode, result: 'would_call', reason: 'Dry run: no call placed' }),
        'would call'
      );
      console.log(`[Outreach] DRY RUN job ${job.id} (${job.type}): would call`);
      results.push({ jobId: job.id, result: 'would_call' });
      continue;
    }

    outreachJobs.update(job.id, opts.by, 'dialing', (j) => {
      j.status = 'calling';
      j.attempts += 1;
      j.outcome = undefined;
    });
    try {
      const callId = await createCall(job);
      outreachJobs.update(
        job.id,
        opts.by,
        'call_placed',
        (j) => {
          j.retell_call_id = callId;
          j.last_result = { at, mode, result: 'placed' };
        },
        `attempt ${job.attempts}`
      );
      console.log(`[Outreach] job ${job.id} (${job.type}): call placed, attempt ${job.attempts}`);
      results.push({ jobId: job.id, result: 'placed' });
    } catch (e: any) {
      // Never log the response body: it can echo the number and variables.
      const status = e?.response?.status;
      const why = status ? `Call service returned HTTP ${status}` : e?.code || 'Call could not be placed';
      outreachJobs.update(
        job.id,
        opts.by,
        'call_error',
        (j) => {
          j.status = 'failed';
          j.last_result = { at, mode, result: 'error', reason: why };
        },
        why
      );
      console.error(`[Outreach] job ${job.id} (${job.type}): call failed (${why})`);
      results.push({ jobId: job.id, result: 'error', reason: why });
    }
  }

  const counts = { would_call: 0, placed: 0, refused: 0, error: 0 };
  for (const r of results) counts[r.result]++;
  return { mode, results, counts };
}
