import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Router } from 'express';
import { UnityMCPError } from '../../../unity/utils/error-handler';
import type { PlatformDeps, PlatformModule } from '../../registry';
import { agentBrief, HuddleOptions, HuddleService } from './brief';
import { previsitCheck } from './previsit';
import { huddlePage } from './screen';

/**
 * Drawbridge module: morning huddle brief and pre-visit check (deck slide 9). Read only.
 *
 * Screen: /app/huddle (nav "Huddle brief").
 * Agent tools:
 *   drawbridge_previsit_check     phone agent, verified caller only
 *   drawbridge_get_huddle_brief   STAFF ONLY (future staff voice assistant); counts, no patient names
 */
let service: HuddleService | null = null;

/** Bind the module to the platform deps (called by start/appRouter; tests call it with fakes). */
export function initHuddle(deps: PlatformDeps, opts?: HuddleOptions): HuddleService {
  if (!service || service.deps !== deps || opts) service = new HuddleService(deps, opts);
  return service;
}

function svc(): HuddleService {
  if (!service) throw new UnityMCPError('Huddle module is not started', 'SERVER_ERROR');
  return service;
}

const TOOLS: Tool[] = [
  {
    name: 'drawbridge_previsit_check',
    description:
      "Pre-visit checklist for the caller's next appointment: confirms date, time and provider, insurance on file (carrier and last 4 of the member ID only), " +
      'any balance due, and reminds them to bring a medication list and photo ID and when to arrive. Read only. ' +
      "Use ONLY after the caller's identity has been verified and the patientId belongs to that verified caller. Never call it for an unverified caller. " +
      'Read the returned message to the caller; if an item says it could not be checked, say so rather than saying there is nothing on file.',
    inputSchema: {
      type: 'object',
      properties: { patientId: { type: 'string', description: 'Patient ID of the verified caller' } },
      required: ['patientId'],
    },
  },
  {
    name: 'drawbridge_get_huddle_brief',
    description:
      'STAFF ONLY. Never use on a patient call. Morning huddle summary for one clinic date from Veradigm PM: number of visits and providers, ' +
      "patients with a balance due, patients with no insurance on file, checks that couldn't be completed, and one line per provider. " +
      'Counts only, no patient names. Read only.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Clinic date: YYYY-MM-DD, MM/DD/YYYY, "today" or "tomorrow". Default today.' },
      },
    },
  },
];

export const huddleModule: PlatformModule = {
  name: 'huddle',
  nav: { path: '/huddle', label: 'Huddle brief', order: 25 },

  getTools: () => TOOLS,
  writeTools: [],

  async run(name, args) {
    if (name === 'drawbridge_previsit_check') return previsitCheck(svc().deps, args?.patientId);
    if (name === 'drawbridge_get_huddle_brief') return agentBrief(await svc().getBrief(args?.date));
    throw new Error(`Unknown tool ${name}`);
  },

  start(deps) {
    initHuddle(deps);
  },

  appRouter(deps) {
    initHuddle(deps);
    const router = Router();
    router.get('/', async (req, res) => {
      res.send(await huddlePage(svc(), req.query as any, (req as any).drawbridgeUser));
    });
    return router;
  },
};
