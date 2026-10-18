import * as fs from 'fs';
import * as path from 'path';
import { AGENT_TOOLS, compactAgentTools, ToolDef } from '../../agent-tools';
import { AgentConfig, HandoffAction } from './config';
import { MODEL_SCRIPTS } from './scripts';
import { allowedByList, classifyTarget } from './dialplan';
import { ToolSpec } from './providers/types';

/**
 * What the model is offered on this line: the same compact Unity tool schemas the Retell agent has (built from the
 * code's own definitions, so a parameter the server does not take can never be offered), cut to the agent's
 * enabled list, plus the orchestrator's own tools. Execution of the Unity tools goes through executeAgentTool
 * (staff-only refusal, call binding, minimum necessary, idempotency, audit) under the call ID Drawbridge minted.
 */
export const WARM_TOOLS = ['connect_caller', 'staff_declined'];

export function harnessToolSpecs(agent: AgentConfig): ToolSpec[] {
  const on = new Set(agent.enabled_tools);
  const out: ToolSpec[] = [];
  if (on.has('say_script')) {
    out.push({
      name: 'say_script',
      description:
        "Play one of the clinic's exact pre-recorded lines instead of saying it yourself: EMERGENCY_911 (any possible emergency, then offer a transfer), " +
        'NO_MEDICAL_ADVICE (any request for medical advice or interpretation), RECORDS_DOWN (records system unavailable), CANT_VERIFY (identity could not be verified after two tries), GOODBYE.',
      parameters: { type: 'object', properties: { id: { type: 'string', enum: [...MODEL_SCRIPTS] } }, required: ['id'] },
    });
  }
  if (on.has('transfer_to_staff') && agent.handoffs.length) {
    out.push({
      name: 'transfer_to_staff',
      description:
        'Hand the caller to a person or a voicemail box (blind transfer; it plays the transfer line for you, do not say it yourself). Destinations: ' +
        agent.handoffs.map((h: HandoffAction) => `${h.id} = ${h.label}: ${h.description}`).join(' | '),
      parameters: {
        type: 'object',
        properties: { destination: { type: 'string', enum: agent.handoffs.map((h) => h.id) }, reason: { type: 'string', description: 'Short reason, for the log' } },
        required: ['destination'],
      },
    });
  }
  const warmDest = warmDestinations(agent);
  if (on.has('warm_transfer') && agent.warm_transfer.enabled && warmDest.length) {
    out.push({
      name: 'warm_transfer',
      description:
        'Put the caller on hold, call a person, brief them, then connect them. Use when the caller needs a person and a warm hand-off helps. ' +
        'You will be told when they answer. Destinations: ' + warmDest.map((h) => `${h.id} = ${h.label}`).join(' | '),
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string', enum: warmDest.map((h) => h.id) },
          reason: { type: 'string', description: "Why the caller is calling, in a few words (minimum necessary)" },
          caller_name: { type: 'string', description: 'Only if verified on this call' },
        },
        required: ['destination', 'reason'],
      },
    });
    out.push({ name: 'connect_caller', description: 'During a warm transfer: the staff member agreed to take the call. Connects them.', parameters: { type: 'object', properties: {} } });
    out.push({ name: 'staff_declined', description: 'During a warm transfer: the staff member cannot take the call.', parameters: { type: 'object', properties: {} } });
  }
  if (on.has('end_call')) {
    out.push({ name: 'end_call', description: 'End the call when the caller is done (plays the goodbye line, then hangs up).', parameters: { type: 'object', properties: {} } });
  }
  return out;
}

/** Transfer destinations that may be called out to (warm transfer): on the dial allow-list, or any US number if allowed. */
export function warmDestinations(agent: AgentConfig): HandoffAction[] {
  return agent.handoffs.filter((h) => {
    if (h.kind !== 'transfer') return false;
    const c = classifyTarget(h.target);
    return c.ok && allowedByList(c, agent.dial_allow, agent.allow_any_nanp);
  });
}

export function agentToolSpecs(agent: AgentConfig, unityDefs: ToolDef[]): ToolSpec[] {
  const on = new Set(agent.enabled_tools);
  const unity = compactAgentTools({ unity: unityDefs, fhir: [] }, { servers: ['unity'] })
    .filter((t) => on.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  return [...unity, ...harnessToolSpecs(agent)];
}

/** Names the model may call on this agent (anything else is refused and audited). */
export function allowedToolNames(agent: AgentConfig, specs: ToolSpec[]): Set<string> {
  return new Set(specs.map((s) => s.name));
}

export function fillerFor(tool: string): string | null {
  return AGENT_TOOLS[tool]?.filler ?? null;
}

// ── Prompt ───────────────────────────────────────────────────────────────────────────────────────────────────

export const VOICE_ADDENDUM = `

# THIS PHONE LINE (overrides the wording rules above where they differ)
- The greeting has already been played to the caller. Do not greet again; answer what they say.
- Exact lines are pre-recorded. Never say them yourself; call say_script:
  emergency -> say_script EMERGENCY_911, then offer a transfer; medical advice -> say_script NO_MEDICAL_ADVICE;
  records system down -> say_script RECORDS_DOWN, then offer a transfer or a message; identity not verifiable after two searches -> say_script CANT_VERIFY.
- A person on request: call transfer_to_staff (it plays the transfer line itself; say nothing before it). If a transfer fails you will be told; then offer a message.
- When the caller is done: call end_call (it says goodbye and hangs up).
- When a lookup takes a moment, a very short "One moment." is fine; never read IDs, codes or tool text aloud.
- Notes that start with "ORCHESTRATOR:" come from the phone system, not from the caller.`;

export function promptTemplate(agent: AgentConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (agent.prompt_source === 'custom') return agent.custom_prompt + VOICE_ADDENDUM;
  const file = env.VOICE_PROMPT_FILE || path.join(process.cwd(), 'retell-prompts', 'unity-healthcare-agent.md');
  return fs.readFileSync(file, 'utf8') + VOICE_ADDENDUM;
}

/** Fill {{variables}} like Retell does. Unknown variables become UNKNOWN. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_/.-]+)\s*\}\}/g, (_m, k: string) => (k in vars ? vars[k] : 'UNKNOWN'));
}

export function nowInClinicTz(now = new Date(), tz = process.env.CLINIC_TIMEZONE || 'America/Boise'): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now);
}
