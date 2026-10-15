import { Router } from 'express';
import { PlatformModule } from '../../registry';
import { esc, fmtTime, page } from '../../shell';
import { getUnityDiagnostics, LastLogsRecord, ServerInfoSummary } from '../../../unity/services/unity-diagnostics';

/**
 * Drawbridge module: Veradigm connection (staff screen /app/veradigm, read only).
 * Shows what GetServerInfo reported for Veradigm® PM and Veradigm® EHR (product, version, time zone)
 * and the troubleshooting entries Drawbridge fetched with LastLogs after a Veradigm-side error
 * (src/unity/services/unity-diagnostics.ts). No patient data is shown or stored here.
 */
const SYSTEM_LABEL: Record<string, string> = { PM: 'Veradigm® PM', EHR: 'Veradigm® EHR' };

function infoCard(i: ServerInfoSummary): string {
  const pill =
    i.status === 'ok'
      ? '<span class="pill ok">connected</span>'
      : i.status === 'unavailable'
        ? '<span class="pill warn">unavailable</span>'
        : '<span class="pill">not checked yet</span>';
  return `<div class="card"><div class="row"><strong>${esc(SYSTEM_LABEL[i.target] || i.target)}</strong>${pill}</div>
<dl style="margin-top:8px"><dt>Product</dt><dd>${esc(i.product) || '—'}</dd><dt>Version</dt><dd>${esc(i.version) || '—'}</dd>
<dt>Time zone</dt><dd>${esc(i.time_zone) || '—'}</dd><dt>Server time</dt><dd>${esc(i.server_time) || '—'}</dd>
<dt>Checked</dt><dd>${i.checked_at ? esc(fmtTime(i.checked_at)) : '—'}${i.error_code ? ` <span class="muted">(${esc(i.error_code)})</span>` : ''}</dd></dl></div>`;
}

function logRow(r: LastLogsRecord): string {
  const entries = r.entries.length
    ? `<ul>${r.entries.map((e) => `<li><span class="muted">${esc(e.timestamp)}</span> ${esc(e.action)} ${esc(e.message)}</li>`).join('')}</ul>`
    : `<span class="muted">${r.status === 'ok' ? 'No entries returned' : `Troubleshooting log unavailable (${esc(r.error_code)})`}</span>`;
  return `<tr><td>${esc(fmtTime(r.at))}</td><td>${esc(SYSTEM_LABEL[r.target] || r.target)}</td><td>${esc(r.trigger_action)}<br><span class="muted">${esc(r.trigger_code)}</span></td><td>${entries}</td></tr>`;
}

export const veradigmModule: PlatformModule = {
  name: 'veradigm',
  nav: { path: '/veradigm', label: 'Veradigm connection', order: 80 },

  appRouter() {
    const router = Router();
    router.get('/', (req, res) => {
      const d = getUnityDiagnostics();
      const body = d
        ? `<h2 style="margin-top:4px">Veradigm connection</h2><div class="grid">${d.serverInfo().map(infoCard).join('') || '<div class="card muted">No Veradigm® system is configured.</div>'}</div>
<h2>Troubleshooting log</h2><p class="muted" style="font-size:13px">Fetched from Veradigm after a Veradigm-side error, at most once a minute per system. Dates and long numbers are masked.</p>
${(() => {
  const rows = d.lastLogs();
  return rows.length
    ? `<div class="card scroll"><table><thead><tr><th>When</th><th>System</th><th>After</th><th>Entries</th></tr></thead><tbody>${rows.map(logRow).join('')}</tbody></table></div>`
    : '<div class="card empty muted">No Veradigm-side errors recorded.</div>';
})()}`
        : '<div class="card muted">This server does not connect to Veradigm.</div>';
      res.send(page('Veradigm connection · Drawbridge', body, { user: (req as any).drawbridgeUser, active: '/veradigm' }));
    });
    return router;
  },
};
