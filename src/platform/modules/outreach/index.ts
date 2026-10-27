import { Router } from 'express';
import { PlatformDeps, PlatformModule } from '../../registry';
import { retentionDaysFrom, startDailyRetention } from '../../retention';
import { buildDailyList, LIST_HOUR, planSummary } from './daily';
import { dialMode, runDue } from './dialer';
import { clinicMinutes, isCallingDay } from './scheduler';
import { loadSettings, saveSettings } from './settings';
import { outreachJobs } from './store';
import { outreachRouter } from './screen';
import { OutreachTools } from './tools';
import { isoDate, todayInClinic } from './util';

/**
 * Drawbridge module: Call & Confirm (outbound confirmation calls, no-show follow-up, recall outreach).
 * Screen: /app/outreach. Agent tools (outbound Retell agent): drawbridge_outreach_context,
 * drawbridge_outreach_result. Machine API (tool key): GET /api/outreach/plan?days=7, GET/PUT /api/outreach/settings.
 * Reads Veradigm® PM; on a call the agent may only confirm/cancel (SetAppointmentStatus), move (SaveAppointment)
 * or leave a staff task (SaveTask). See README.md.
 */
const tools = new OutreachTools();

let ticking = false;
/** Scheduler tick (every minute, only when settings.enabled): the 07:00 list, then due attempts. */
async function tick(deps: PlatformDeps): Promise<void> {
  if (ticking) return;
  const settings = loadSettings();
  if (!settings.enabled) return;
  ticking = true;
  try {
    const now = new Date();
    const today = todayInClinic(now);
    const base = { unity: deps.unity, store: outreachJobs, settings, now, by: 'scheduler' };
    if (isCallingDay(today, settings) && clinicMinutes(now) >= LIST_HOUR * 60 && !outreachJobs.getList(isoDate(today))) {
      await buildDailyList(base);
    }
    const mode = dialMode(settings);
    await runDue({ ...base, mode, writes: mode === 'live' });
  } catch (e: any) {
    console.error(`[Outreach] scheduler tick failed: ${e?.code || e?.name || 'error'}`);
  } finally {
    ticking = false;
  }
}

export const outreachModule: PlatformModule = {
  name: 'outreach',
  nav: { path: '/outreach', label: 'Call & Confirm', order: 30 },

  getTools: () => tools.getTools(),
  async run(name, args, ctx) {
    if (name === 'drawbridge_outreach_context') return tools.context(args || {}, ctx);
    if (name === 'drawbridge_outreach_result') return tools.result(args || {}, ctx);
    throw new Error(`Unknown tool ${name}`);
  },

  appRouter: (deps) => outreachRouter(deps),

  /** Read-only plan summary and the per-practice settings, for the Drawbridge admin console. Counts only, no PHI. */
  apiRouter() {
    const router = Router();
    router.get('/plan', (req, res) => {
      try {
        res.json(planSummary(outreachJobs, loadSettings(), new Date(), Number(req.query.days) || 7));
      } catch (e: any) {
        console.error(`[Outreach] plan summary failed: ${e?.code || e?.name || 'error'}`);
        res.status(500).json({ success: false, error_code: 'PLAN_UNAVAILABLE', retryable: true });
      }
    });
    router.get('/settings', (_req, res) => res.json(loadSettings()));
    router.put('/settings', (req, res) => {
      const check = saveSettings(req.body);
      if (!check.ok) {
        res.status(400).json({ success: false, error_code: 'INVALID_SETTINGS', errors: check.errors });
        return;
      }
      console.log(`[Outreach] settings saved: enabled=${check.settings!.enabled} mode=${check.settings!.mode}`);
      res.json(check.settings);
    });
    return router;
  },

  start(deps) {
    startDailyRetention('outreach jobs', () => outreachJobs.prune(retentionDaysFrom('OUTREACH_RETENTION_DAYS')));
    const t = setInterval(() => void tick(deps), 60_000);
    t.unref?.();
  },
};
