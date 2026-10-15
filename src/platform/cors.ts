import cors from 'cors';
import type { RequestHandler } from 'express';

/**
 * CORS for the HTTP servers: an explicit allow-list, never `*`.
 *
 *   DRAWBRIDGE_CORS_ORIGINS   comma-separated origins allowed to call from a browser, exact match
 *                             (e.g. "https://admin.veradigmai.com"). Unset or empty: no CORS headers
 *                             at all, so browsers only allow same-origin calls. Retell and other
 *                             server-to-server callers are not affected by CORS.
 */
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.DRAWBRIDGE_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => /^https?:\/\/[^\s/]+$/i.test(s) && s !== '*');
}

export function corsFromEnv(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const allowed = new Set(corsOrigins(env));
  return cors({
    origin: (origin, cb) => cb(null, !!origin && allowed.has(origin)),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-drawbridge-key', 'x-api-key', 'x-call-id', 'x-mcp-channel'],
    credentials: false,
  });
}
