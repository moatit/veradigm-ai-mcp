/**
 * Unity HTTP Test Server for Retell AI Integration
 *
 * This server exposes Unity EHR tools via HTTP for integration with
 * Retell AI and other external platforms.
 *
 * Port: 3001
 */

import express, { NextFunction, Request, Response } from "express";
// Load env first so adminLogger gets ADMIN_PORTAL_URL and ADMIN_API_KEY
import { adminLogger } from "../middleware/admin-logger";
import { toVoiceSummary } from "../utils/response-formatter";
import { agentToolAllowed, forAgent, staffOnlyFailure } from "../utils/minimum-necessary";
import { unityConfig } from "./config/environment";
import { AuthLatch, configuredTargets, setUnityAuth, UnityAuthService } from "./services/unity-auth.service";
import { setUnityDiagnostics, UnityDiagnostics } from "./services/unity-diagnostics";
import { UnityService } from "./services/unity.service";
import { UnityAppointmentTools } from "./tools/appointment.tools";
import { UnityClinicalTools } from "./tools/clinical.tools";
import { UnityPatientTools } from "./tools/patient.tools";
import { UnityBillingTools } from "./tools/billing.tools";
import { UnityTaskTools } from "./tools/task.tools";
import { isToolFailure, toToolFailure } from "./utils/tool-result";
import { withIdempotency } from "./utils/idempotency";
import { callRecords } from "./oncall/call-records";
import { currentMode } from "./oncall/call-mode";
import { loadPlatformModules } from "../platform/modules";
import { moduleForTool, platformTools, platformWriteTools, ToolContext } from "../platform/registry";
import { mountPlatform, requireAgentKey, requireToolKey } from "../platform/app";
import { corsFromEnv } from "../platform/cors";
import { auditToolCall, flushAudit } from "../platform/audit";
import { auditedUnity } from "../platform/audited-unity";
import { mountRetellWebhook } from "../platform/modules/activity";
import { mountRetellInbound } from "../platform/modules/activity/retell-inbound";
import { mountFaxWebhook } from "../platform/modules/intake";
import { failFastWhenDown, setSystemStatus, SystemStatus } from "../platform/system-status";
import { setStatusBanner } from "../platform/shell";
import { statusBanner } from "../platform/status-ui";
import { TokenKeepWarm, UnityHealthChecker } from "./services/unity-health";
import { attachUpcomingVisits, needsVeradigm, recordsUnavailable } from "./agent-edge";
import { callBindings, normalizeCallId, withCallBinding } from "../platform/call-binding";

const app = express();
const PORT = process.env.UNITY_PORT || 3001;

// Initialize services
const authService = new UnityAuthService();
const unityService = new UnityService(authService);
const appointmentTools = new UnityAppointmentTools(unityService);
const patientTools = new UnityPatientTools(unityService);
const clinicalTools = new UnityClinicalTools(unityService);
const billingTools = new UnityBillingTools(unityService);
const taskTools = new UnityTaskTools(unityService);
// Veradigm-required admin actions: GetServerInfo at start (cached), LastLogs after Veradigm-side errors.
const diagnostics = new UnityDiagnostics({ unity: auditedUnity(unityService, "diagnostics"), targets: configuredTargets });
unityService.onServerError((action, target, code) => diagnostics.onServerError(action, target, code));
setUnityDiagnostics(diagnostics);
// System status (staff banner, phone agent, help-desk alerts), the Veradigm health checker and token keep-warm.
const systemStatus = new SystemStatus({ targets: configuredTargets });
setSystemStatus(systemStatus);
setStatusBanner(() => statusBanner(systemStatus));
// Auth latch: Veradigm refused a sign-in (wrong password, access denied) -> that system is DOWN at once (help-desk
// alert) and nothing more is sent for it until an operator retries on the "Veradigm connection" screen or the
// credentials change. A latch saved before a restart still applies (DOWN again; the status file prevents a
// second alert for the same outage).
setUnityAuth(authService);
const latchDown = (l: AuthLatch) => systemStatus.markDown(l.target, "AUTH_ERROR", `${l.stage}: sign-in stopped (${l.reason})`);
authService.onLatch(latchDown);
// The latch file is shared with other Drawbridge processes: look at it every 30 s (a local stat, no Veradigm
// call) so a latch set elsewhere turns the status DOWN at once instead of at the next probe.
setInterval(() => void authService.latchedTargets(), 30_000).unref();
for (const l of authService.latchedTargets()) {
  if (!configuredTargets().includes(l.target)) continue;
  console.error(`[Unity Auth] ${l.target} sign-in still stopped (Veradigm refused ${l.stage} at ${l.at}); retry on the Veradigm connection screen after fixing the credentials`);
  latchDown(l);
}
const healthChecker = new UnityHealthChecker({ auth: authService, unity: unityService, status: systemStatus, targets: configuredTargets });
unityService.onOutcome((action, target, ok, code) => healthChecker.onActionOutcome(action, target, ok, code));
const keepWarm = new TokenKeepWarm(authService, configuredTargets);
loadPlatformModules();

// Retell call events: needs the raw body for verification, so it goes before express.json().
mountRetellWebhook(app);
// Retell inbound-call webhook: line mode + records status as dynamic variables; warms the Veradigm sessions.
mountRetellInbound(app, () => void keepWarm.warmNow());
// MOATiT Fax deliveries (document intake): HMAC over the raw body, so also before express.json().
mountFaxWebhook(app);

// Middleware: CORS only for origins in DRAWBRIDGE_CORS_ORIGINS (default none: same origin only)
app.disable("x-powered-by");
app.use(corsFromEnv());
app.use(express.json());

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  // Never log request bodies: they carry names, birth dates and patient IDs (spec §4 rule 8).
  const tool = req.body?.name || req.body?.params?.name || req.body?.method || "";
  console.log(`📥 ${new Date().toISOString()} ${req.method} ${req.path} ${tool}`);
  next();
});

// Health check endpoint: open, so it says nothing about the Veradigm endpoint, app name or environment
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// List all tools
app.get("/tools", requireToolKey, (req: Request, res: Response) => {
  res.json({ tools: getToolDefinitions() });
});

// Tools offered to the phone agent (MCP tools/list): staff-only tools that list other patients are left out.
const getAgentToolDefinitions = () => getToolDefinitions().filter((t) => agentToolAllowed(t.name));

/**
 * One phone-agent tool call (Retell custom function or MCP tools/call): staff-only tools are refused (and audited),
 * patient-scoped tools run only for a patient verified on this call (identity before information, enforced here:
 * src/platform/call-binding.ts, keyed by the Retell call ID), and the result is cut to the minimum necessary before
 * the agent sees it (src/utils/minimum-necessary.ts). Staff screens and modules call executeTool directly.
 */
async function executeAgentTool(name: string, args: any, callId: string | undefined, callerPhone: string | undefined, channel: string): Promise<any> {
  if (!agentToolAllowed(name)) {
    auditToolCall({ server: "unity", tool: name, args, callId, success: false, errorCode: "STAFF_ONLY", latencyMs: 0, channel });
    return staffOnlyFailure(name);
  }
  const out = await withCallBinding(name, args, { server: "unity", callId, channel }, async (checked) => {
    // Veradigm known down (health checks): answer at once instead of waiting through timeouts.
    if (needsVeradigm(name) && failFastWhenDown() && systemStatus.isDown()) {
      auditToolCall({ server: "unity", tool: name, args: checked, callId, success: false, errorCode: "RECORDS_UNAVAILABLE", latencyMs: 0, channel });
      return recordsUnavailable(name);
    }
    keepWarm.noteActivity();
    return forAgent(name, checked, await executeTool(name, checked, callId, callerPhone, channel));
  });
  if (name === "unity_search_patients") {
    // The verified patient's upcoming visits ride along (saves a tool round; agent-edge.ts).
    // Only for the patient this search just bound to the call (never on a read-back or unbound hit).
    return attachUpcomingVisits(args, out, async (patientId) =>
      callBindings.resolve(normalizeCallId(callId), "pm", patientId) === patientId
        ? executeTool("unity_get_patient_appointments", { patientId }, callId, callerPhone, channel)
        : null,
    );
  }
  return out;
}

// Get all tool definitions
const getToolDefinitions = () => {
  return [
    ...appointmentTools.getTools(),
    ...patientTools.getTools(),
    ...clinicalTools.getTools(),
    ...billingTools.getTools(),
    ...taskTools.getTools(),
    ...platformTools(),
  ];
};

// Write tools: each carries an idempotency key so a retried request cannot double-book (spec §4 rule 3).
const WRITE_TOOLS = new Set<string>([
  ...platformWriteTools(),
  "unity_save_appointment",
  "unity_cancel_appointment",
  "unity_confirm_appointment",
  "unity_create_staff_task",
]);

/**
 * Run a tool. Never throws: a failure comes back as { success:false, error_code, retryable }
 * so the agent says "I'm having trouble" instead of "none found" (CLAUDE.md rule 5).
 */
async function executeTool(name: string, args: any, callId?: string, callerPhone?: string, channel = "platform"): Promise<any> {
  // Audit log (spec §4 rule 8): metadata only, written async, never throws.
  const t0 = Date.now();
  const result = await executeToolUnaudited(name, args, callId, callerPhone);
  const failed = isToolFailure(result);
  auditToolCall({ server: "unity", tool: name, args, callId, success: !failed, errorCode: failed ? result.error_code : undefined, latencyMs: Date.now() - t0, channel });
  return result;
}

async function executeToolUnaudited(name: string, args: any, callId?: string, callerPhone?: string): Promise<any> {
  const ctx: ToolContext = { callId, callerPhone };
  const mod = moduleForTool(name);
  const exec = () => (mod?.run ? mod.run(name, args, ctx) : runTool(name, args));

  try {
    const result = WRITE_TOOLS.has(name)
      ? await withIdempotency(callId, name, args, exec)
      : await exec();
    // Record Veradigm tool calls on the call's notebook entry (platform drawbridge_* tools excluded).
    if (!name.startsWith("drawbridge_") && (currentMode() === "after_hours" || callRecords.get(callId || ""))) {
      callRecords.recordAction(callId, currentMode(), name, true, result?.taskId ? `task ${result.taskId}` : undefined);
    }
    return result;
  } catch (error) {
    const failure = toToolFailure(error, name);
    console.error(`[Unity] ${name} failed: ${failure.error_code} ${failure.message}`);
    if (!name.startsWith("drawbridge_") && (currentMode() === "after_hours" || callRecords.get(callId || ""))) {
      callRecords.recordAction(callId, currentMode(), name, false, failure.error_code);
    }
    return failure;
  }
}

async function runTool(name: string, args: any): Promise<any> {
  // Appointment tools
  if (name === "unity_save_appointment") {
    return await appointmentTools.saveAppointment(args);
  } else if (name === "unity_cancel_appointment") {
    return await appointmentTools.cancelAppointment(args);
  } else if (name === "unity_confirm_appointment") {
    return await appointmentTools.confirmAppointment(args);
  } else if (name === "unity_get_cancellation_reasons") {
    return await appointmentTools.getCancellationReasons();
  } else if (name === "unity_get_appointment_types") {
    return await appointmentTools.getAppointmentTypes();
  } else if (name === "unity_get_appointment_details") {
    return await appointmentTools.getAppointmentDetails(args);
  } else if (name === "unity_get_open_slots") {
    return await appointmentTools.getOpenSlots(args);
  } else if (name === "unity_get_patient_appointments") {
    return await appointmentTools.getPatientAppointments(args);
  }

  // Patient tools
  // unity_save_patient / unity_update_demographics: removed in this release (SavePatient not used).
  else if (name === "unity_get_patient") {
    return await patientTools.getPatient(args);
  } else if (name === "unity_search_patients") {
    return await patientTools.searchPatients(args);
  } else if (name === "unity_get_patient_by_mrn") {
    return await patientTools.getPatientByMRN(args);
  }

  // Clinical tools
  else if (name === "unity_get_patient_problems") {
    return await clinicalTools.getPatientProblems(args);
  } else if (name === "unity_get_patient_medications") {
    return await clinicalTools.getPatientMedications(args);
  } else if (name === "unity_get_patient_allergies") {
    return await clinicalTools.getPatientAllergies(args);
  } else if (name === "unity_get_patient_diagnosis") {
    return await clinicalTools.getPatientDiagnosis(args);
  } else if (name === "unity_get_recent_results") {
    return await clinicalTools.getRecentResults(args);
  }

  // Billing tools
  else if (name === "unity_get_account_balance") {
    return await billingTools.getAccountBalance(args);
  } else if (name === "unity_get_insurance_policy") {
    return await billingTools.getInsurancePolicy(args);
  }

  // Staff task (the only EHR write)
  else if (name === "unity_create_staff_task") {
    return await taskTools.createStaffTask(args);
  }

  throw new Error(`Unknown tool: ${name}`);
}

// MCP JSON-RPC 2.0 endpoint
app.post("/", requireToolKey, async (req: Request, res: Response): Promise<void> => {
  const { jsonrpc, method, params, id } = req.body;

  if (jsonrpc !== "2.0") {
    res.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32600,
        message: "Invalid Request: JSON-RPC version must be 2.0",
      },
    });
    return;
  }

  try {
    let result: any;

    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: {
            name: "veradigm-unity-mcp-server",
            version: "1.0.0",
          },
        };
        break;

      case "tools/list":
        result = { tools: getAgentToolDefinitions() };
        break;

      case "tools/call": {
        const { name, arguments: toolArgs } = params || {};
        if (!name) {
          throw new Error("Tool name is required");
        }

        const toolRequestTime = new Date();
        const toolStartTime = Date.now();
        const apiKey = req.headers["x-api-key"] as string | undefined;
        const channel =
          (req.headers["x-mcp-channel"] as string) ||
          (req.headers["x-channel"] as string) ||
          adminLogger.getDefaultChannel();

        try {
          const callId =
            (req.headers["x-call-id"] as string) || toolArgs?.call_id || undefined;
          const toolResult = await executeAgentTool(name, toolArgs || {}, callId, undefined, channel);
          const toolResponseTime = Date.now() - toolStartTime;
          const failed = toolResult?.success === false && toolResult?.error_code;

          adminLogger.logToolCall(
            {
              toolName: name,
              requestTime: toolRequestTime,
              responseTime: toolResponseTime,
              status: failed ? "ERROR" : "SUCCESS",
              errorMessage: failed ? toolResult.error_code : undefined,
              metadata: { server: "unity" },
            },
            channel,
            apiKey,
          ).catch(() => {});

          // MCP endpoint is primarily used by voice AI (Retell), always use
          // short speakable summary so AI can respond quickly
          const responseText = toVoiceSummary(name, toolResult);

          result = {
            content: [
              {
                type: "text",
                text: responseText,
              },
            ],
          };
        } catch (toolError: any) {
          const toolResponseTime = Date.now() - toolStartTime;
          adminLogger.logToolCall(
            {
              toolName: name,
              requestTime: toolRequestTime,
              responseTime: toolResponseTime,
              status: "ERROR",
              errorMessage: toolError?.message || String(toolError),
              metadata: { server: "unity" },
            },
            channel,
            apiKey,
          ).catch(() => {});

          // Return a structured failure the agent can act on; never raw error text.
          result = {
            content: [
              {
                type: "text",
                text: toVoiceSummary(name, toToolFailure(toolError, name)),
              },
            ],
          };
        }
        break;
      }

      default:
        res.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
        return;
    }

    const response = { jsonrpc: "2.0", id, result };
    res.json(response);
  } catch (error: any) {
    console.error("Error:", error.message);
    res.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error.message || "Internal error",
        data: {
          timestamp: new Date().toISOString(),
        },
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// Retell Custom Function endpoint
// Retell sends:  { name, args, call }
// We return:     plain text string (Retell converts to speech)
//
// This is preferred over MCP because custom functions have the
// "Speak After Execution" toggle in the Retell dashboard.
// ═══════════════════════════════════════════════════════════════
app.post("/api/retell", requireAgentKey, async (req: Request, res: Response): Promise<void> => {
  const { name, args, call } = req.body;
  const t0 = Date.now();
  const requestTime = new Date();

  if (!name) {
    res.status(400).json("Tool name is required");
    return;
  }

  // executeTool never throws; failures come back as { success:false, error_code, retryable }.
  const toolResult = await executeAgentTool(name, args || {}, call?.call_id, call?.from_number, "retell");
  const responseText = toVoiceSummary(name, toolResult);
  const responseTime = Date.now() - t0;
  const failed = toolResult?.success === false && toolResult?.error_code;

  // Log outcome only, never response text (it can contain chart data).
  console.log(`${failed ? "❌" : "✅"} [Retell] ${name} → ${responseTime}ms${failed ? ` → ${toolResult.error_code}` : ""}`);

  adminLogger.logToolCall({
    toolName: name,
    requestTime,
    responseTime,
    status: failed ? "ERROR" : "SUCCESS",
    errorMessage: failed ? toolResult.error_code : undefined,
  }, "RETELL").catch(() => {});

  res.json(responseText);
});

// Test authentication endpoint
app.get("/test/auth", requireToolKey, async (req: Request, res: Response) => {
  try {
    const ehrToken = await authService.getSecurityToken("EHR");
    const pmToken = await authService.getSecurityToken("PM");
    const session = await authService.getAuthenticatedSession("EHR");

    res.json({
      status: "authenticated",
      ehrToken: ehrToken ? `${ehrToken.substring(0, 8)}...` : null,
      pmToken: pmToken ? `${pmToken.substring(0, 8)}...` : null,
      userAuthenticated: session.userAuth.authenticated,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      status: "error",
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Veradigm connection (GetServerInfo, cached): product, version and time zone per configured system only.
app.get("/diagnostics/veradigm", requireToolKey, (req: Request, res: Response) => {
  const lastLogs = diagnostics.lastLogs();
  res.json({
    server_info: diagnostics.serverInfo(),
    last_logs: { count: lastLogs.length, latest_at: lastLogs[0]?.at || null },
    timestamp: new Date().toISOString(),
  });
});

// Test server info endpoint: re-runs GetServerInfo now (same summary fields, never the raw reply)
app.get("/test/serverinfo", requireToolKey, async (req: Request, res: Response) => {
  res.json({ server_info: await diagnostics.refreshServerInfo(true), timestamp: new Date().toISOString() });
});

// Drawbridge platform: staff app at /app, module APIs at /api/<module>
mountPlatform(app, {
  unity: unityService,
  runTool: (name, args, ctx) => executeTool(name, args, ctx?.callId, ctx?.callerPhone),
});

// Start server
const httpServer = app.listen(PORT, () => {
  // First token + login per configured system, then GetServerInfo (also pre-warms auth for the first Retell call).
  // A failure is logged and shown as "unavailable"; it never stops the server.
  diagnostics.start();
  // Veradigm health probe every UNITY_HEALTH_CHECK_MIN (default 15, 2-minute floor) and token keep-warm.
  // The first probe waits for that start-up GetServerInfo (refreshServerInfo joins the call in flight, it
  // does not send another), so a system that just answered is not probed again within 2 minutes.
  healthChecker.start(diagnostics.refreshServerInfo(true));
  keepWarm.start();

  console.log("");
  console.log(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║        VERADIGM UNITY MCP SERVER (HTTP)                      ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════╝",
  );
  console.log("");
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🏥 Unity Endpoint: ${unityConfig.ubiquityEndpoint}`);
  console.log(`📱 App Name: ${unityConfig.appName}`);
  console.log(`🔧 Environment: ${unityConfig.nodeEnv}`);
  console.log("");
  console.log(`📋 Available Tools (${getToolDefinitions().length}):`);
  console.log("   Patient Operations (3):");
  console.log("     • unity_search_patients - Search patients by name/DOB");
  console.log("     • unity_get_patient - Get patient details");
  console.log("     • unity_get_patient_by_mrn - Get patient by MRN");
  console.log("   Appointment Operations (4):");
  console.log("     • unity_get_open_slots - Find available slots");
  console.log("     • unity_save_appointment - Book appointment");
  console.log("     • unity_cancel_appointment - Cancel appointment");
  console.log("     • unity_get_patient_appointments - Get appointments");
  console.log("   Clinical Operations (4):");
  console.log("     • unity_get_patient_problems - Get conditions/problems");
  console.log("     • unity_get_patient_medications - Get medications");
  console.log("     • unity_get_patient_allergies - Get allergies");
  console.log("     • unity_get_patient_diagnosis - Get diagnoses");
  console.log("   Added for the Oct 9 demo:");
  console.log("     • unity_get_cancellation_reasons, unity_get_appointment_types,");
  console.log("       unity_get_appointment_details, unity_confirm_appointment,");
  console.log("       unity_get_account_balance, unity_get_insurance_policy,");
  console.log("       unity_create_staff_task");
  console.log("");
  console.log("🔗 Endpoints:");
  console.log(`   POST http://localhost:${PORT}/        - MCP JSON-RPC 2.0`);
  console.log(`   POST http://localhost:${PORT}/api/retell - Retell Custom Function`);
  console.log(`   GET  http://localhost:${PORT}/health  - Health check`);
  console.log(`   GET  http://localhost:${PORT}/tools   - List all tools`);
  console.log(
    `   GET  http://localhost:${PORT}/test/auth - Test authentication`,
  );
  console.log("");
  console.log("Ready for Retell AI integration! 🎙️");
  console.log("");
});

// Graceful shutdown (SIGINT/SIGTERM, e.g. docker stop): stop taking requests, retire the Unity tokens
// this process holds (RetireToken, PM and EHR), flush the audit log. Forced exit after 10 s.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Unity] ${signal}: shutting down`);
  setTimeout(() => process.exit(0), 10_000).unref();
  httpServer.close();
  await unityService.cleanup();
  await systemStatus.flush().catch(() => undefined);
  await flushAudit().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
