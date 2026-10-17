import { Router } from 'express';
import { PlatformModule } from '../../registry';
import { APP_BASE, esc, fmtTime, page, requireAdmin } from '../../shell';
import { getUnityDiagnostics, LastLogsRecord, ServerInfoSummary } from '../../../unity/services/unity-diagnostics';
import { AuthLatch, getUnityAuth } from '../../../unity/services/unity-auth.service';
import { getSystemStatus } from '../../system-status';
import { statusCard } from '../../status-ui';
import { displayCode, displayText } from '../../display';

/**
 * Drawbridge module: Veradigm connection (staff screen /app/veradigm, read only except "Retry sign-in").
 * Shows what GetServerInfo reported for Veradigm® PM and Veradigm® EHR (product, version, time zone)
 * and the troubleshooting entries Drawbridge fetched with LastLogs after a Veradigm-side error
 * (src/unity/services/unity-diagnostics.ts). When Veradigm refused a sign-in (auth latch, unity-auth.service.ts)
 * a card says so; an administrator retries sign-in after the credentials are fixed (POST /retry-sign-in).
 * No patient data is shown or stored here.
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
<dt>Checked</dt><dd>${i.checked_at ? esc(fmtTime(i.checked_at)) : '—'}${i.error_code ? ` <span class="muted">(${esc(displayCode(i.error_code))})</span>` : ''}</dd></dl></div>`;
}

function latchCard(l: AuthLatch): string {
  return `<div class="card" style="border-color:var(--urgent)"><div class="row"><strong>${esc(SYSTEM_LABEL[l.target] || l.target)}: sign-in stopped</strong><span class="pill urgent">STOPPED</span></div>
<p style="margin:8px 0">${l.stage === 'unknown' ? `The sign-in latch file was unreadable at ${esc(fmtTime(l.at))}, so every sign-in was stopped (fail closed).` : `Veradigm refused ${esc(l.stage)} at ${esc(fmtTime(l.at))} (${esc(displayText(l.reason))}).`} Drawbridge sends nothing more for this system, so the account can't be locked out. Fix the credentials (a server restart loads new ones and clears this), or retry once Veradigm has unlocked the account.</p>
<form method="post" action="${APP_BASE}/veradigm/retry-sign-in" style="margin:0"><input type="hidden" name="target" value="${esc(l.target)}"><button>Retry sign-in</button> <span class="muted" style="font-size:13px">Administrators only. The next Veradigm call signs in once.</span></form></div>`;
}

function logRow(r: LastLogsRecord): string {
  const entries = r.entries.length
    ? `<ul>${r.entries.map((e) => `<li><span class="muted">${esc(e.timestamp)}</span> ${esc(displayText(e.action))} ${esc(displayText(e.message))}</li>`).join('')}</ul>`
    : `<span class="muted">${r.status === 'ok' ? 'No entries returned' : `Troubleshooting log unavailable (${esc(displayCode(r.error_code))})`}</span>`;
  return `<tr><td>${esc(fmtTime(r.at))}</td><td>${esc(SYSTEM_LABEL[r.target] || r.target)}</td><td>${esc(r.trigger_action)}<br><span class="muted">${esc(displayCode(r.trigger_code))}</span></td><td>${entries}</td></tr>`;
}

export const veradigmModule: PlatformModule = {
  name: 'veradigm',
  nav: { path: '/veradigm', label: 'Veradigm connection', order: 80 },

  appRouter() {
    const router = Router();
    router.get('/', (req, res) => {
      const d = getUnityDiagnostics();
      const body = d
        ? `<h2 style="margin-top:4px">Veradigm connection</h2>${(getUnityAuth()?.latchedTargets() || []).map(latchCard).join('')}${statusCard(getSystemStatus(), true)}<div class="grid">${d.serverInfo().map(infoCard).join('') || '<div class="card muted">No Veradigm® system is configured.</div>'}</div>
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
    // Clear the auth latch for one system (administrators; the shell refuses cross-site POSTs, the staff audit logs
    // the action and the auth service writes the security event unity_signin_retry with the user).
    router.post('/retry-sign-in', requireAdmin, (req, res) => {
      const target = String(req.body?.target || '');
      if (target === 'PM' || target === 'EHR') getUnityAuth()?.retrySignIn(target, String((req as any).drawbridgeUser || ''));
      res.redirect(303, `${APP_BASE}/veradigm`);
    });
    return router;
  },
};
