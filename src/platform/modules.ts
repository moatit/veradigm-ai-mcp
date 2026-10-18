import type { Express } from 'express';
import { PlatformModule, registerModule } from './registry';
import { onCallModule } from '../unity/oncall/notebook';
import { schedulingModule } from './modules/scheduling';
import { outreachModule } from './modules/outreach';
import { huddleModule } from './modules/huddle';
import { activityModule, mountRetellWebhook } from './modules/activity';
import { mountRetellInbound } from './modules/activity/retell-inbound';
import { intakeModule, mountFaxWebhook } from './modules/intake';
import { veradigmModule } from './modules/veradigm';
import { complianceModule } from './modules/compliance';

/**
 * Every Drawbridge platform module, in registration order. Add one import + one entry per new module.
 */
const ALL_MODULES: PlatformModule[] = [
  onCallModule,
  schedulingModule,
  outreachModule,
  huddleModule,
  activityModule,
  intakeModule,
  veradigmModule,
  complianceModule,
];

/** Names ENABLED_MODULES accepts: oncall, scheduling, outreach, huddle, activity, intake, veradigm, compliance. */
export const MODULE_NAMES: string[] = ALL_MODULES.map((m) => m.name);

/** Settings that mean the phone agent's webhooks are live on this server (activity/retell-signature.ts). */
const PHONE_WEBHOOK_SETTINGS = ['RETELL_WEBHOOK_SECRET', 'RETELL_WEBHOOK_API_KEY', 'RETELL_API_KEY'];

/**
 * The modules this server runs.
 *
 *   ENABLED_MODULES   unset or blank: every module, exactly as before this setting existed.
 *                     set: a comma-separated list of module names (case-insensitive, e.g. "intake,activity,veradigm");
 *                     only those register (their staff screens, nav items, agent tools, APIs and background jobs).
 *                     An unknown name is a startup error, so a typo never silently turns a module off.
 *                     Leaving out "activity" while the phone agent's webhook settings are present is a startup error
 *                     too: activity holds the call events, the staff access audit and the disclosure report.
 * The webhooks follow the same switch (mountModuleWebhooks): a module that is off answers its webhook with 503, so
 * the sender keeps retrying instead of getting a 204 for a delivery nothing will handle.
 */
export function enabledModules(env: NodeJS.ProcessEnv = process.env): PlatformModule[] {
  const raw = String(env.ENABLED_MODULES ?? '').trim();
  if (!raw) return [...ALL_MODULES];
  const names = raw
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter((n) => !MODULE_NAMES.includes(n));
  if (unknown.length) {
    throw new Error(`ENABLED_MODULES: unknown module name(s) ${unknown.map((n) => `"${n}"`).join(', ')}. Known modules: ${MODULE_NAMES.join(', ')}.`);
  }
  const phoneSettings = PHONE_WEBHOOK_SETTINGS.filter((k) => String(env[k] || '').trim());
  if (!names.includes('activity') && phoneSettings.length) {
    throw new Error(
      `ENABLED_MODULES leaves out "activity", but the phone agent's webhook settings are present (${phoneSettings.join(', ')}). ` +
        'Activity holds the call events, the staff access audit and the disclosure report: add "activity", or remove those settings on a server without the phone agent.'
    );
  }
  return ALL_MODULES.filter((m) => names.includes(m.name));
}

/** Register the enabled modules once at startup (all of them unless ENABLED_MODULES is set). */
let loaded = false;
export function loadPlatformModules(env: NodeJS.ProcessEnv = process.env): void {
  if (loaded) return;
  const modules = enabledModules(env); // throws on an unknown name, before anything registers
  loaded = true;
  for (const m of modules) registerModule(m);
  if (String(env.ENABLED_MODULES ?? '').trim()) console.log(`[Drawbridge] ENABLED_MODULES: ${modules.map((m) => m.name).join(', ')}`);
}

/** True when this module runs on this server (ENABLED_MODULES unset or blank, or the module is listed). */
export function moduleEnabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return enabledModules(env).some((m) => m.name === name);
}

/**
 * The machine webhooks that feed a module, mounted before express.json() (they verify the raw body):
 *  - activity: POST /webhooks/retell (call events) and POST /webhooks/retell-inbound (call start)
 *  - intake:   POST /webhooks/moatit-fax (fax deliveries)
 * When the module is off, its paths answer 503 with Retry-After, so the sender retries and alerts instead of
 * getting a 204 for something nothing on this server will handle. With ENABLED_MODULES unset all are mounted as before.
 */
export function mountModuleWebhooks(app: Express, opts: { onCallStart?: () => void } = {}, env: NodeJS.ProcessEnv = process.env): void {
  const off = (path: string, module: string) => {
    console.warn(`[Drawbridge] ${path} answers 503: module "${module}" is not in ENABLED_MODULES`);
    app.post(path, (_req, res) => {
      res.status(503).set('Retry-After', '300').type('text/plain').send('Not available on this server.');
    });
  };
  if (moduleEnabled('activity', env)) {
    mountRetellWebhook(app);
    mountRetellInbound(app, opts.onCallStart);
  } else {
    off('/webhooks/retell', 'activity');
    off('/webhooks/retell-inbound', 'activity');
  }
  if (moduleEnabled('intake', env)) mountFaxWebhook(app);
  else off('/webhooks/moatit-fax', 'intake');
}
