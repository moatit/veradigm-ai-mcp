import { Router } from 'express';
import { PlatformModule } from '../../registry';
import { esc, page } from '../../shell';
import { LAST_SECURITY_CHECKS, ORGANIZATIONAL_SAFEGUARDS, SAFEGUARDS, SECURITY_CONTACT, SafeguardSection, statusBadge } from './safeguards';

/**
 * Drawbridge module: "HIPAA & Compliance" (/app/compliance), for signed-in staff and the clinic practice managers
 * they point to it. Plain language only: no code paths, settings, secrets or host names. Built from the same
 * SAFEGUARDS list as docs/drawbridge/HIPAA_TECHNICAL_SAFEGUARDS.md (safeguards.ts), so the two never drift.
 */
const SECTIONS: SafeguardSection[] = ['Administrative safeguards', 'Physical safeguards', 'Technical safeguards', 'Business associates', 'Privacy Rule', 'Breach notification'];

export function compliancePage(): string {
  const counts = { inPlace: 0, deployment: 0, organizational: 0 };
  for (const s of SAFEGUARDS) {
    const b = statusBadge(s.status).label;
    if (b === 'In place') counts.inPlace++;
    else if (b === 'Deployment') counts.deployment++;
    else counts.organizational++;
  }
  const sections = SECTIONS.map((sec) => {
    const rows = SAFEGUARDS.filter((s) => s.section === sec);
    if (!rows.length) return '';
    return `<h2>${esc(sec)}</h2><div class="card scroll"><table><thead><tr><th style="width:150px">HIPAA</th><th>Requirement</th><th>How Drawbridge meets it</th><th style="width:120px">Status</th></tr></thead><tbody>${rows
      .map((s) => {
        const b = statusBadge(s.status);
        return `<tr><td style="white-space:nowrap">§ ${esc(s.citation)}</td><td>${esc(s.requirement)}</td><td>${esc(s.plain)}</td><td><span class="pill ${b.kind}">${esc(b.label)}</span></td></tr>`;
      })
      .join('')}</tbody></table></div>`;
  }).join('');

  const org = `<h2>MOATiT organizational safeguards</h2><div class="card"><ul>${ORGANIZATIONAL_SAFEGUARDS.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
<p class="muted" style="font-size:13px;margin-bottom:0">Confirmed by MOATiT on October 15, 2026.</p></div>`;

  const checks = `<h2>Last security checks</h2><div class="card scroll"><table><thead><tr><th>Date</th><th>Check</th><th>Result</th></tr></thead><tbody>${LAST_SECURITY_CHECKS.map(
    (c) => `<tr><td style="white-space:nowrap">${esc(c.date)}</td><td>${esc(c.check)}</td><td>${esc(c.result)}</td></tr>`
  ).join('')}</tbody></table></div>`;

  const contact = `<div class="card" style="border-color:var(--accent)"><strong>Security questions or to report an incident:</strong>
<a href="mailto:${esc(SECURITY_CONTACT.email)}">${esc(SECURITY_CONTACT.email)}</a> · ${esc(SECURITY_CONTACT.phone)} (24/7 help desk)</div>`;

  return `<h2 style="margin-top:4px">HIPAA &amp; Compliance</h2>
<p>How Drawbridge, MOATiT’s connection between the VeradigmAI phone agent, your staff and Veradigm® EHR and Veradigm® PM, protects your patients’ information under the HIPAA Security Rule and Privacy Rule. MOATiT is your business associate.</p>
<div class="grid">
<div class="card"><div class="muted">In place in Drawbridge</div><div class="stat">${esc(counts.inPlace)}</div></div>
<div class="card"><div class="muted">Hosting (deployment)</div><div class="stat">${esc(counts.deployment)}</div></div>
<div class="card"><div class="muted">MOATiT policy (organizational)</div><div class="stat">${esc(counts.organizational)}</div></div></div>
${contact}
<p class="muted" style="font-size:13px"><span class="pill ok">In place</span> built into Drawbridge and tested. <span class="pill warn">Deployment</span> provided by how Drawbridge is hosted (encrypted storage, encrypted connections, backups). <span class="pill">Organizational</span> covered by MOATiT’s written policies and agreements.</p>
${sections}${org}${checks}${contact}`;
}

export const complianceModule: PlatformModule = {
  name: 'compliance',
  nav: { path: '/compliance', label: 'HIPAA & Compliance', order: 80 },
  appRouter() {
    const router = Router();
    router.get('/', (req, res) => {
      res.send(page('HIPAA & Compliance · Drawbridge', compliancePage(), { user: (req as any).drawbridgeUser, active: '/compliance' }));
    });
    return router;
  },
};
