import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { callRecords, CallRecord, Urgency } from './call-records';
import { currentMode } from './call-mode';
import { getSystemStatus } from '../../platform/system-status';
import { UnityErrorHandler } from '../utils/error-handler';

/**
 * Agent tools for after-hours mode and the on-call notebook (spec §5–6).
 * These touch only Drawbridge's own call-record store, never Veradigm.
 */
export class OnCallTools {
  getCallMode(): { success: true; mode: string; message: string } {
    const mode = currentMode();
    const records = getSystemStatus()?.agentStatus() || 'UNKNOWN';
    return {
      success: true,
      mode,
      message:
        (mode === 'after_hours'
          ? 'AFTER_HOURS: use the after-hours flow. Verify, take the message in the caller\'s words, ask if it is urgent, save the call record.'
          : 'BUSINESS_HOURS: use the normal flow.') +
        (records === 'DOWN' ? ' Records system: DOWN (take a message or transfer).' : ''),
    };
  }

  saveCallRecord(
    args: {
      verified?: boolean;
      patientSystem?: 'veradigm_pm' | 'veradigm_ehr';
      patientId?: string;
      patientName?: string;
      dob?: string;
      reason?: string;
      urgency?: Urgency;
      callerPhone?: string;
      medications?: string[];
      allergies?: string[];
      problems?: string[];
      latestObservations?: string[];
      nextAppointment?: string;
      staffTaskId?: string;
    },
    callId?: string,
    callerPhone?: string
  ): { success: true; callId: string; message: string } {
    const urgency: Urgency = args.urgency === 'urgent' ? 'urgent' : 'routine';
    const list = (v?: string[]) => (Array.isArray(v) ? v.map(String).slice(0, 30) : undefined);
    const patch: Partial<CallRecord> = {
      verified: !!args.verified,
      patient_name: args.verified ? args.patientName || '' : '',
      dob: args.verified ? args.dob || '' : '',
      patient_ref: args.verified ? { system: args.patientSystem || '', id: args.patientId || '' } : { system: '', id: '' },
      reason_verbatim: (args.reason || '').slice(0, 2000),
      urgency,
      caller_phone: args.callerPhone || callerPhone || '',
      staff_task_id: args.staffTaskId || '',
      chart_snapshot: {
        medications: list(args.medications) || [],
        allergies: list(args.allergies) || [],
        problems: list(args.problems) || [],
        latest_observations: list(args.latestObservations) || [],
        next_appointment: args.nextAppointment || '',
      },
      transcript_ref: callId ? `retell:${callId}` : '',
    };
    if (urgency === 'urgent') {
      // Live paging is not wired yet; the notebook shows the alert entry (spec §6).
      patch.alert = {
        sent: true,
        at: new Date().toISOString(),
        to: process.env.ONCALL_ALERT_TO || 'on-call provider',
        note: process.env.ONCALL_ALERT_TO ? 'Transfer requested by agent' : 'Demo: alert recorded, live paging not wired',
      };
    }
    const rec = callRecords.upsert(callId, currentMode(), patch);
    return {
      success: true,
      callId: rec.call_id,
      message: urgency === 'urgent' ? 'Saved. Urgent: transfer to the on-call provider now.' : 'Saved for the morning team.',
    };
  }

  /**
   * A message for staff kept in Drawbridge's own call record (no Veradigm write): used when the records
   * system is down (no SaveTask possible), when the caller can't be verified, or when a transfer isn't
   * possible. Name and birth date are stored as the caller stated them, marked unverified. While the
   * Veradigm connection is down the message is counted for the help-desk alert (count only, no content).
   */
  takeMessage(
    args: { callerName?: string; dateOfBirth?: string; callbackPhone?: string; message?: string; urgency?: Urgency },
    callId?: string,
    callerPhone?: string
  ): { success: true; callId: string; message: string } {
    const message = String(args.message || '').trim().slice(0, 2000);
    if (!message) throw UnityErrorHandler.createValidationError('message is required');
    const status = getSystemStatus();
    const recordsDown = !!status && status.overall() !== 'up' && status.overall() !== 'unknown';
    const urgency: Urgency = args.urgency === 'urgent' ? 'urgent' : 'routine';
    const rec = callRecords.upsert(callId, currentMode(), {
      kind: 'message',
      verified: false,
      caller_stated: {
        name: String(args.callerName || '').slice(0, 120),
        dob: String(args.dateOfBirth || '').slice(0, 20),
        callback: String(args.callbackPhone || '').slice(0, 30),
      },
      reason_verbatim: message,
      urgency,
      caller_phone: args.callbackPhone || callerPhone || '',
      records_down: recordsDown,
      transcript_ref: callId ? `retell:${callId}` : '',
    });
    if (recordsDown) status!.noteMessageTaken();
    return {
      success: true,
      callId: rec.call_id,
      message: 'SUCCESS: message saved for the clinic staff. Tell the caller staff will call them back; never promise a time.',
    };
  }

  getTools(): Tool[] {
    return [
      {
        name: 'drawbridge_get_call_mode',
        description: 'Line mode: BUSINESS_HOURS or AFTER_HOURS. Only if the prompt did not give it.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'drawbridge_take_message',
        description:
          'Save a message for staff when a staff task is not possible: records system unavailable, caller not verified, or transfer not possible. Read it back and get a yes first.',
        inputSchema: {
          type: 'object',
          properties: {
            callerName: { type: 'string', description: 'As the caller said it' },
            dateOfBirth: { type: 'string', description: 'MM/DD/YYYY' },
            callbackPhone: { type: 'string' },
            message: { type: 'string', description: "Caller's words" },
            urgency: { type: 'string', enum: ['urgent', 'routine'] },
          },
          required: ['callerName', 'callbackPhone', 'message'],
        },
      },
      {
        name: 'drawbridge_save_call_record',
        description:
          'After-hours: save the call to the on-call notebook once the message is taken. Include what you read from the chart (medications, allergies, problems, latest results, next appointment). Never include anything if the caller was not verified.',
        inputSchema: {
          type: 'object',
          properties: {
            verified: { type: 'boolean', description: 'Caller matched full name and date of birth' },
            patientSystem: { type: 'string', enum: ['veradigm_pm', 'veradigm_ehr'] },
            patientId: { type: 'string' },
            patientName: { type: 'string' },
            dob: { type: 'string', description: 'MM/DD/YYYY' },
            reason: { type: 'string', description: 'The caller\'s message in their own words' },
            urgency: { type: 'string', enum: ['urgent', 'routine'] },
            callerPhone: { type: 'string' },
            medications: { type: 'array', items: { type: 'string' } },
            allergies: { type: 'array', items: { type: 'string' } },
            problems: { type: 'array', items: { type: 'string' } },
            latestObservations: { type: 'array', items: { type: 'string' } },
            nextAppointment: { type: 'string' },
            staffTaskId: { type: 'string', description: 'taskId from unity_create_staff_task, if one was created' },
          },
          required: ['verified', 'reason', 'urgency'],
        },
      },
    ];
  }
}
