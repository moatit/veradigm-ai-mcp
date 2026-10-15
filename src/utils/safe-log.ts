/**
 * One short, log-safe line for an error: HTTP status, error code and a trimmed message.
 *
 * Never log an axios error object itself: its `config` holds the request (URL query, headers and
 * body, i.e. passwords, tokens, client secrets and patient search terms) and its `response` holds
 * the reply (chart data). Use this instead of `console.error('...', error)`.
 */
export function errorSummary(error: unknown, max = 160): string {
  const e = error as any;
  const status = e?.response?.status ? `HTTP ${e.response.status}` : '';
  const code = typeof e?.code === 'string' ? e.code : '';
  const data = e?.response?.data;
  const fromData = data && typeof data === 'object' ? data.Error || data.error || data.message : '';
  const raw = (typeof fromData === 'string' && fromData) || e?.message || (typeof error === 'string' ? error : e?.name || 'error');
  const msg = String(raw).replace(/\s+/g, ' ').trim().slice(0, max);
  return [status, code, msg].filter(Boolean).join(' ');
}
