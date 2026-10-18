/**
 * Drawbridge document intake in shadow mode, as its own server (deploy/datacenter).
 *
 * Only the intake module and the staff login: no phone-agent tools, no other modules, no filing.
 * Veradigm® is read-only: the UnityService is locked to SearchPatients and GetDocumentType
 * (shadow.ts lockUnityReadOnly), and the only tool is unity_search_patients. Without Veradigm®
 * credentials it runs on the local patient list alone (INTAKE_ROSTER_CSV) and makes no outside call.
 *
 *   INTAKE_MODE=shadow           required (the server refuses to start otherwise)
 *   UNITY_*                      Veradigm® Unity credentials and endpoint: the live read-only search
 *   INTAKE_ROSTER_CSV            the local patient list instead of the live search (early start)
 *   INTAKE_CATEGORIES_CSV        category list, used when GetDocumentType is not available
 *   INTAKE_SHADOW_PORT           default 3001
 * plus the intake settings (INTAKE_DROP_DIR, INTAKE_WATCH_DIRS, MOATIT_FAX_*, INTAKE_OCR_URL, ...) and
 * the staff login (DRAWBRIDGE_USERS_FILE, DRAWBRIDGE_SESSION_SECRET). See deploy/datacenter/README.md.
 *
 *   node dist/platform/shadow-server.js        (npm run server:shadow with ts-node)
 */
const UNITY_REQUIRED = ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD'];

export interface ShadowStartup {
  veradigm: boolean;
  roster: boolean;
}

/** Decide the patient search before any Veradigm config loads; without credentials, make every Veradigm call impossible. */
export function prepareShadowEnv(env: NodeJS.ProcessEnv = process.env): ShadowStartup {
  const veradigm = UNITY_REQUIRED.every((k) => String(env[k] || '').trim());
  if (!veradigm) {
    for (const k of UNITY_REQUIRED) env[k] = 'shadow-no-veradigm';
    env.UNITY_UBIQUITY_ENDPOINT = 'https://veradigm-not-configured.invalid/UnityService.svc';
    delete env.UNITY_PM_USERNAME;
    delete env.UNITY_PM_PASSWORD;
    // The staff filing observer and the queue source read Veradigm EHR: nothing to observe or read without it.
    env.INTAKE_OBSERVE = 'off';
    env.INTAKE_QUEUE_SOURCE = 'off';
  }
  return { veradigm, roster: !!String(env.INTAKE_ROSTER_CSV || '').trim() };
}

/** The shadow server alerts the help desk for a refusal it saw itself, and for a fail-closed latch file. */
export function shadowAlertsLatch(l: { stage: string }, origin: 'refused' | 'file'): boolean {
  return origin === 'refused' || l.stage === 'unknown';
}

export async function createShadowApp(startup: ShadowStartup) {
  const express = (await import('express')).default;
  const { registerModule } = await import('./registry');
  const { mountPlatform } = await import('./app');
  const { auditToolCall } = await import('./audit');
  const { intakeModule, mountFaxWebhook } = await import('./modules/intake');
  const { lockUnityReadOnly, shadowMode } = await import('./modules/intake/shadow');
  const { queueSourceState } = await import('./modules/intake/queue-source');
  const { toToolFailure } = await import('../unity/utils/tool-result');

  if (!shadowMode()) throw Object.assign(new Error('This server runs only with INTAKE_MODE=shadow.'), { code: 'NOT_SHADOW' });

  let unity: any = { executeAction: async () => ({ success: false, error: 'Veradigm is not configured on this server.' }) };
  let search: ((args: any) => Promise<any>) | null = null;
  if (startup.veradigm) {
    const { UnityAuthService } = await import('../unity/services/unity-auth.service');
    const { UnityService } = await import('../unity/services/unity.service');
    const { UnityPatientTools } = await import('../unity/tools/patient.tools');
    const { HelpdeskNotifier } = await import('./helpdesk');
    const auth = new UnityAuthService();
    // Veradigm refused a sign-in: no more logins for that system (the latch is shared through the latch file
    // with any Drawbridge server using the same data directory). The auth service logs it and writes the
    // security event unity_signin_latched; this server has no status screen, so it alerts the help desk directly.
    const notifier = new HelpdeskNotifier();
    auth.onLatch(async (l, origin) => {
      // Found in the shared latch file: the process that was refused alerts (no duplicate from here),
      // except a fail-closed latch (unreadable file, stage 'unknown'): every process that finds it alerts.
      if (!shadowAlertsLatch(l, origin)) return;
      const at = new Date().toISOString();
      const res = await notifier.send({
        kind: 'down',
        system: 'Veradigm Unity (Drawbridge document intake, shadow mode)',
        overall: 'down',
        since: l.at,
        components: [{ name: l.target === 'PM' ? 'Veradigm PM' : 'Veradigm EHR', state: 'down', since: l.at, error_class: 'AUTH_ERROR', error_detail: `${l.stage}: sign-in stopped (${l.reason})`, last_ok_at: '' }],
        messages_taken: 0,
        at,
      });
      if (!res.ok) console.error(`[Intake shadow] help-desk alert for the stopped ${l.target} sign-in NOT sent (${res.failed.map((f) => f.code).join('+') || 'NO_TRANSPORT'})`);
    });
    for (const l of auth.latchedTargets()) {
      console.error(`[Intake shadow] Veradigm ${l.target} sign-in still stopped (refused ${l.stage} at ${l.at}): live patient search refused locally until it is retried or the credentials change`);
    }
    unity = new UnityService(auth);
    lockUnityReadOnly(unity); // the read actions in SHADOW_READ_ACTIONS only, whoever holds the service
    const patients = new UnityPatientTools(unity);
    search = (args) => patients.searchPatients(args);
  }

  const runTool = async (name: string, args: any): Promise<any> => {
    if (name !== 'unity_search_patients' || !search) {
      return { success: false, error_code: search ? 'SHADOW_READ_ONLY' : 'VERADIGM_NOT_CONFIGURED', retryable: false, tool: name, message: '' };
    }
    const t0 = Date.now();
    try {
      const r = await search(args);
      auditToolCall({ server: 'unity', tool: name, args, success: true, latencyMs: Date.now() - t0, channel: 'intake-shadow' });
      return r;
    } catch (e) {
      const f = toToolFailure(e, name);
      auditToolCall({ server: 'unity', tool: name, args, success: false, errorCode: f.error_code, latencyMs: Date.now() - t0, channel: 'intake-shadow' });
      return f;
    }
  };

  const app = express();
  app.disable('x-powered-by');
  // MOATiT Fax deliveries: HMAC over the raw body, before any body parser (closed until the secret is set).
  mountFaxWebhook(app);
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`); // never the query or body
    next();
  });
  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', server: 'intake-shadow', mode: 'shadow', filing: 'impossible', patient_search: startup.roster ? 'local list' : 'veradigm read-only', indexing_queue_source: queueSourceState() });
  });
  app.get('/', (_req, res) => res.redirect('/app/intake'));
  registerModule(intakeModule);
  mountPlatform(app, { unity, runTool });
  return { app, runTool, unity };
}

async function main(): Promise<void> {
  const startup = prepareShadowEnv();
  const fail = (msg: string) => {
    console.error(`[Intake shadow] ${msg}`);
    process.exit(1);
  };
  if (String(process.env.INTAKE_MODE || '').trim().toLowerCase() !== 'shadow') return fail('INTAKE_MODE must be "shadow".');
  if (!startup.veradigm && !startup.roster) return fail('Set the Veradigm Unity credentials (read-only search) or INTAKE_ROSTER_CSV (local patient list).');
  if (startup.roster) {
    const { loadRoster, RosterError } = await import('./modules/intake/roster');
    try {
      loadRoster();
    } catch (e) {
      return fail(`patient list not usable (${e instanceof RosterError ? e.code : 'ROSTER_UNAVAILABLE'}): ${e instanceof Error ? e.message : ''}`);
    }
  }
  const { CsvDocTypes } = await import('./modules/intake/doctypes');
  const csv = CsvDocTypes.fromEnv();
  if (csv) {
    try {
      await csv.list();
    } catch {
      return fail('INTAKE_CATEGORIES_CSV is set but the category list is missing, unreadable or empty.');
    }
  } else if (!startup.veradigm) console.warn('[Intake shadow] no Veradigm and no INTAKE_CATEGORIES_CSV: no category suggestions');
  if (!process.env.DRAWBRIDGE_USERS_FILE && !(process.env.DRAWBRIDGE_USERNAME && process.env.DRAWBRIDGE_PASSWORD)) console.warn('[Intake shadow] staff login not configured');
  if (!process.env.DRAWBRIDGE_SESSION_SECRET) console.warn('[Intake shadow] DRAWBRIDGE_SESSION_SECRET not set: staff are signed out at every restart');

  const { app, unity } = await createShadowApp(startup);
  const port = Number(process.env.INTAKE_SHADOW_PORT) || 3001;
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[Intake shadow] listening on ${port}; patients from ${startup.roster ? 'the local patient list' : 'Veradigm (read-only)'}; nothing is filed`);
  });
  // Graceful shutdown: retire the Veradigm token this process holds (RetireToken), flush the audit log.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 10_000).unref();
    server.close();
    if (typeof unity.cleanup === 'function') await unity.cleanup();
    const { flushAudit } = await import('./audit');
    await flushAudit().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[Intake shadow] failed to start: ${e?.code || e?.name || 'error'}`);
    process.exit(1);
  });
}
