import { auditToolCall } from './audit';

/**
 * A UnityService view whose executeAction writes one audit line per Veradigm action (kind "action":
 * action name, patient ID when it is a plain ID, success, error code, latency, channel).
 *
 * Handed to platform modules (one view per module, channel = module name) so their direct Veradigm
 * calls (intake SaveScanDocument/SaveTask, observer reads, provider/schedule reads, huddle and
 * outreach reads) land in the same audit JSONL as tool calls. Every other method is inherited and
 * goes through the audited executeAction too. The original service is not changed.
 */
type ExecuteAction = (action: string, params?: any, patientId?: string, target?: any) => Promise<any>;

export function auditedUnity<T extends { executeAction: ExecuteAction }>(unity: T, channel: string): T {
  const view = Object.create(unity) as T;
  const execute: ExecuteAction = async (action, params, patientId = '', target) => {
    const t0 = Date.now();
    const record = (success: boolean, errorCode?: string) =>
      auditToolCall({ server: 'unity', kind: 'action', tool: action, patientId, success, errorCode, latencyMs: Date.now() - t0, channel });
    try {
      // Dynamic lookup: wrappers applied to the original later (shadow read-only lock) still apply.
      const res = await unity.executeAction(action, params, patientId, target);
      record(!!res?.success, res?.success ? undefined : 'UNITY_ERROR');
      return res;
    } catch (e: any) {
      record(false, typeof e?.code === 'string' ? e.code : 'UNKNOWN_ERROR');
      throw e;
    }
  };
  Object.defineProperty(view, 'executeAction', { value: execute, writable: true, configurable: true, enumerable: false });
  return view;
}
