import * as fs from 'fs';
import * as path from 'path';

/**
 * The one source for Drawbridge's HIPAA safeguards checklist.
 *
 * Used by the staff screen "HIPAA & Compliance" (plain language, for a clinic practice manager: `plain`, never
 * `technical` or `evidence`) and by the generated table in docs/drawbridge/HIPAA_TECHNICAL_SAFEGUARDS.md
 * (`npm run docs:hipaa`; `npm run smoke:hipaa` fails when the document no longer matches this list or the code
 * moved under an evidence reference).
 *
 * Status: PASS (already in place before this branch), FIXED (added on branch drawbridge/cert-hardening),
 * DEPLOYMENT (depends on how and where Drawbridge is hosted), ORGANIZATIONAL (covered by MOATiT policy).
 */
export type SafeguardStatus = 'PASS' | 'FIXED' | 'DEPLOYMENT' | 'ORGANIZATIONAL';

export type SafeguardSection = 'Administrative safeguards' | 'Physical safeguards' | 'Technical safeguards' | 'Business associates' | 'Privacy Rule' | 'Breach notification';

export interface Evidence {
  /** Repo-relative file. */
  file: string;
  /** Text on the line to cite (the line number is looked up, so the document follows the code). */
  anchor: string;
}

export interface Safeguard {
  citation: string;
  section: SafeguardSection;
  /** The requirement, in plain language. */
  requirement: string;
  /** How Drawbridge meets it, in plain language for a clinic (no code paths, settings or host names). */
  plain: string;
  /** How Drawbridge meets it, for the technical document (settings, mechanisms). */
  technical: string;
  evidence: Evidence[];
  status: SafeguardStatus;
}

const E = (file: string, anchor: string): Evidence => ({ file, anchor });
const SHELL = 'src/platform/shell.ts';
const AUTH = 'src/platform/staff-auth.ts';
const AUDIT = 'src/platform/audit.ts';
const APP = 'src/platform/app.ts';
const SEC = 'src/platform/security-events.ts';
const ACT = 'src/platform/modules/activity/index.ts';
const MN = 'src/utils/minimum-necessary.ts';
const CB = 'src/platform/call-binding.ts';
const STORE = 'src/platform/modules/intake/store.ts';
const FILE = 'src/platform/modules/intake/file.ts';

export const SAFEGUARDS: Safeguard[] = [
  // ── Administrative (where they touch the software) ─────────────────────────
  {
    citation: '164.308(a)(1)(ii)(A)-(B)',
    section: 'Administrative safeguards',
    requirement: 'Risk analysis and risk management.',
    plain: 'MOATiT runs a documented risk analysis and risk management program, with yearly vulnerability scans and penetration tests.',
    technical: 'Organizational, covered by MOATiT policy (annual scanning and penetration testing).',
    evidence: [],
    status: 'ORGANIZATIONAL',
  },
  {
    citation: '164.308(a)(1)(ii)(D)',
    section: 'Administrative safeguards',
    requirement: 'Regularly review records of information system activity.',
    plain: 'Drawbridge keeps an audit log of every phone-agent request, every request it sends to Veradigm® EHR and Veradigm® PM, every staff screen opened and every staff action. The Activity screen shows the day’s activity and security events for review.',
    technical: 'Audit lines for kinds tool / action / view / staff / security; staff access middleware on every module screen; Activity screen with a Security events panel ("to review" count).',
    evidence: [E(AUDIT, 'export function toEntry('), E(APP, 'export function staffAudit('), E(ACT, 'const securityTable = ')],
    status: 'FIXED',
  },
  {
    citation: '164.308(a)(3)(ii)(C)',
    section: 'Administrative safeguards',
    requirement: 'End access when a workforce member leaves.',
    plain: 'Removing a person’s login signs them out everywhere at once, and an old session never comes back even if the same name is added again.',
    technical: 'Users file re-read on change; a removed user or changed password revokes all sessions (persisted revocation list).',
    evidence: [E(SHELL, 'if (!now || now.hash !== old.hash) revocations.revoke(u);'), E(AUTH, 'export class SessionRevocations')],
    status: 'PASS',
  },
  {
    citation: '164.308(a)(4)(ii)(B)-(C)',
    section: 'Administrative safeguards',
    requirement: 'Authorize, establish and change access based on role.',
    plain: 'Every staff member has their own login with a role. Only administrators (the privacy or security officer) can run the access and disclosure report. Drawbridge itself can call only a fixed list of Veradigm® actions.',
    technical: 'Users file roles staff / admin / emergency; requireAdmin on the access report; fixed Unity action list (UNITY_ACTIONS_FOR_CERTIFICATION.md).',
    evidence: [E(AUTH, "else if (k === 'role'"), E(SHELL, 'export function requireAdmin(')],
    status: 'FIXED',
  },
  {
    citation: '164.308(a)(5)(i)',
    section: 'Administrative safeguards',
    requirement: 'Security awareness and training for the workforce.',
    plain: 'Every MOATiT staff member completes HIPAA security and privacy training every year.',
    technical: 'Organizational, covered by MOATiT policy.',
    evidence: [],
    status: 'ORGANIZATIONAL',
  },
  {
    citation: '164.308(a)(5)(ii)(B)',
    section: 'Administrative safeguards',
    requirement: 'Protection from malicious software.',
    plain: 'MOATiT servers run endpoint detection and response (SentinelOne), and patches are applied through managed patching with critical patches within 7 days.',
    technical: 'Organizational, covered by MOATiT policy (SentinelOne EDR; ConnectWise ScreenConnect RMM patching).',
    evidence: [],
    status: 'ORGANIZATIONAL',
  },
  {
    citation: '164.308(a)(5)(ii)(C)',
    section: 'Administrative safeguards',
    requirement: 'Monitor log-in attempts and report discrepancies.',
    plain: 'Every sign-in, failed sign-in and lockout is recorded as a security event. Five wrong tries lock a login for 15 minutes, and too many failures from one computer lock that computer.',
    technical: 'Security events login_ok / login_failed (reason) / login_locked / login_ip_locked; lockout per username (5 in 15 min) and per IP (30).',
    evidence: [E(SHELL, "securityEvent('login_failed', { user: known, ip, code: failCode });"), E(AUTH, 'export class LoginThrottle')],
    status: 'FIXED',
  },
  {
    citation: '164.308(a)(5)(ii)(D)',
    section: 'Administrative safeguards',
    requirement: 'Procedures for creating, changing and safeguarding passwords.',
    plain: 'Passwords must be at least 12 characters and not common or guessable. They expire every 90 days, and none of the last 5 passwords can be reused. Passwords are stored only as strong one-way hashes.',
    technical: 'passwordProblem policy; DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS (90) with :pwset=; :hist= keeps 4 previous hashes, staff:user refuses reuse of the last 5; scrypt.',
    evidence: [E(AUTH, 'export function passwordProblem('), E(AUTH, 'export function passwordExpired('), E('src/scripts/staff-user.ts', 'must differ from the last')],
    status: 'FIXED',
  },
  {
    citation: '164.308(a)(6)(ii)',
    section: 'Administrative safeguards',
    requirement: 'Identify security incidents (detection and documentation).',
    plain: 'Drawbridge raises security events for repeated failed sign-ins, lockouts, emergency access, rejected connection keys, documents that no longer match what was received, and unusually many downloads or patient records opened by one person.',
    technical: 'security-events.ts: [SECURITY] server-log lines plus audit lines; throttled tool_key_rejected / webhook_rejected; integrity_failed; export_volume_alert and view_volume_alert (DRAWBRIDGE_EXPORT_ALERT_PER_HOUR 20, DRAWBRIDGE_VIEW_ALERT_PER_HOUR 200).',
    evidence: [E(SEC, 'export function securityEvent('), E(SEC, 'export class VolumeMonitor')],
    status: 'FIXED',
  },
  {
    citation: '164.308(a)(6)(ii)',
    section: 'Administrative safeguards',
    requirement: 'Respond to and report security incidents.',
    plain: 'MOATiT has a written incident response plan, including breach notification to clients under the Business Associate Agreement.',
    technical: 'Organizational, covered by MOATiT policy. Alerting on [SECURITY] log lines is a deployment item.',
    evidence: [],
    status: 'ORGANIZATIONAL',
  },
  {
    citation: '164.308(a)(7)(ii)(A)',
    section: 'Administrative safeguards',
    requirement: 'Data backup plan.',
    plain: 'Drawbridge’s working data is backed up every 2 hours, kept 6 months, encrypted and immutable. After a restore, the audit log’s tamper check is run.',
    technical: 'Back up the data volume (call records, intake store, audit day files, revocation list); encrypted, immutable; npm run audit:verify -- --all after a restore.',
    evidence: [E('src/scripts/audit-verify.ts', "arg === '--all'")],
    status: 'DEPLOYMENT',
  },
  {
    citation: '164.308(a)(7)(ii)(B)-(C)',
    section: 'Administrative safeguards',
    requirement: 'Disaster recovery and emergency mode operation.',
    plain: 'MOATiT has written disaster recovery and business continuity plans. If Drawbridge or Veradigm® is unavailable, the phone agent says it is having trouble and offers to transfer or take a message (it never says “nothing on file”), and staff keep working in Veradigm® EHR, which remains the system of record.',
    technical: 'Failures are { success:false, error_code, retryable } (CLAUDE.md rule 5); DR/BCP organizational.',
    evidence: [E('src/utils/response-formatter.ts', 'export function failureText(')],
    status: 'ORGANIZATIONAL',
  },
  {
    citation: '164.308(a)(8)',
    section: 'Administrative safeguards',
    requirement: 'Periodic technical and non-technical evaluation.',
    plain: 'Yearly vulnerability scanning and penetration testing by an outside firm, plus automated security tests run on every change to Drawbridge.',
    technical: 'Organizational (annual scan and pen test); offline smoke suites in the repo.',
    evidence: [],
    status: 'ORGANIZATIONAL',
  },

  // ── Physical (as it applies to data deletion and media) ─────────────────────
  {
    citation: '164.310(a)-(c)',
    section: 'Physical safeguards',
    requirement: 'Facility access and workstation security.',
    plain: 'Production runs in Amazon Web Services data centers in the US, under AWS’s physical security and BAA.',
    technical: 'Organizational / hosting provider.',
    evidence: [],
    status: 'ORGANIZATIONAL',
  },
  {
    citation: '164.310(d)(2)(i)',
    section: 'Physical safeguards',
    requirement: 'Dispose of ePHI securely.',
    plain: 'Drawbridge deletes its working copies on a schedule: call records and outreach lists after 30 days, received documents 30 days after they are filed, and patient details on filed document records after 90 days. Storage is encrypted, so destroying the encryption key erases everything for good.',
    technical: 'Daily retention jobs (CALL_RECORDS_, OUTREACH_, INTAKE_ RETENTION_DAYS 30; INTAKE_RECORD_RETENTION_DAYS 90); crypto-erase of the encrypted volume at end of life.',
    evidence: [E(STORE, 'purgeRecords(days: number): number {'), E('src/platform/retention.ts', 'export function startDailyRetention(')],
    status: 'FIXED',
  },
  {
    citation: '164.310(d)(2)(ii)',
    section: 'Physical safeguards',
    requirement: 'Remove ePHI before media is re-used.',
    plain: 'Disks are never re-used with data on them: an encrypted volume is destroyed with its key and a new one is created.',
    technical: 'AWS: delete the EBS volume and snapshots (KMS key schedule); data center: cryptsetup luksErase / BitLocker key destruction (NIST SP 800-88 crypto-erase).',
    evidence: [],
    status: 'DEPLOYMENT',
  },
  {
    citation: '164.310(d)(2)(iii)-(iv)',
    section: 'Physical safeguards',
    requirement: 'Track hardware and media; back up data before moving equipment.',
    plain: 'MOATiT keeps an inventory of its servers and takes an encrypted backup before any equipment is moved.',
    technical: 'Organizational / deployment.',
    evidence: [],
    status: 'ORGANIZATIONAL',
  },

  // ── Technical ──────────────────────────────────────────────────────────────
  {
    citation: '164.312(a)(1)',
    section: 'Technical safeguards',
    requirement: 'Access control: only authorized people and programs can reach ePHI.',
    plain: 'Every staff screen needs a sign-in. The connections used by the phone agent need a secret key and refuse every request when it is missing.',
    technical: 'requireLogin on every module router; requireToolKey fails closed (503) and rejects wrong keys (401, security event).',
    evidence: [E(SHELL, 'export function requireLogin('), E(APP, 'export function requireToolKey(')],
    status: 'PASS',
  },
  {
    citation: '164.312(a)(1), 164.502(b)',
    section: 'Technical safeguards',
    requirement: 'Access control on patient calls: the phone agent can open only the records of callers it has verified.',
    plain: 'On every phone call, Drawbridge itself checks identity before any record is opened: a patient’s record can be used only after the caller gave that patient’s full name and date of birth and exactly one patient matched, on that same call. At most two people can be verified per call (for example a parent calling for a child), and repeated lookups on one call are stopped and reported as a security alert. Staff screens are not affected.',
    technical:
      'Per-call verification binding keyed by the Retell call ID (call-binding.ts, both agent endpoints): unity_search_patients / verify_patient_identity with first + last name + DOB and one match binds that patient’s IDs to the call (memory only, DRAWBRIDGE_CALL_BINDING_TTL_MIN 120); every patient-scoped tool and appointment ID needs a bound patient, else NOT_VERIFIED; no call ID = CALL_ID_MISSING; DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS 2, DRAWBRIDGE_CALL_MAX_SEARCHES 5; refusals are security events.',
    evidence: [E(CB, 'export function beforeAgentTool('), E(CB, 'export function afterAgentTool(')],
    status: 'FIXED',
  },
  {
    citation: '164.312(a)(2)(i)',
    section: 'Technical safeguards',
    requirement: 'Unique user identification.',
    plain: 'Every person signs in with their own named login. No shared logins are allowed in production.',
    technical: 'Named users file; the shared DRAWBRIDGE_USERNAME login works only in development with TOTP off and is refused in production.',
    evidence: [E(SHELL, 'const sharedLoginAllowed = ')],
    status: 'FIXED',
  },
  {
    citation: '164.312(a)(2)(ii)',
    section: 'Technical safeguards',
    requirement: 'Emergency access procedure.',
    plain: 'A sealed emergency login exists for when no named login can be used. Using it raises an alert, shows a warning on every page, ends after 4 hours, and is reviewed by the privacy officer afterwards. Veradigm® EHR remains the system of record for patient care.',
    technical: 'role=emergency: emergency_access_login security event, banner, 4-hour absolute limit; procedure in this document.',
    evidence: [E(SHELL, "securityEvent('emergency_access_login'"), E(SHELL, 'const EMERGENCY_HOURS = 4;')],
    status: 'FIXED',
  },
  {
    citation: '164.312(a)(2)(iii)',
    section: 'Technical safeguards',
    requirement: 'Automatic logoff.',
    plain: 'Staff are signed out after 15 minutes without activity, and the screen clears itself at that moment so no patient information is left showing. Every session ends after 12 hours regardless.',
    technical: 'Server idle timeout (DRAWBRIDGE_IDLE_MINUTES 15, sliding) and 12-hour limit; pages carry data-idle-ms and blank themselves.',
    evidence: [E(SHELL, 'data-idle-ms='), E(SHELL, "document.body.innerHTML = '';")],
    status: 'FIXED',
  },
  {
    citation: '164.312(a)(2)(iii)',
    section: 'Technical safeguards',
    requirement: 'Automatic logoff in the separate admin console.',
    plain: 'The separate administration console must apply the same sign-out rules.',
    technical: 'The admin portal is a separate application (not in this repository); it must implement idle logoff, MFA and the same session rules.',
    evidence: [],
    status: 'DEPLOYMENT',
  },
  {
    citation: '164.312(a)(2)(iv)',
    section: 'Technical safeguards',
    requirement: 'Encryption of stored ePHI.',
    plain: 'All Drawbridge data is stored on encrypted disks (Amazon EBS encryption in production, full-disk encryption on any on-premises server), and backups are encrypted too.',
    technical: 'Deployment: EBS encryption with KMS (infra owned by Kanhaiya; compute.tf root_block_device needs encrypted = true); data center: BitLocker or LUKS2. Files are written mode 0600 in 0700 directories.',
    evidence: [E(STORE, "fs.writeFileSync(tmp, data, { mode: 0o600 });")],
    status: 'DEPLOYMENT',
  },
  {
    citation: '164.312(b)',
    section: 'Technical safeguards',
    requirement: 'Audit controls that record and examine activity.',
    plain: 'The audit log records who did what and when, for which patient (by ID, never by name), is tamper-evident, and is kept for 6 years.',
    technical: 'Hash-chained JSONL day files (audit:verify); staff views and actions with user and patient ID; AUDIT_RETENTION_DAYS default 2190 (6 years); off-host archive is a deployment item.',
    evidence: [E(AUDIT, 'export async function verifyAuditDay('), E(AUDIT, ': 2190;')],
    status: 'FIXED',
  },
  {
    citation: '164.312(c)(1)-(2)',
    section: 'Technical safeguards',
    requirement: 'Integrity: protect ePHI from improper change and detect it.',
    plain: 'Each received document gets a digital fingerprint when it arrives. Drawbridge checks it again before anyone downloads the document and before it is filed to the chart; a mismatch stops the action and raises an alert.',
    technical: 'SHA-256 at receipt; verified before download (409) and before SaveScanDocument (INTEGRITY_FAILED); audit hash chain; atomic file writes; idempotent writes.',
    evidence: [E(FILE, "throw new IntakeFilingError('INTEGRITY_FAILED'"), E('src/platform/modules/intake/index.ts', "code: 'ORIGINAL_HASH_MISMATCH'")],
    status: 'FIXED',
  },
  {
    citation: '164.312(d)',
    section: 'Technical safeguards',
    requirement: 'Person or entity authentication.',
    plain: 'Every staff sign-in needs a password and a one-time code from an authenticator app. Systems that connect to Drawbridge must present a secret key or a signature.',
    technical: 'TOTP mandatory (DRAWBRIDGE_REQUIRE_TOTP default on, forced in production); tool key; HMAC-signed MOATiT Fax and Retell webhooks.',
    evidence: [E(AUTH, 'export function requireTotp('), E(SHELL, "securityEvent('login_no_totp'")],
    status: 'FIXED',
  },
  {
    citation: '164.312(e)(1), (e)(2)(i)',
    section: 'Technical safeguards',
    requirement: 'Transmission security and integrity in transit.',
    plain: 'Everything travels encrypted (HTTPS). Drawbridge refuses to start in production if a Veradigm® connection is not encrypted, and browsers are told to use HTTPS only.',
    technical: 'Production refuses non-https Unity/FHIR/MOATiT Fax URLs; HSTS; __Host- Secure cookie; signed webhooks.',
    evidence: [E('src/unity/config/environment.ts', 'must be an https:// URL'), E(SHELL, "'Strict-Transport-Security'")],
    status: 'FIXED',
  },
  {
    citation: '164.312(e)(2)(ii)',
    section: 'Technical safeguards',
    requirement: 'Encryption in transit at the network edge.',
    plain: 'Public connections accept only TLS 1.2 or 1.3 with valid certificates, and plain HTTP is redirected to HTTPS.',
    technical: 'Deployment: TLS 1.2+ termination in nginx / the tunnel; ports 3000/3001 never exposed directly.',
    evidence: [],
    status: 'DEPLOYMENT',
  },

  // ── Business associates ────────────────────────────────────────────────────
  {
    citation: '164.314(a)',
    section: 'Business associates',
    requirement: 'Business associate agreements, including with subcontractors.',
    plain: 'MOATiT signs a BAA with each clinic. Subcontractors that handle PHI are under BAAs too: Amazon Web Services (hosting) and Retell (voice).',
    technical: 'Organizational. Any other service that sees PHI in clear (for example a TLS-terminating tunnel or CDN) also needs a BAA.',
    evidence: [],
    status: 'ORGANIZATIONAL',
  },
  {
    citation: '164.314(a)(2)(i)(C)',
    section: 'Business associates',
    requirement: 'Report security incidents to the covered entity.',
    plain: 'Security events and the access report give MOATiT what it needs to tell a clinic quickly what happened and which patients were involved.',
    technical: 'Security events + access report per patient / per staff user support the report; the reporting duty is organizational.',
    evidence: [E(ACT, 'export async function accessReport(')],
    status: 'FIXED',
  },

  // ── Privacy Rule ───────────────────────────────────────────────────────────
  {
    citation: '164.502(b), 164.514(d)',
    section: 'Privacy Rule',
    requirement: 'Minimum necessary.',
    plain: 'The phone agent receives only what it needs: name, date of birth and record IDs after the caller is identified. It never gets addresses, phone numbers, email or Social Security numbers, a name-only or partial search reveals no one, and staff-only lists (the day’s schedule) are never available on patient calls. Logs never contain patient names or chart contents.',
    technical: 'forAgent() at the agent edges (Retell, MCP, stdio); STAFF_ONLY tools refused; audit and server logs hold IDs and codes only.',
    evidence: [E(MN, 'export function forAgent('), E(MN, 'export const STAFF_ONLY_TOOLS')],
    status: 'FIXED',
  },
  {
    citation: '164.528',
    section: 'Privacy Rule',
    requirement: 'Accounting of disclosures.',
    plain: 'Administrators can list every Drawbridge record that touched one patient (or everything one staff member did) for any date range, on screen or as a spreadsheet, to prepare an accounting of disclosures.',
    technical: 'Access and disclosure report (admin, POST, HTML/CSV), backed by the 6-year audit log.',
    evidence: [E(ACT, "router.post('/disclosures', requireAdmin")],
    status: 'FIXED',
  },
  {
    citation: '164.530(c)',
    section: 'Privacy Rule',
    requirement: 'Reasonable safeguards against improper use or disclosure.',
    plain: 'Patient details never appear in web addresses or page titles, pages are not cached or framed, and patient-specific searches are sent in the page body.',
    technical: 'POST for patient IDs and free-text questions; neutral titles; Cache-Control no-store, CSP, X-Frame-Options DENY, Referrer-Policy no-referrer; FHIR REST test routes off in production.',
    evidence: [E(SHELL, "res.setHeader('Cache-Control', 'no-store');"), E('src/test-server.ts', 'const restRoutesEnabled = ')],
    status: 'FIXED',
  },
  {
    citation: '164.316(b)(2)',
    section: 'Privacy Rule',
    requirement: 'Keep required documentation for 6 years.',
    plain: 'The audit log is kept for 6 years by default.',
    technical: 'AUDIT_RETENTION_DAYS default 2190; copy day files to append-only archive storage (deployment).',
    evidence: [E(AUDIT, ': 2190;')],
    status: 'FIXED',
  },

  // ── Breach notification ────────────────────────────────────────────────────
  {
    citation: '164.404-410',
    section: 'Breach notification',
    requirement: 'Support breach detection, investigation and notification.',
    plain: 'Security events help detect a possible breach, the tamper-evident audit log and the access report show which patients were affected, and MOATiT notifies the clinic under the BAA.',
    technical: 'Detection (security events, alerts), scoping (access report per patient / per user), tamper evidence (hash chain); notification is organizational.',
    evidence: [E(SEC, 'export function recordExport(')],
    status: 'FIXED',
  },
];

/** MOATiT organizational safeguards (owner-confirmed Oct 15, 2026). */
export const ORGANIZATIONAL_SAFEGUARDS: string[] = [
  'Annual HIPAA security and privacy training for all staff.',
  'Written incident response plan, including breach notification to clients under the Business Associate Agreement.',
  'Written disaster recovery and business continuity plans.',
  'Backups every 2 hours, kept for 6 months, encrypted and immutable.',
  'SentinelOne endpoint detection and response (EDR) on all servers.',
  'Patching through ConnectWise ScreenConnect remote management; critical patches within 7 days after in-house testing.',
  'Vulnerability scanning and penetration testing every year (Garrison).',
  'Production on Amazon Web Services in the US, with encrypted (EBS) storage under the AWS Business Associate Agreement.',
  'A Business Associate Agreement signed with each client.',
  'Retell (voice) under a Business Associate Agreement.',
  '24/7 help desk: help@moatit.com.',
  'Multi-factor sign-in (authenticator app codes) for every user.',
  'Passwords expire every 90 days.',
  'SOC 2: in process; audit to be completed before the end of 2027.',
];

/** "Last security checks" box. */
export const LAST_SECURITY_CHECKS: Array<{ date: string; check: string; result: string }> = [
  { date: 'Oct 15, 2026', check: 'Dependency scan (npm audit, runtime dependencies)', result: '0 vulnerabilities, after remediation of 1 critical and 6 high' },
  { date: 'Oct 15, 2026', check: 'TLS test', result: 'Only TLS 1.2 and 1.3, valid certificates, HTTP redirected to HTTPS' },
  { date: 'Oct 15, 2026', check: 'Veradigm® certification', result: 'In progress' },
];

export const SECURITY_CONTACT = { email: 'help@moatit.com', phone: '(208) 900-6628' };

/** Badge on the clinic-facing page. */
export function statusBadge(s: SafeguardStatus): { label: string; kind: 'ok' | 'warn' | '' } {
  if (s === 'PASS' || s === 'FIXED') return { label: 'In place', kind: 'ok' };
  if (s === 'DEPLOYMENT') return { label: 'Deployment', kind: 'warn' };
  return { label: 'Organizational', kind: '' };
}

const STATUS_DOC: Record<SafeguardStatus, string> = {
  PASS: 'PASS',
  FIXED: 'FIXED-in-this-branch',
  DEPLOYMENT: 'DEPLOYMENT (needs infra)',
  ORGANIZATIONAL: 'ORGANIZATIONAL',
};

/** `file:line` of an evidence anchor; throws when the anchor is no longer in the file. */
export function evidenceRef(e: Evidence, root: string = process.cwd()): string {
  const lines = fs.readFileSync(path.join(root, e.file), 'utf8').split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(e.anchor));
  if (i < 0) throw new Error(`evidence anchor not found in ${e.file}: ${e.anchor}`);
  return `${e.file}:${i + 1}`;
}

export function statusCounts(list: Safeguard[] = SAFEGUARDS): Record<SafeguardStatus, number> {
  const out: Record<SafeguardStatus, number> = { PASS: 0, FIXED: 0, DEPLOYMENT: 0, ORGANIZATIONAL: 0 };
  for (const s of list) out[s.status]++;
  return out;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** The generated checklist block of HIPAA_TECHNICAL_SAFEGUARDS.md (between the BEGIN/END markers). */
export function checklistMarkdown(root: string = process.cwd()): string {
  const c = statusCounts();
  const head = [
    `${SAFEGUARDS.length} requirements: ${c.PASS} PASS, ${c.FIXED} FIXED-in-this-branch, ${c.DEPLOYMENT} DEPLOYMENT, ${c.ORGANIZATIONAL} ORGANIZATIONAL.`,
    '',
    '| # | Citation | Requirement | How Drawbridge meets it | Evidence | Status |',
    '|---|---|---|---|---|---|',
  ];
  const rows = SAFEGUARDS.map(
    (s, i) =>
      `| ${i + 1} | ${cell(s.citation)} | ${cell(s.requirement)} | ${cell(s.technical)} | ${s.evidence.length ? s.evidence.map((e) => `\`${evidenceRef(e, root)}\``).join('<br>') : '—'} | ${STATUS_DOC[s.status]} |`
  );
  return [...head, ...rows].join('\n');
}

export const CHECKLIST_BEGIN = '<!-- BEGIN GENERATED CHECKLIST (npm run docs:hipaa; source: the SAFEGUARDS list) -->';
export const CHECKLIST_END = '<!-- END GENERATED CHECKLIST -->';

/** The checklist block currently in the document, or null when the markers are missing. */
export function checklistInDoc(doc: string): string | null {
  const a = doc.indexOf(CHECKLIST_BEGIN);
  const b = doc.indexOf(CHECKLIST_END);
  if (a < 0 || b < a) return null;
  return doc.slice(a + CHECKLIST_BEGIN.length, b).replace(/\r\n/g, '\n').trim();
}
