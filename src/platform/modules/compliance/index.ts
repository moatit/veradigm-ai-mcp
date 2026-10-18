import { Router } from 'express';
import { PlatformModule } from '../../registry';
import { esc, idleMinutes, page } from '../../shell';
import { SECURITY_CONTACT } from './safeguards';

/**
 * Drawbridge module: "HIPAA & Compliance" (/app/compliance) in the staff portal, now "Your part": only what clinic
 * staff themselves do (Ali, Oct 18, 2026). The full safeguards checklist (what Drawbridge and MOATiT do) lives in
 * the admin dashboard, built from docs/drawbridge/hipaa-safeguards.json, which `npm run docs:hipaa` generates from
 * the same SAFEGUARDS list (safeguards.ts) as docs/drawbridge/HIPAA_TECHNICAL_SAFEGUARDS.md.
 * Plain language only: no code paths, settings, host names or MOATiT/IT items.
 */
export function yourPartPage(): string {
  const contact = `<a href="mailto:${esc(SECURITY_CONTACT.email)}">${esc(SECURITY_CONTACT.email)}</a> or ${esc(SECURITY_CONTACT.phone)} (24/7 help desk)`;
  const items: Array<[string, string]> = [
    [
      'Use only your own sign-in',
      'Sign in with your own username, password and authenticator code. Never share them, write them where others can see them, or let someone work under your sign-in. If you lose your authenticator or think someone knows your password, tell the help desk right away.',
    ],
    [
      'Sign out when you step away',
      `Sign out when you leave your desk or finish for the day. Drawbridge also signs you out after ${idleMinutes()} minutes without activity and clears the screen.`,
    ],
    [
      'Keep patient details out of email and chat',
      'Do not put patient names, dates of birth or other patient details in email, text messages or chat. Point a colleague to the screen in Drawbridge or Veradigm® EHR instead.',
    ],
    [
      'Report anything that looks wrong',
      `A document under the wrong patient, a screen you should not see, a sign-in you did not make: tell the help desk the same day at ${contact}.`,
    ],
    [
      'Emergency access is for emergencies only',
      'The emergency login is only for when no named login works and patient care cannot wait. Everything opened with it is logged and reviewed by the privacy officer. Sign out as soon as the emergency is handled.',
    ],
  ];
  return `<h2 style="margin-top:4px">Your part</h2>
<p>Drawbridge takes care of the technical side of HIPAA. These five things are up to you.</p>
<div class="card">${items.map(([h, p], i) => `<h3${i ? '' : ' style="margin-top:0"'}>${esc(h)}</h3><p${i === items.length - 1 ? ' style="margin-bottom:0"' : ''}>${p}</p>`).join('\n')}</div>
<p class="muted" style="font-size:13px">Questions about your practice's own HIPAA policies go to your privacy officer.</p>`;
}

export const complianceModule: PlatformModule = {
  name: 'compliance',
  nav: { path: '/compliance', label: 'HIPAA & Compliance', order: 80 },
  appRouter() {
    const router = Router();
    router.get('/', (req, res) => {
      res.send(page('Your part in HIPAA · Drawbridge', yourPartPage(), { user: (req as any).drawbridgeUser, active: '/compliance' }));
    });
    return router;
  },
};
