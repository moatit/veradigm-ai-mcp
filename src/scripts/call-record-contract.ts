/**
 * Call-record wire contract: builds records with the real record builder (call-analytics.ts) for every
 * edge case and prints them as JSON. The admin app's contract test (veradigmai-repo
 * lib/call-records/contract.test.ts) runs these records through its intake schema, either from the
 * committed copy (lib/call-records/contract/stack-records.json) or live from this script
 * (DRAWBRIDGE_SERVER_DIR=<this repo> npm run test:contract there). smoke:call-records checks the
 * same cases against this side's contract rules.
 *
 *   npm run contract:call-records                 # JSON to stdout
 *   npm run contract:call-records -- --out f.json # JSON to a file
 *
 * Synthetic data only; a throwaway AUDIT_DIR and a fixed synthetic hash key. No network.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ContractCase {
  name: string;
  record: unknown;
}

const T0 = Date.parse('2026-10-14T16:20:00Z');
const AGENT = 'agent_5a1e5a1e5a1e5a1e5a1e5a1e5a';

function call(id: string, over: Record<string, unknown> = {}, custom: Record<string, unknown> = {}): any {
  return {
    call_id: id,
    agent_id: AGENT,
    agent_version: 7,
    call_type: 'phone_call',
    direction: 'inbound',
    from_number: '+12085550142',
    to_number: '+12085550100',
    start_timestamp: T0,
    end_timestamp: T0 + 185_400,
    duration_ms: 185_400,
    disconnection_reason: 'user_hangup',
    transcript: 'Synthetic transcript: Zelda Quixote, born 1950-02-03, asks about a refill.',
    call_analysis: {
      call_summary: 'Zelda Quixote asked about a refill.',
      user_sentiment: 'Neutral',
      call_successful: true,
      in_voicemail: false,
      custom_analysis_data: { call_reason: 'prescription_refill', request_category: 'action_request', resolved: true, transferred_to_staff: false, ...custom },
    },
    ...over,
  };
}

/** Build every contract case in a throwaway AUDIT_DIR. Restores the environment it changes. */
export async function buildContractCases(): Promise<ContractCase[]> {
  const keys = ['AUDIT_DIR', 'CALL_RECORDS_DIR', 'CLINIC_TIMEZONE', 'DRAWBRIDGE_PRACTICE_ID', 'CALL_ANALYTICS_HASH_KEY', 'CALL_ANALYTICS_ALLOW_GENERATED_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-contract-'));
  Object.assign(process.env, {
    AUDIT_DIR: dir,
    CALL_RECORDS_DIR: dir,
    CLINIC_TIMEZONE: 'America/Boise',
    DRAWBRIDGE_PRACTICE_ID: 'sagebrush-kidney',
    CALL_ANALYTICS_HASH_KEY: 'synthetic-contract-hash-key-0123456789abcdef',
  });
  delete process.env.CALL_ANALYTICS_ALLOW_GENERATED_KEY;
  try {
    const audit = await import('../platform/audit');
    const ca = await import('../platform/modules/activity/call-analytics');
    const tool = (callId: string, name: string, success = true) =>
      audit.auditToolCall({ server: 'unity', tool: name, callId, success, latencyMs: 100, channel: 'retell' });
    tool('call_c_full', 'unity_get_patient_appointments');
    tool('call_c_full', 'unity_get_patient_appointments', false);
    tool('call_c_full', 'drawbridge_create_staff_task');
    tool('call_c_full', 'Weird.Tool:Name');
    tool('call_c_full', 'lookup_2085550142');
    for (let i = 0; i < 45; i++) tool('call_c_many_tools', `tool_${String.fromCharCode(97 + (i % 26))}_${Math.floor(i / 26)}`);
    await audit.flushAudit();

    const cases: ContractCase[] = [];
    const add = async (name: string, event: string, c: any, env: Record<string, string | undefined> = {}) => {
      const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      try {
        cases.push({ name, record: await ca.buildCallRecord(event, c) });
      } finally {
        for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    };
    await add('analyzed inbound call with tools (odd tool names left out)', 'call_analyzed', call('call_c_full'));
    await add('call_ended before analysis', 'call_ended', call('call_c_ended'));
    await add('no start time: started_at null', 'call_analyzed', call('call_c_nostart', { start_timestamp: undefined, end_timestamp: undefined, duration_ms: undefined }));
    await add('no agent ID: agent_id null', 'call_analyzed', call('call_c_noagent', { agent_id: undefined }));
    await add('agent ID outside the format: null', 'call_analyzed', call('call_c_badagent', { agent_id: 'Agent Zelda +1 208 555 0142' }));
    await add('agent ID with a 7+ digit run: null', 'call_analyzed', call('call_c_digitagent', { agent_id: 'agent_1234567abcdefabcdefabcdef' }));
    await add('short agent ID (vendor format, 8 chars)', 'call_analyzed', call('call_c_shortagent', { agent_id: 'agent_a1b2c3d4' }));
    await add('web call: no caller number, no repeat counts', 'call_analyzed', call('call_c_web', { call_type: 'web_call', direction: undefined, from_number: undefined, to_number: undefined }));
    await add('outbound call', 'call_analyzed', call('call_c_out', { direction: 'outbound' }));
    await add('undocumented disconnection reason: other', 'call_analyzed', call('call_c_disc', { disconnection_reason: 'error_brand_new_2031' }));
    await add('no disconnection reason: empty', 'call_ended', call('call_c_nodisc', { disconnection_reason: undefined }));
    await add('transfer reported only by the platform', 'call_analyzed', call('call_c_xfer', { disconnection_reason: 'call_transfer' }, { transferred_to_staff: undefined }));
    await add('free text in the analysis: other / null', 'call_analyzed', call('call_c_free', { call_analysis: { user_sentiment: 'Furious', call_successful: 'maybe', custom_analysis_data: { call_reason: 'Zelda has chest pain', request_category: 'call me at 2085550142', resolved: 'kind of' } } }));
    await add('no analysis object on call_analyzed', 'call_analyzed', call('call_c_noanalysis', { call_analysis: undefined }));
    await add('more than 40 tools: capped at 40', 'call_analyzed', call('call_c_many_tools'));
    await add('half-hour offset clinic (+05:30)', 'call_analyzed', call('call_c_tz'), { CLINIC_TIMEZONE: 'Asia/Kolkata' });
    await add('no practice ID configured: empty', 'call_analyzed', call('call_c_nopractice'), { DRAWBRIDGE_PRACTICE_ID: undefined });
    await add('no agent version: null', 'call_analyzed', call('call_c_noversion', { agent_version: 'v7' }));
    return cases;
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const cases = await buildContractCases();
  const out = JSON.stringify({ contract: 1, generated_by: 'veradigm-ai-mcp src/platform/modules/activity/call-analytics.ts', cases }, null, 1) + '\n';
  const i = process.argv.indexOf('--out');
  if (i > 0 && process.argv[i + 1]) fs.writeFileSync(process.argv[i + 1], out);
  else process.stdout.write(out);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('contract generation failed:', e?.message || e);
    process.exit(1);
  });
}
