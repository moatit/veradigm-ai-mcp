import { createHash, timingSafeEqual } from 'crypto';
import express, { Express, NextFunction, Request, Response } from 'express';
import { auditToolCall } from './audit';
import { auditedUnity } from './audited-unity';
import { platformModules, PlatformDeps, PlatformModule } from './registry';
import { clientIp, throttledSecurityEvent, viewMonitor } from './security-events';
import { APP_BASE, esc, navItems, page, registerNav, requireLogin, shellRouter } from './shell';
import { errorSummary } from '../utils/safe-log';
import { getSystemStatus } from './system-status';
import { statusCard } from './status-ui';

/**
 * A staff screen tells the access audit which patient (and which object) it showed or changed:
 * `auditPatient(res, patientId, object?)` before sending. Opaque IDs only, never names.
 */
export function auditPatient(res: Response, patientId: unknown, object?: string): void {
  if (patientId !== undefined && patientId !== null && patientId !== '') res.locals.auditPatientId = String(patientId);
  if (object) res.locals.auditObject = object;
}

/**
 * Staff access audit (HIPAA 164.312(b)): one audit line per staff screen request of a module, written when the
 * response is finished. GET → kind "view", anything else → kind "staff". Holds the user, the module and path
 * (opaque IDs only; the query string is never recorded), the patient ID the screen set with auditPatient(), the
 * HTTP outcome and latency. A patient-specific screen also counts toward the per-user view volume alert.
 */
export function staffAudit(moduleName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const t0 = Date.now();
    const path = String(req.originalUrl || '').split('?')[0];
    res.on('finish', () => {
      try {
        const user = String((req as any).drawbridgeUser || '');
        const patientId = res.locals.auditPatientId || '';
        const object = res.locals.auditObject || path;
        const view = req.method === 'GET' || req.method === 'HEAD';
        auditToolCall({
          server: 'unity',
          kind: view ? 'view' : 'staff',
          tool: `${moduleName}_${view ? 'view' : 'action'}`,
          patientId,
          success: res.statusCode < 400,
          errorCode: res.statusCode >= 400 ? `HTTP_${res.statusCode}` : undefined,
          latencyMs: Date.now() - t0,
          channel: 'staff_app',
          user,
          object,
        });
        if (patientId && user) viewMonitor.record(user, clientIp(req));
      } catch {
        // never into the request path
      }
    });
    next();
  };
}

/** Constant-time compare of two secrets of any length. */
function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/**
 * Shared-secret check for machine endpoints (Retell tool calls, webhooks, schedulers, test and
 * diagnostics routes). Set DRAWBRIDGE_TOOL_KEY and send it as `x-drawbridge-key` (Retell: custom
 * function header). Fails closed: when the key is unset every such request gets 503 "not configured".
 */
let warned = false;
export function requireToolKey(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.DRAWBRIDGE_TOOL_KEY;
  if (!key) {
    if (!warned) {
      console.warn('[Drawbridge] DRAWBRIDGE_TOOL_KEY is not set: tool endpoints refuse every request (503) until it is.');
      warned = true;
    }
    res.status(503).json({ error: 'not configured' });
    return;
  }
  const given = String(req.headers['x-drawbridge-key'] || '');
  if (given && safeEqual(given, key)) {
    next();
    return;
  }
  // Security event (at most one a minute per client and path): someone without the key is calling a PHI endpoint.
  throttledSecurityEvent('tool_key_rejected', { ip: clientIp(req), code: given ? 'WRONG_KEY' : 'NO_KEY', object: req.path });
  res.status(401).json({ error: 'unauthorized' });
}

/**
 * The phone agent's own key, for the Retell custom-function route (POST /api/retell on both servers) only.
 *
 *   DRAWBRIDGE_AGENT_KEY   set: /api/retell accepts this key and nothing else (DRAWBRIDGE_TOOL_KEY is refused there),
 *                          and no other route accepts it. The key that sits in the Retell dashboard then opens only
 *                          the per-call-gated agent tools, never MCP, /tools, test, diagnostics or module APIs.
 *                          unset: /api/retell falls back to DRAWBRIDGE_TOOL_KEY (one warning), so agents configured
 *                          before this setting keep working until their header is switched.
 * Same comparison, 503/401 and security event as requireToolKey; the key is never logged.
 */
let agentKeyWarned = false;
export function requireAgentKey(req: Request, res: Response, next: NextFunction): void {
  const agentKey = process.env.DRAWBRIDGE_AGENT_KEY || '';
  if (!agentKey) {
    if (!agentKeyWarned) {
      console.warn('[Drawbridge] DRAWBRIDGE_AGENT_KEY is not set: /api/retell accepts DRAWBRIDGE_TOOL_KEY. Give the phone agent its own key.');
      agentKeyWarned = true;
    }
    requireToolKey(req, res, next);
    return;
  }
  if (!agentKeyWarned && process.env.DRAWBRIDGE_TOOL_KEY && safeEqual(agentKey, process.env.DRAWBRIDGE_TOOL_KEY)) {
    console.warn('[Drawbridge] DRAWBRIDGE_AGENT_KEY equals DRAWBRIDGE_TOOL_KEY: the phone agent key is not dedicated. Use two different keys.');
    agentKeyWarned = true;
  }
  const given = String(req.headers['x-drawbridge-key'] || '');
  if (given && safeEqual(given, agentKey)) {
    next();
    return;
  }
  throttledSecurityEvent('tool_key_rejected', { ip: clientIp(req), code: given ? 'WRONG_KEY' : 'NO_KEY', object: req.path });
  res.status(401).json({ error: 'unauthorized' });
}

/** Mount the staff app (/app), module screens and module APIs on the Express app. */
export function mountPlatform(app: Express, deps: PlatformDeps): void {
  const modules = platformModules();
  for (const m of modules) if (m.nav) registerNav(m.nav);
  registerNav({ path: '', label: 'Overview', order: 0 });
  // Drawbridge Admin (call reports, monitoring, client API keys): separate Next.js app
  if (process.env.ADMIN_PUBLIC_URL) registerNav({ path: process.env.ADMIN_PUBLIC_URL, label: 'Admin console', order: 90 });

  // Behind nginx / a tunnel: DRAWBRIDGE_TRUST_PROXY (hop count, e.g. 1) so the login lockout sees client IPs.
  const trustProxy = String(process.env.DRAWBRIDGE_TRUST_PROXY || '').trim();
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  app.use(APP_BASE, shellRouter());

  // Each module gets a Veradigm view that audits its direct actions (channel = module name).
  const depsFor = new Map<PlatformModule, PlatformDeps>(modules.map((m) => [m, { ...deps, unity: auditedUnity(deps.unity, m.name) }]));

  app.get(APP_BASE, requireLogin, (req, res) => {
    const cards = navItems()
      .filter((n) => n.path)
      .map((n) => {
        const href = /^https?:\/\//.test(n.path) ? n.path : `${APP_BASE}${n.path}`;
        return `<a class="card row" href="${esc(href)}" style="text-decoration:none"><strong>${esc(n.label)}</strong></a>`;
      })
      .join('');
    res.send(
      page(
        'Drawbridge',
        `<h2 style="margin-top:4px">Overview</h2>${statusCard(getSystemStatus())}<div class="grid">${cards || '<div class="card muted">No modules loaded.</div>'}</div>
<p class="muted" style="font-size:13px">Drawbridge connects the phone assistant and staff tools to Veradigm® EHR and Veradigm® PM through a fixed set of actions.</p>`,
        { user: (req as any).drawbridgeUser, active: '' }
      )
    );
  });

  for (const m of modules) {
    if (m.appRouter && m.nav) {
      app.use(`${APP_BASE}${m.nav.path}`, requireLogin, staffAudit(m.name), express.urlencoded({ extended: false }), m.appRouter(depsFor.get(m)!));
    }
    if (m.apiRouter) {
      app.use(`/api/${m.name}`, requireToolKey, express.json(), m.apiRouter(depsFor.get(m)!));
    }
  }

  // Old notebook URL
  app.get(['/oncall', '/oncall/*'], (_req, res) => res.redirect(`${APP_BASE}/oncall`));

  for (const m of modules) {
    try {
      m.start?.(depsFor.get(m)!);
    } catch (e) {
      console.error(`[Drawbridge] module ${m.name} failed to start: ${errorSummary(e)}`);
    }
  }
}
