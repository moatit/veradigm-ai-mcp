import { PlatformModule } from '../../registry';
import { outreachRouter } from './screen';
import { OutreachTools } from './tools';

/**
 * Drawbridge module: outreach (reminder calls, no-show follow-up, recall outreach; deck slide 9).
 * Screen: /app/outreach. Agent tools (outbound Retell agent): drawbridge_outreach_context,
 * drawbridge_outreach_result. Reads Veradigm® PM only; never writes to it. See README.md.
 */
const tools = new OutreachTools();

export const outreachModule: PlatformModule = {
  name: 'outreach',
  nav: { path: '/outreach', label: 'Outreach', order: 30 },

  getTools: () => tools.getTools(),
  async run(name, args, ctx) {
    if (name === 'drawbridge_outreach_context') return tools.context(args || {}, ctx);
    if (name === 'drawbridge_outreach_result') return tools.result(args || {}, ctx);
    throw new Error(`Unknown tool ${name}`);
  },

  appRouter: (deps) => outreachRouter(deps),
};
