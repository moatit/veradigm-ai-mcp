/**
 * Unity HTTP Test Server for Retell AI Integration
 *
 * This server exposes Unity EHR tools via HTTP for integration with
 * Retell AI and other external platforms.
 *
 * Port: 3001
 */

import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
// Load env first so adminLogger gets ADMIN_PORTAL_URL and ADMIN_API_KEY
import { adminLogger } from "../middleware/admin-logger";
import { toVoiceSummary } from "../utils/response-formatter";
import { unityConfig } from "./config/environment";
import { UnityAuthService } from "./services/unity-auth.service";
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
import { mountPlatform, requireToolKey } from "../platform/app";
import { auditToolCall } from "../platform/audit";
import { mountRetellWebhook } from "../platform/modules/activity";

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
loadPlatformModules();

// Retell call events: needs the raw body for verification, so it goes before express.json().
mountRetellWebhook(app);

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  // Never log request bodies: they carry names, birth dates and patient IDs (spec §4 rule 8).
  const tool = req.body?.name || req.body?.params?.name || req.body?.method || "";
  console.log(`📥 ${new Date().toISOString()} ${req.method} ${req.path} ${tool}`);
  next();
});

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    server: "unity-mcp",
    environment: unityConfig.nodeEnv,
    unityEndpoint: unityConfig.ubiquityEndpoint,
    appName: unityConfig.appName,
    timestamp: new Date().toISOString(),
  });
});

// List all tools
app.get("/tools", (req: Request, res: Response) => {
  res.json({ tools: getToolDefinitions() });
});

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
  "unity_save_patient",
  "unity_update_demographics",
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
  else if (name === "unity_save_patient") {
    return await patientTools.savePatient(args);
  } else if (name === "unity_update_demographics") {
    return await patientTools.updateDemographics(args);
  } else if (name === "unity_get_patient") {
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
        result = { tools: getToolDefinitions() };
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
          const toolResult = await executeTool(name, toolArgs || {}, callId, undefined, channel);
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
app.post("/api/retell", requireToolKey, async (req: Request, res: Response): Promise<void> => {
  const { name, args, call } = req.body;
  const t0 = Date.now();
  const requestTime = new Date();

  if (!name) {
    res.status(400).json("Tool name is required");
    return;
  }

  // executeTool never throws; failures come back as { success:false, error_code, retryable }.
  const toolResult = await executeTool(name, args || {}, call?.call_id, call?.from_number, "retell");
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

// Test server info endpoint
app.get("/test/serverinfo", requireToolKey, async (req: Request, res: Response) => {
  try {
    const serverInfo = await unityService.getServerInfo("EHR");
    res.json(serverInfo);
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Drawbridge platform: staff app at /app, module APIs at /api/<module>
mountPlatform(app, {
  unity: unityService,
  runTool: (name, args, ctx) => executeTool(name, args, ctx?.callId, ctx?.callerPhone),
});

// Start server
app.listen(PORT, () => {
  // Pre-warm auth tokens so first Retell call doesn't wait for auth
  authService.getSecurityToken("EHR").catch(() => {});

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
  console.log("   Patient Operations (5):");
  console.log("     • unity_search_patients - Search patients by name/DOB");
  console.log("     • unity_get_patient - Get patient details");
  console.log("     • unity_get_patient_by_mrn - Get patient by MRN");
  console.log("     • unity_save_patient - Create new patient");
  console.log("     • unity_update_demographics - Update patient info");
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
