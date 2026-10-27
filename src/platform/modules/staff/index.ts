import { Request, Response, Router } from 'express';
import { PlatformModule } from '../../registry';
import { APP_BASE, esc, fmtTime, page, requireAdmin, revokeStaffSessions, serverStaffNames, staffAccounts } from '../../shell';
import { clientIp, securityEvent } from '../../security-events';
import { inviteMailProblem, sendStaffInvite } from '../../staff-invite-mail';
import { AccountView } from '../../staff-accounts';

/**
 * Drawbridge module: "Staff logins" (/app/staff), Drawbridge administrators only. Each practice's Drawbridge manages
 * its own staff (Ali, Oct 19, 2026). An administrator invites someone by name and email; the email carries a one-time
 * link (24 h) where they choose their password and scan a QR code with an authenticator app, then they're signed in.
 * Resend (or reset, for an active login: lost phone, expired password) sends a new invitation and turns the old
 * password and authenticator off at once. Remove deletes the login and ends its sessions.
 * Logins from the server users file (npm run staff:user) are listed but can't be changed here.
 * Results are rendered directly (no redirect), so no email address ever goes into a URL.
 */

const ROLE_LABEL: Record<string, string> = { staff: 'Staff', admin: 'Drawbridge admin' };
const STATUS_LABEL: Record<AccountView['status'], string> = {
  invited: 'Invited (waiting for setup)',
  active: 'Active',
  'invitation expired': 'Invitation expired',
};

function screen(user: string, notice = '', error = ''): string {
  const managed = staffAccounts.list();
  const server = [...serverStaffNames()].sort();
  const mailProblem = inviteMailProblem();
  const rows = managed
    .map((a) => {
      const self = a.user === user;
      const resendLabel = a.status === 'active' ? 'Reset sign-in' : 'Resend invitation';
      const resendConfirm =
        a.status === 'active'
          ? `Reset ${a.name}'s sign-in? Their password and authenticator stop working now and they get a new invitation email.`
          : `Send ${a.name} a new invitation? The earlier link stops working.`;
      return `<tr><td>${esc(a.name)}<div class="muted" style="font-size:12px">${esc(a.user)}</div></td>
<td>${esc(ROLE_LABEL[a.role] || a.role)}</td><td>${esc(STATUS_LABEL[a.status])}</td>
<td style="font-size:13px">${esc(a.invitedBy)}<div class="muted">${esc(fmtTime(new Date(a.invitedAt), 'date'))}</div></td>
<td style="white-space:nowrap">${
        self
          ? '<span class="muted" style="font-size:12px">You</span>'
          : `<form method="post" action="${APP_BASE}/staff/resend" data-confirm="${esc(resendConfirm)}" style="display:inline"><input type="hidden" name="user" value="${esc(a.user)}"><button class="secondary">${esc(resendLabel)}</button></form>
<form method="post" action="${APP_BASE}/staff/remove" data-confirm="${esc(`Remove ${a.name}? They are signed out now and can't sign in again.`)}" style="display:inline"><input type="hidden" name="user" value="${esc(a.user)}"><button class="secondary">Remove</button></form>`
      }</td></tr>`;
    })
    .join('');
  return `<h2 style="margin-top:4px">Staff logins</h2>
<p>Invite the people who use Drawbridge here. Each person gets an email with a one-time link (24 hours) to choose a password and scan a QR code with an authenticator app on their phone.</p>
${notice ? `<div class="card" style="border-left:3px solid var(--ok,#1f7a4d)">${esc(notice)}</div>` : ''}
${error ? `<div class="card" style="border-left:3px solid var(--urgent)">${esc(error)}</div>` : ''}
${mailProblem ? `<div class="card" style="border-left:3px solid var(--urgent)">Invitation email isn't set up on this server (${esc(mailProblem)}). Invitations can't be sent until it is.</div>` : ''}
<div class="card"><h3 style="margin-top:0">Invite someone</h3>
<form method="post" action="${APP_BASE}/staff/invite">
<p><label>Name<input name="name" maxlength="80" required></label></p>
<p><label>Work email (their username)<input name="email" type="email" maxlength="254" autocomplete="off" required></label></p>
<p><label>Role<select name="role"><option value="staff">Staff</option><option value="admin">Drawbridge admin (Phone agent, Staff logins, access report)</option></select></label></p>
<button>Send invitation</button></form></div>
<div class="card"><h3 style="margin-top:0">Invited and managed here</h3>
${rows ? `<table><thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Invited by</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted" style="margin-bottom:0">No one yet.</p>'}</div>
<div class="card"><h3 style="margin-top:0">Managed on the server</h3>
<p class="muted" style="font-size:13px">These logins come from the server's users file. Change them with the server tool, not here.</p>
${server.length ? `<p style="margin-bottom:0">${server.map(esc).join(', ')}</p>` : '<p class="muted" style="margin-bottom:0">None.</p>'}</div>`;
}

function render(req: Request, res: Response, notice = '', error = '', status = 200): void {
  const user = (req as any).drawbridgeUser as string;
  res.status(status).send(page('Staff logins · Drawbridge', screen(user, notice, error), { user, active: '/staff' }));
}

async function invite(req: Request, res: Response, input: { email: unknown; name: unknown; role: unknown }, resend: boolean): Promise<void> {
  const by = (req as any).drawbridgeUser as string;
  const r = staffAccounts.invite({ ...input, by }, serverStaffNames());
  if (!r.ok) return render(req, res, '', r.error, 400);
  const email = String(input.email).trim().toLowerCase();
  // Re-inviting turns the old sign-in off now: its sessions end too.
  if (r.reinvite) revokeStaffSessions(email);
  securityEvent('staff_invited', { user: email, ip: clientIp(req), code: r.reinvite ? 'REINVITE' : 'NEW' });
  const sent = await sendStaffInvite({
    to: email,
    name: String(input.name).trim(),
    invitedBy: by,
    token: r.token,
    expiresAt: r.expiresAt,
    reset: resend && r.reinvite,
  });
  if (!sent) return render(req, res, '', 'The login was set up, but the invitation email could not be sent. Check the mail settings, then use Resend invitation.', 502);
  render(req, res, `Invitation sent to ${email}. The link works once, for 24 hours.`);
}

export const staffModule: PlatformModule = {
  name: 'staff',
  nav: { path: '/staff', label: 'Staff logins', order: 85 },
  appRouter() {
    const router = Router();
    router.use(requireAdmin);
    router.get('/', (req, res) => render(req, res));
    router.post('/invite', (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (staffAccounts.list().some((a) => a.user === email)) {
        return render(req, res, '', 'That person already has a login here. Use Resend invitation or Reset sign-in in the list.', 400);
      }
      void invite(req, res, { email: req.body?.email, name: req.body?.name, role: req.body?.role }, false);
    });
    router.post('/resend', (req, res) => {
      const user = String(req.body?.user || '').toLowerCase();
      const a = staffAccounts.list().find((x) => x.user === user);
      if (!a) return render(req, res, '', 'No such login.', 404);
      if (a.user === (req as any).drawbridgeUser) return render(req, res, '', 'Ask another Drawbridge admin to reset your own sign-in.', 400);
      void invite(req, res, { email: a.user, name: a.name, role: a.role }, true);
    });
    router.post('/remove', (req, res) => {
      const user = String(req.body?.user || '').toLowerCase();
      if (user === (req as any).drawbridgeUser) return render(req, res, '', 'You can’t remove your own login.', 400);
      if (!staffAccounts.remove(user)) return render(req, res, '', 'No such login.', 404);
      revokeStaffSessions(user);
      securityEvent('staff_login_removed', { user, ip: clientIp(req) });
      render(req, res, `${user} was removed and signed out.`);
    });
    return router;
  },
};
