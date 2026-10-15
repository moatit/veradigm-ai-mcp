import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { NextFunction, Request, Response, Router } from 'express';
import { isToolFailure } from '../../../unity/utils/tool-result';
import type { PlatformDeps, PlatformModule } from '../../registry';
import { page } from '../../shell';
import { clinicToday, toMdy } from './dates';
import { findOpenings } from './openings';
import { SchedulingTools } from './scheduling.tools';
import { dayPage, fromInput, openingsPage } from './screens';

/**
 * Drawbridge module: staff assistant and scheduling reads (deck slides 6 and 9; spec §3 Planned tools).
 *
 * Agent tools (all read only, Veradigm® PM unless noted):
 *   unity_get_day_schedule          GetSchedule (STAFF ONLY)
 *   unity_get_providers             GetResources
 *   unity_get_location_hours        GetLocation (Veradigm® EHR); CLINIC_HOURS when no hours on file
 *   unity_get_changed_appointments  GetAppointmentsByChangeDTTM (STAFF ONLY)
 *   unity_get_patient_recalls       GetRecalls
 *   drawbridge_find_openings        "who has an opening Tuesday afternoon?" → unity_get_open_slots, grouped by provider
 *
 * Screens: /app/assistant (question box + structured search) and /app/assistant/day?date=MM/DD/YYYY.
 *
 * Env: CLINIC_TIMEZONE (what "today" means), CLINIC_HOURS (fallback hours), CLINIC_LOCATION_ID (default GetLocation ID).
 */

const FIND_OPENINGS: Tool = {
  name: 'drawbridge_find_openings',
  description:
    'STAFF ONLY. Answer "who has an opening Tuesday afternoon?" from Veradigm PM open slots, grouped by provider. ' +
    'Pass the staff question as `question`, or structured startDate/endDate (MM/DD/YYYY), partOfDay and providerId.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Natural-language question, e.g. "any openings for Dr. Lee next week morning"' },
      startDate: { type: 'string', description: 'First date, MM/DD/YYYY (overrides the question)' },
      endDate: { type: 'string', description: 'Last date, MM/DD/YYYY (defaults to startDate)' },
      partOfDay: { type: 'string', enum: ['morning', 'afternoon', 'any'], description: 'morning = before 12:00, afternoon = 12:00-17:00' },
      providerId: { type: 'string', description: 'Provider (resource) ID from unity_get_providers' },
    },
    required: [],
  },
};

/** Express 4 doesn't catch async rejections; never leave a staff request hanging. */
const safe =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch((e) => {
      console.error(`[Drawbridge scheduling] screen failed: ${e?.name || 'Error'}`);
      next(e);
    });
  };

const user = (req: Request) => (req as any).drawbridgeUser as string;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Provider list for the screens' dropdowns; null when it can't be loaded (the screens fall back to an ID box). */
async function providerList(deps: PlatformDeps) {
  const r = await deps.runTool('unity_get_providers', {});
  return isToolFailure(r) || !Array.isArray(r?.providers) ? null : r.providers;
}

export function createSchedulingModule(): PlatformModule {
  let deps: PlatformDeps | null = null;
  let tools: SchedulingTools | null = null;
  const attach = (d: PlatformDeps) => {
    if (deps === d && tools) return;
    deps = d;
    tools = new SchedulingTools(d.unity);
  };

  return {
    name: 'scheduling',
    nav: { path: '/assistant', label: 'Staff assistant', order: 20 },

    getTools: () => [...SchedulingTools.definitions(), FIND_OPENINGS],

    async run(name, args, ctx) {
      if (!deps || !tools) throw new Error('Scheduling module is not started');
      switch (name) {
        case 'unity_get_day_schedule':
          return tools.getDaySchedule(args);
        case 'unity_get_providers':
          return tools.getProviders();
        case 'unity_get_location_hours':
          return tools.getLocationHours(args);
        case 'unity_get_changed_appointments':
          return tools.getChangedAppointments(args);
        case 'unity_get_patient_recalls':
          return tools.getPatientRecalls(args);
        case 'drawbridge_find_openings':
          return findOpenings(deps, args || {}, ctx);
      }
      throw new Error(`Unknown tool ${name}`);
    },

    start(d) {
      attach(d);
    },

    appRouter(d) {
      attach(d);
      const router = Router();

      router.get(
        '/',
        safe(async (req, res) => {
        const q = str(req.query.q).slice(0, 300);
        const isForm = str(req.query.form) === '1';
        const start = fromInput(req.query.start);
        const end = fromInput(req.query.end);
        const part = ['morning', 'afternoon', 'any'].includes(str(req.query.part)) ? str(req.query.part) : 'any';
        const provider = str(req.query.provider).slice(0, 40);

        let result: any = null;
        if (q) result = await d.runTool('drawbridge_find_openings', { question: q });
        else if (isForm && start) {
          result = await d.runTool('drawbridge_find_openings', {
            startDate: start,
            endDate: end || start,
            partOfDay: part,
            ...(provider ? { providerId: provider } : {}),
          });
        }
        const providers = await providerList(d);
        res.send(
          page(
            'Staff assistant · Drawbridge',
            openingsPage({ q, start, end, part, provider, providers, result, today: toMdy(clinicToday()) }),
            { user: user(req), active: '/assistant' }
          )
        );
        })
      );

      router.get(
        '/day',
        safe(async (req, res) => {
        const date = fromInput(req.query.date) || toMdy(clinicToday());
        const provider = str(req.query.provider).slice(0, 40);
        const [result, providers] = await Promise.all([
          d.runTool('unity_get_day_schedule', { date, ...(provider ? { providerId: provider } : {}) }),
          providerList(d),
        ]);
        res.send(
          page('Day schedule · Drawbridge', dayPage({ date, provider, providers, result }), { user: user(req), active: '/assistant' })
        );
        })
      );

      return router;
    },
  };
}

export const schedulingModule = createSchedulingModule();
