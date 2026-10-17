import { APP_BASE, esc, fmtTime } from './shell';
import { helpdeskSummary } from './helpdesk';
import type { SystemStatus, StatusSnapshot } from './system-status';

/**
 * SYSTEM STATUS on the staff dashboard: a banner above every signed-in page while the Veradigm connection
 * is down or degraded, and a status card on the Overview and "Veradigm connection" screens.
 * Client-facing names only (Veradigm® PM / Veradigm® EHR). No patient data.
 */
const LABEL: Record<string, string> = { PM: 'Veradigm® PM', EHR: 'Veradigm® EHR' };
const STATE_PILL: Record<string, string> = {
  up: '<span class="pill ok">UP</span>',
  down: '<span class="pill urgent">DOWN</span>',
  degraded: '<span class="pill warn">DEGRADED</span>',
  unknown: '<span class="pill">NOT CHECKED YET</span>',
};

function downLine(s: StatusSnapshot): string {
  return s.components
    .filter((c) => c.state === 'down')
    .map(
      (c) =>
        `${esc(LABEL[c.target] || c.target)}: DOWN since ${esc(fmtTime(c.since, 'time'))}` +
        (c.last_error_class ? ` — ${esc(c.last_error_detail || c.last_error_class)}${c.last_error_detail ? ` (${esc(c.last_error_class)})` : ''}` : '')
    )
    .join(' · ');
}

export function statusBanner(status: SystemStatus): string {
  const s = status.snapshot();
  if (s.overall !== 'down' && s.overall !== 'degraded') return '';
  const o = s.outage;
  const alert = o?.down_alerted ? `Help desk notified ${esc(fmtTime(o.last_alert_at, 'time'))}.` : s.helpdesk_configured ? 'Notifying the help desk…' : 'Help-desk alerts are not configured: call MOATiT support.';
  const agent = s.overall === 'down' ? 'The phone agent is telling callers it cannot reach their records and is taking messages.' : 'Some phone-agent requests may fail.';
  return `<div role="alert" class="notice urgent">
SYSTEM STATUS: ${s.overall === 'down' ? 'Veradigm® connection DOWN' : 'Veradigm® connection DEGRADED'} — ${downLine(s)}.
<span style="font-weight:400">${agent}${o ? ` Messages taken: ${esc(o.messages_taken)}.` : ''} ${alert}</span> <a href="${APP_BASE}/veradigm" style="color:inherit">Details</a></div>`;
}

/** The status card (Overview and Veradigm connection). `full` adds the history. */
export function statusCard(status: SystemStatus | null, full = false): string {
  if (!status) return '';
  const s = status.snapshot();
  const hd = helpdeskSummary();
  const rows = s.components
    .map(
      (c) => `<tr><td>${esc(LABEL[c.target] || c.target)}</td><td>${STATE_PILL[c.state] || esc(c.state)}${c.since ? ` <span class="muted" style="font-size:12px">since ${esc(fmtTime(c.since))}</span>` : ''}</td>
<td>${c.last_ok_at ? esc(fmtTime(c.last_ok_at)) : '—'}</td><td>${c.last_probe_at ? esc(fmtTime(c.last_probe_at, 'time')) : '—'}</td>
<td class="muted" style="font-size:12px">${c.last_error_class ? `${esc(c.last_error_class)}${c.last_error_detail ? ` · ${esc(c.last_error_detail)}` : ''}${c.last_error_at ? ` · ${esc(fmtTime(c.last_error_at))}` : ''}` : '—'}</td></tr>`
    )
    .join('');
  const outage = s.outage
    ? `<p style="margin:8px 0 0">Outage since ${esc(fmtTime(s.outage.started_at))} · messages taken by the phone agent: <strong>${esc(s.outage.messages_taken)}</strong> · help-desk alerts sent: ${esc(s.outage.alerts_sent)}${s.outage.last_alert_at ? ` (last ${esc(fmtTime(s.outage.last_alert_at))})` : ''}</p>`
    : '';
  const history =
    full && s.history.length
      ? `<h3>Status history</h3><table><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead><tbody>${s.history
          .slice(0, 30)
          .map((h) => `<tr><td>${esc(fmtTime(h.at))}</td><td>${esc(h.event)}</td><td class="muted" style="font-size:12px">${esc(h.detail)}</td></tr>`)
          .join('')}</tbody></table>`
      : '';
  return `<div class="card"><div class="row"><strong>System status</strong>${STATE_PILL[s.overall] || ''}<span class="muted" style="font-size:13px">Veradigm® connection, checked every few minutes</span></div>
<div class="scroll"><table style="margin-top:8px"><thead><tr><th>System</th><th>Status</th><th>Last OK</th><th>Last check</th><th>Last error</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No Veradigm® system is configured.</td></tr>'}</tbody></table></div>
${outage}<p class="muted" style="font-size:13px;margin:8px 0 0">Help desk: ${hd.transports.length ? `${esc(hd.transports.join(' and '))} to ${esc(hd.to)}` : 'alerts not configured'}. One alert when the connection goes down, a reminder while it stays down, one when it recovers.</p>${history}</div>`;
}
