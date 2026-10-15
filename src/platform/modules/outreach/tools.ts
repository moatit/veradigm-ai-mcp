import { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from '../../registry';
import { outreachJobs } from './store';
import { OUTREACH_OUTCOMES, OutreachJob, OutreachOutcome, RETRY_OUTCOMES } from './types';
import { spokenDate, spokenTime } from './util';

/**
 * Agent tools for the OUTBOUND Retell agent. They read and update Drawbridge's own outreach
 * store only, never Veradigm. Rescheduling, cancelling and confirming go through the existing
 * unity_* tools after the agent verifies identity (see retell-prompts/outbound-outreach-agent.md).
 */
const PURPOSE: Record<OutreachJob['type'], string> = {
  reminder: 'a reminder about an upcoming appointment',
  no_show: 'a follow-up because the patient missed a recent appointment and may want to reschedule',
  recall: 'a reminder that the patient is due to schedule a follow-up visit',
};

function resolve(args: { jobId?: string }, ctx: ToolContext): { job?: OutreachJob; error?: string } {
  const byId = args?.jobId ? outreachJobs.get(String(args.jobId)) : undefined;
  if (args?.jobId && !byId) return { error: 'not_found' };
  const job = byId || (ctx.callId ? outreachJobs.findByCallId(ctx.callId) : undefined);
  if (!job) return { error: 'not_found' };
  // A job placed as a call belongs to that call only.
  if (ctx.callId && job.retell_call_id && job.retell_call_id !== ctx.callId) return { error: 'other_call' };
  return { job };
}

const NOT_FOUND = {
  success: false,
  message:
    "I couldn't find what this call is about. Do not share any details. Say a staff member from the clinic will follow up, and end the call politely.",
};

export class OutreachTools {
  context(args: { jobId?: string; verifiedPatientId?: string }, ctx: ToolContext): any {
    const { job } = resolve(args, ctx);
    if (!job) return NOT_FOUND;
    const name = job.patient_first_name || 'the patient';

    if (!args?.verifiedPatientId) {
      // Before verification: who to ask for and why we're calling, no appointment details.
      return {
        success: true,
        jobId: job.id,
        outreachType: job.type,
        patientFirstName: job.patient_first_name,
        verified: false,
        message:
          `This call is ${PURPOSE[job.type]} for ${name}. Ask for ${name} by first name only. ` +
          'Do not share any appointment details until the person confirms their full name and date of birth with unity_search_patients ' +
          'and the match is exactly one patient; then call drawbridge_outreach_context again with verifiedPatientId.',
      };
    }

    if (String(args.verifiedPatientId) !== job.patient_ref.id) {
      return {
        success: false,
        verified: false,
        message:
          "The verified record does not match the person this call is for. Do not share any details. Say you're sorry for the confusion, " +
          'and record the outcome as wrong_number or other.',
      };
    }

    let detail = '';
    if (job.appointment) {
      const when = [spokenDate(job.appointment.date), job.appointment.time && `at ${spokenTime(job.appointment.time)}`].filter(Boolean).join(' ');
      detail =
        job.type === 'no_show'
          ? `Their missed appointment was ${when}${job.appointment.provider ? ` with ${job.appointment.provider}` : ''}.`
          : `The appointment is ${when}${job.appointment.provider ? ` with ${job.appointment.provider}` : ''}.`;
    } else if (job.recall) {
      detail = `They are due for a follow-up visit around ${spokenDate(job.recall.due)}. Offer to find a time.`;
    }
    const out: any = {
      success: true,
      jobId: job.id,
      outreachType: job.type,
      verified: true,
      message: `Verified. ${detail} Use patientId ${job.patient_ref.id} for any appointment tool.`.replace(/\s+/g, ' ').trim(),
    };
    // Appointment ID for unity_confirm_appointment / unity_cancel_appointment (never read aloud).
    if (job.appointment?.id) out.appointmentId = job.appointment.id;
    return out;
  }

  result(args: { jobId?: string; outcome?: string; notes?: string }, ctx: ToolContext): any {
    const outcome = String(args?.outcome || '') as OutreachOutcome;
    if (!OUTREACH_OUTCOMES.includes(outcome)) {
      return { success: false, message: `Outcome must be one of: ${OUTREACH_OUTCOMES.join(', ')}.` };
    }
    const { job } = resolve(args, ctx);
    if (!job) return NOT_FOUND;
    const sameCall = !!ctx.callId && job.retell_call_id === ctx.callId;
    if (job.status !== 'calling' && !sameCall) {
      return { success: false, message: 'This outreach is not in progress, so nothing was recorded. Continue the conversation normally.' };
    }
    const notes = String(args?.notes || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const retry = RETRY_OUTCOMES.includes(outcome);
    outreachJobs.update(
      job.id,
      'agent',
      'outcome',
      (j) => {
        j.outcome = outcome;
        j.status = retry ? 'failed' : 'completed';
        if (notes) j.notes = notes;
      },
      outcome
    );
    if (outcome === 'opted_out') outreachJobs.optOut(job.patient_ref.id);
    console.log(`[Outreach] job ${job.id} (${job.type}): outcome ${outcome}`);
    return {
      success: true,
      message:
        outcome === 'opted_out'
          ? 'Recorded. They will not get these calls again. Thank them and end the call politely.'
          : 'Recorded. Ask if there is anything else, then end the call politely.',
    };
  }

  getTools(): Tool[] {
    return [
      {
        name: 'drawbridge_outreach_context',
        description:
          'Outbound calls only. Call at the start of the call (no arguments) to learn who to ask for and why. After the person verifies full name and date of birth with unity_search_patients, call again with verifiedPatientId to get the appointment or recall details.',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Optional. Leave empty: the job is found from this call.' },
            verifiedPatientId: { type: 'string', description: 'patientId from unity_search_patients after name + DOB matched exactly one patient' },
          },
          required: [],
        },
      },
      {
        name: 'drawbridge_outreach_result',
        description:
          'Outbound calls only. Record how the call ended, once, before hanging up (also after leaving a voicemail).',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Optional. Leave empty: the job is found from this call.' },
            outcome: { type: 'string', enum: OUTREACH_OUTCOMES },
            notes: { type: 'string', description: 'One short sentence for staff, e.g. "Booked Oct 20 9 AM". No medical details.' },
          },
          required: ['outcome'],
        },
      },
    ];
  }
}
