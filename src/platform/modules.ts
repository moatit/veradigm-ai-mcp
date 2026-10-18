import { PlatformModule, registerModule } from './registry';
import { onCallModule } from '../unity/oncall/notebook';
import { schedulingModule } from './modules/scheduling';
import { outreachModule } from './modules/outreach';
import { huddleModule } from './modules/huddle';
import { activityModule } from './modules/activity';
import { intakeModule } from './modules/intake';
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

/**
 * The modules this server runs.
 *
 *   ENABLED_MODULES   unset or blank: every module, exactly as before this setting existed.
 *                     set: a comma-separated list of module names (case-insensitive, e.g. "intake,activity,veradigm");
 *                     only those register (their staff screens, nav items, agent tools, APIs and background jobs).
 *                     An unknown name is a startup error, so a typo never silently turns a module off.
 * Only module registration is switched: the phone agent's webhooks and the fax webhook are mounted by the server
 * as before (the fax webhook stays closed until its secret is set).
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
