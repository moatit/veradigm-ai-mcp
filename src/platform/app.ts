import { createHash, timingSafeEqual } from 'crypto';
import express, { Express, NextFunction, Request, Response } from 'express';
import { platformModules, PlatformDeps } from './registry';
import { APP_BASE, esc, navItems, page, registerNav, requireLogin, shellRouter } from './shell';

/** Constant-time compare of two secrets of any length. */
function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/**
 * Shared-secret check for machine endpoints (Retell tool calls, webhooks, schedulers).
 * Set DRAWBRIDGE_TOOL_KEY and send it as `x-drawbridge-key` (Retell: custom function header).
 * When unset, requests are allowed but a warning is logged once — fine on localhost only.
 */
let warned = false;
export function requireToolKey(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.DRAWBRIDGE_TOOL_KEY;
  if (!key) {
    if (!warned) {
      console.warn('[Drawbridge] DRAWBRIDGE_TOOL_KEY is not set: tool endpoints are open. Set it before exposing a public URL.');
      warned = true;
    }
    next();
    return;
  }
  const given = String(req.headers['x-drawbridge-key'] || '');
  if (given && safeEqual(given, key)) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

/** Mount the staff app (/app), module screens and module APIs on the Express app. */
export function mountPlatform(app: Express, deps: PlatformDeps): void {
  const modules = platformModules();
  for (const m of modules) if (m.nav) registerNav(m.nav);
  registerNav({ path: '', label: 'Overview', order: 0 });

  app.use(APP_BASE, shellRouter());

  app.get(APP_BASE, requireLogin, (req, res) => {
    const cards = navItems()
      .filter((n) => n.path)
      .map(
        (n) => `<a class="card row" href="${APP_BASE}${n.path}" style="text-decoration:none"><strong>${esc(n.label)}</strong></a>`
      )
      .join('');
    res.send(
      page(
        'Drawbridge',
        `<h2 style="margin-top:4px">Overview</h2><div class="grid">${cards || '<div class="card muted">No modules loaded.</div>'}</div>
<p class="muted" style="font-size:13px">Drawbridge connects the VeradigmAI phone agent and staff tools to Veradigm® EHR and Veradigm® PM through a fixed set of actions.</p>`,
        { user: (req as any).drawbridgeUser, active: '' }
      )
    );
  });

  for (const m of modules) {
    if (m.appRouter && m.nav) {
      app.use(`${APP_BASE}${m.nav.path}`, requireLogin, express.urlencoded({ extended: false }), m.appRouter(deps));
    }
    if (m.apiRouter) {
      app.use(`/api/${m.name}`, requireToolKey, express.json(), m.apiRouter(deps));
    }
  }

  // Old notebook URL
  app.get(['/oncall', '/oncall/*'], (_req, res) => res.redirect(`${APP_BASE}/oncall`));

  for (const m of modules) {
    try {
      m.start?.(deps);
    } catch (e) {
      console.error(`[Drawbridge] module ${m.name} failed to start:`, e);
    }
  }
}
