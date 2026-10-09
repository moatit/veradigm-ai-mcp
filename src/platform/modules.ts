import { registerModule } from './registry';
import { onCallModule } from '../unity/oncall/notebook';
import { schedulingModule } from './modules/scheduling';
import { outreachModule } from './modules/outreach';
import { huddleModule } from './modules/huddle';
import { activityModule } from './modules/activity';
import { intakeModule } from './modules/intake';

/**
 * Every Drawbridge platform module, registered once at startup.
 * Add one import + one registerModule line per new module.
 */
let loaded = false;
export function loadPlatformModules(): void {
  if (loaded) return;
  loaded = true;
  registerModule(onCallModule);
  registerModule(schedulingModule);
  registerModule(outreachModule);
  registerModule(huddleModule);
  registerModule(activityModule);
  registerModule(intakeModule);
}
