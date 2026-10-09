import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { UnityActions } from '../config/unity-endpoints';
import { UnityService } from '../services/unity.service';
import { UnityErrorHandler, UnityMCPError } from '../utils/error-handler';
import { pick, unityRows } from '../utils/unity-rows';

/**
 * Staff task tool (Veradigm EHR SaveTask).
 *
 * This is the ONLY EHR write the agent may make (CLAUDE.md rule 4). It creates a task for staff
 * (refill request, callback, after-hours message). It never writes orders, notes, meds or problems.
 *
 * SaveTask parameters follow Unity's EHR convention: Parameter1 = task type, Parameter2 = target
 * user or team, Parameter3 = work object ID, Parameter4 = comments, Parameter5 = subject.
 * UNVERIFIED against the sandbox; task type and target come from env so they can be set per client:
 *   UNITY_TASK_TYPE (default "Call Patient"), UNITY_TASK_TARGET (default the EHR user)
 */
export type StaffTaskReason = 'refill_request' | 'callback' | 'after_hours_message' | 'clinical_question' | 'other';

export class UnityTaskTools {
  constructor(private unityService: UnityService) {}

  async createStaffTask(args: {
    patientId: string;
    reason: StaffTaskReason;
    message: string;
    urgency?: 'urgent' | 'routine';
    callbackPhone?: string;
  }): Promise<{ success: true; taskId: string; message: string }> {
    const action = UnityActions.Task.SAVE_TASK;
    try {
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }
      if (!args.message || !args.message.trim()) {
        throw UnityErrorHandler.createValidationError('Task message is required');
      }

      const urgency = args.urgency || 'routine';
      const subject = `VeradigmAI: ${(args.reason || 'other').replace(/_/g, ' ')}${urgency === 'urgent' ? ' (URGENT)' : ''}`;
      const comments = [
        args.message.trim().slice(0, 1500),
        args.callbackPhone ? `Callback: ${args.callbackPhone}` : '',
        'Created by the VeradigmAI phone agent. Caller identity verified by name and date of birth.',
      ]
        .filter(Boolean)
        .join('\n');

      const response = await this.unityService.executeAction<any>(
        action,
        {
          Parameter1: process.env.UNITY_TASK_TYPE || 'Call Patient',
          Parameter2: process.env.UNITY_TASK_TARGET || process.env.UNITY_EHR_USERNAME || '',
          Parameter3: '',
          Parameter4: comments,
          Parameter5: subject,
        },
        args.patientId,
        'EHR'
      );
      if (!response.success) {
        throw UnityErrorHandler.createAPIError(response.error || 'Failed to create staff task', action);
      }

      const row = unityRows(response.data)[0];
      const taskId = pick(row, 'TaskID', 'TransID', 'ID', 'savetaskinfo');
      return {
        success: true,
        taskId,
        message: 'A message has been sent to our staff. Someone will follow up during business hours.',
      };
    } catch (error) {
      if (error instanceof UnityMCPError) throw error;
      throw UnityErrorHandler.handleUnknownError(error, action);
    }
  }

  getTools(): Tool[] {
    return [
      {
        name: 'unity_create_staff_task',
        description:
          'Send a message to clinic staff as a task in Veradigm EHR (refill request, callback request, after-hours message, clinical question). Never changes the chart. Read the message back to the caller and get a yes first.',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: { type: 'string', description: 'Verified patient ID' },
            reason: {
              type: 'string',
              enum: ['refill_request', 'callback', 'after_hours_message', 'clinical_question', 'other'],
              description: 'Why the task is being created',
            },
            message: { type: 'string', description: 'The caller\'s request in their own words' },
            urgency: { type: 'string', enum: ['urgent', 'routine'], description: 'urgent or routine (default routine)' },
            callbackPhone: { type: 'string', description: 'Best callback number (optional)' },
          },
          required: ['patientId', 'reason', 'message'],
        },
      },
    ];
  }
}
