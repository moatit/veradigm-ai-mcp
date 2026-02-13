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

const app = express();
const PORT = process.env.UNITY_PORT || 3001;

// Initialize services
const authService = new UnityAuthService();
const unityService = new UnityService(authService);
const appointmentTools = new UnityAppointmentTools(unityService);
const patientTools = new UnityPatientTools(unityService);
const clinicalTools = new UnityClinicalTools(unityService);

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`📥 ${new Date().toISOString()} ${req.method} ${req.path}`);
  if (req.method === "POST" && req.body) {
    console.log("Request:", JSON.stringify(req.body, null, 2));
  }
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
  const allTools = [
    ...appointmentTools.getTools(),
    ...patientTools.getTools(),
    ...clinicalTools.getTools(),
  ];
  res.json({ tools: allTools });
});

// Get all tool definitions
const getToolDefinitions = () => {
  return [
    ...appointmentTools.getTools(),
    ...patientTools.getTools(),
    ...clinicalTools.getTools(),
  ];
};

// Handle tool execution
async function executeTool(name: string, args: any): Promise<any> {
  // Appointment tools
  if (name === "unity_save_appointment") {
    return await appointmentTools.saveAppointment(args);
  } else if (name === "unity_cancel_appointment") {
    return await appointmentTools.cancelAppointment(args);
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

  throw new Error(`Unknown tool: ${name}`);
}

// MCP JSON-RPC 2.0 endpoint
app.post("/", async (req: Request, res: Response): Promise<void> => {
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
          const toolResult = await executeTool(name, toolArgs || {});
          const toolResponseTime = Date.now() - toolStartTime;

          adminLogger.logToolCall(
            {
              toolName: name,
              requestTime: toolRequestTime,
              responseTime: toolResponseTime,
              status: "SUCCESS",
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

          // Return error as a normal result so Retell AI / voice clients
          // get a speakable response instead of a JSON-RPC error object
          const friendlyMsg = toolError?.message || "Something went wrong";
          result = {
            content: [
              {
                type: "text",
                text: `Sorry, that request failed: ${friendlyMsg}. Please try again.`,
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
    console.log("📤 Response:", JSON.stringify(response, null, 2));
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
app.post("/api/retell", async (req: Request, res: Response): Promise<void> => {
  const { name, args, call } = req.body;
  const t0 = Date.now();
  const requestTime = new Date();

  if (!name) {
    res.status(400).json("Tool name is required");
    return;
  }

  try {
    const toolResult = await executeTool(name, args || {});
    const responseText = toVoiceSummary(name, toolResult);
    const responseTime = Date.now() - t0;

    console.log(`✅ [Retell] ${name} → ${responseTime}ms → ${responseText.slice(0, 80)}`);

    adminLogger.logToolCall({
      toolName: name,
      requestTime,
      responseTime,
      status: "SUCCESS",
    }, "RETELL").catch(() => {});

    res.json(responseText);
  } catch (error: any) {
    const friendlyMsg = error?.message || "Something went wrong";
    const responseText = `Sorry, that request failed: ${friendlyMsg}. Please try again.`;
    const responseTime = Date.now() - t0;

    console.error(`❌ [Retell] ${name} → ${responseTime}ms → ${friendlyMsg}`);

    adminLogger.logToolCall({
      toolName: name,
      requestTime,
      responseTime,
      status: "ERROR",
      errorMessage: friendlyMsg,
    }, "RETELL").catch(() => {});

    res.json(responseText);
  }
});

// Test authentication endpoint
app.get("/test/auth", async (req: Request, res: Response) => {
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
app.get("/test/serverinfo", async (req: Request, res: Response) => {
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
  console.log("📋 Available Tools (13):");
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
