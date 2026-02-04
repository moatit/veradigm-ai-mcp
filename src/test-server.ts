#!/usr/bin/env node

import cors from "cors";
import express from "express";
import { config } from "./config/environment";
import { AuthService } from "./services/auth.service";
import { FHIRService } from "./services/fhir.service";
import { AppointmentTools } from "./tools/appointment.tools";
import { ClinicalTools } from "./tools/clinical.tools";
import { MedicationTools } from "./tools/medication.tools";
import { PatientTools } from "./tools/patient.tools";
import { ProviderTools } from "./tools/provider.tools";
import { ErrorHandler } from "./utils/error-handler";
import { adminLogger } from "./middleware/admin-logger";
import { accessControl, requiresFhirAccess, requiresUnityAccess } from "./middleware/access-control";

const app = express();

// Enable CORS for Retell AI and other external services
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    credentials: false,
  })
);

app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function (body: any) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    if (req.body && Object.keys(req.body).length > 0) {
      console.log("📥 Request:", JSON.stringify(req.body, null, 2));
    }
    console.log("📤 Response:", JSON.stringify(body, null, 2));
    return originalJson(body);
  };
  next();
});

// Initialize services (same as index.ts)
const authService = new AuthService();
const fhirService = new FHIRService(authService);

// Initialize all tool classes (same as index.ts)
const patientTools = new PatientTools(fhirService);
const appointmentTools = new AppointmentTools(fhirService);
const medicationTools = new MedicationTools(fhirService);
const providerTools = new ProviderTools(fhirService);
const clinicalTools = new ClinicalTools(fhirService);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    environment: config.nodeEnv,
    fhirBaseUrl: config.fhirBaseUrl,
    timestamp: new Date().toISOString(),
  });
});

// List available tools (REST endpoint for testing)
app.get("/tools", (req, res) => {
  const allTools = [
    ...patientTools.getTools(),
    ...appointmentTools.getTools(),
    ...medicationTools.getTools(),
    ...providerTools.getTools(),
    ...clinicalTools.getTools(),
  ];

  res.json({ tools: allTools });
});

// =============================================================================
// MCP PROTOCOL ENDPOINTS (JSON-RPC 2.0) - For RetellAI
// =============================================================================

// Root-level JSON-RPC handler (for RetellAI base URL calls)
app.post("/", async (req, res): Promise<void> => {
  try {
    const method = req.body.method;

    // MCP Protocol: initialize handshake
    if (method === "initialize") {
      const response = {
        jsonrpc: "2.0",
        id: req.body.id !== undefined ? req.body.id : null,
        result: {
          protocolVersion: req.body.params?.protocolVersion || "2025-06-18",
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          serverInfo: {
            name: "veradigm-fhir-mcp-server",
            version: "1.0.0",
          },
        },
      };
      res.json(response);
      return;
    }

    // MCP Protocol: initialized notification (no response needed, but we'll acknowledge)
    if (method === "initialized" || method === "notifications/initialized") {
      // Notifications don't require a response, but we'll send an empty success response
      res.status(200).json({
        jsonrpc: "2.0",
        id: req.body.id !== undefined ? req.body.id : null,
        result: {},
      });
      return;
    }

    // MCP Protocol: tools/list
    if (method === "tools/list") {
      const allTools = [
        ...patientTools.getTools(),
        ...appointmentTools.getTools(),
        ...medicationTools.getTools(),
        ...providerTools.getTools(),
        ...clinicalTools.getTools(),
      ];

      const response = {
        jsonrpc: "2.0",
        id: req.body.id !== undefined ? req.body.id : null,
        result: { tools: allTools },
      };
      res.json(response);
      return;
    }

    // MCP Protocol: tools/call
    if (method === "tools/call") {
      const { name, arguments: args } = req.body.params || {};
      const toolRequestTime = new Date();
      const toolStartTime = Date.now();
      
      // Get channel from header or use default (for multi-client support)
      const channel = (req.headers['x-mcp-channel'] as string) || 
                      (req.headers['x-channel'] as string) || 
                      adminLogger.getDefaultChannel();

      // Access control check
      const apiKey = req.headers['x-api-key'] as string;
      if (apiKey && process.env.ADMIN_PORTAL_URL) {
        const validation = await accessControl.validateClient(apiKey);
        
        if (!validation.valid) {
          res.status(401).json({
            jsonrpc: "2.0",
            id: req.body.id || null,
            error: {
              code: -32001,
              message: "Invalid API key",
              data: validation.error,
            },
          });
          return;
        }

        // Check FHIR access for FHIR tools
        if (requiresFhirAccess(name) && !accessControl.hasFhirAccess(validation.client)) {
          res.status(403).json({
            jsonrpc: "2.0",
            id: req.body.id || null,
            error: {
              code: -32002,
              message: "Access denied: No FHIR access",
              data: { tool: name, required: "fhirAccess" },
            },
          });
          return;
        }

        // Check Unity access for Unity tools
        if (requiresUnityAccess(name) && !accessControl.hasUnityAccess(validation.client)) {
          res.status(403).json({
            jsonrpc: "2.0",
            id: req.body.id || null,
            error: {
              code: -32003,
              message: "Access denied: No Unity access",
              data: { tool: name, required: "unityAccess" },
            },
          });
          return;
        }
      }

      let result: any;

      // Patient tools
      if (name === "search_patient") {
        result = await patientTools.searchPatient(args || {});
      } else if (name === "get_patient_details") {
        result = await patientTools.getPatientDetails(args || {});
      } else if (name === "verify_patient_identity") {
        result = await patientTools.verifyPatientIdentity(args || {});

        // Appointment tools
      } else if (name === "get_upcoming_appointments") {
        result = await appointmentTools.getUpcomingAppointments(args || {});
      } else if (name === "get_appointment_details") {
        result = await appointmentTools.getAppointmentDetails(args || {});
      } else if (name === "check_appointment_status") {
        result = await appointmentTools.checkAppointmentStatus(args || {});
      } else if (name === "find_patient_next_appointment") {
        result = await appointmentTools.findPatientNextAppointment(args || {});
      } else if (name === "get_appointments_by_date_range") {
        result = await appointmentTools.getAppointmentsByDateRange(args || {});
      } else if (name === "create_appointment") {
        result = await appointmentTools.createAppointment(args || {});

        // Medication tools
      } else if (name === "get_patient_medications") {
        result = await medicationTools.getPatientMedications(args || {});
      } else if (name === "get_medication_requests") {
        result = await medicationTools.getMedicationRequests(args || {});
      } else if (name === "check_refill_status") {
        result = await medicationTools.checkRefillStatus(args || {});
      } else if (name === "get_medication_statements") {
        result = await medicationTools.getMedicationStatements(args || {});

        // Provider tools
      } else if (name === "search_providers") {
        result = await providerTools.searchProviders(args || {});
      } else if (name === "get_provider_details") {
        result = await providerTools.getProviderDetails(args || {});
      } else if (name === "search_locations") {
        result = await providerTools.searchLocations(args || {});
      } else if (name === "get_location_details") {
        result = await providerTools.getLocationDetails(args || {});

        // Clinical tools
      } else if (name === "get_patient_conditions") {
        result = await clinicalTools.getPatientConditions(args || {});
      } else if (name === "get_allergies") {
        result = await clinicalTools.getAllergies(args || {});
      } else if (name === "get_recent_observations") {
        result = await clinicalTools.getRecentObservations(args || {});
      } else if (name === "get_patient_procedures") {
        result = await clinicalTools.getPatientProcedures(args || {});
      } else if (name === "get_patient_coverage") {
        result = await clinicalTools.getPatientCoverage(args || {});
      } else {
        throw ErrorHandler.createValidationError(`Unknown tool: ${name}`);
      }

      // Log successful call to admin portal (use request's client key so log goes to right client)
      const toolResponseTime = Date.now() - toolStartTime;
      adminLogger.logToolCall({
        toolName: name,
        requestTime: toolRequestTime,
        responseTime: toolResponseTime,
        status: 'SUCCESS',
      }, channel, apiKey);

      res.json({
        jsonrpc: "2.0",
        id: req.body.id || null,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      });
      return;
    }

    // Unknown method
    res.status(400).json({
      jsonrpc: "2.0",
      id: req.body.id || null,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    });
  } catch (error: any) {
    const fhirError = ErrorHandler.handleUnknownError(error);
    ErrorHandler.logError(fhirError, `Method: ${req.body.method}`);

    // Log failed call to admin portal (if it was a tools/call)
    if (req.body.method === "tools/call" && req.body.params?.name) {
      const errorChannel = (req.headers['x-mcp-channel'] as string) || 
                           (req.headers['x-channel'] as string) || 
                           adminLogger.getDefaultChannel();
      const errorApiKey = req.headers['x-api-key'] as string;
      adminLogger.logToolCall({
        toolName: req.body.params.name,
        requestTime: new Date(),
        responseTime: 0,
        status: 'ERROR',
        errorMessage: fhirError.message,
      }, errorChannel, errorApiKey);
    }

    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body.id || null,
      error: {
        code: -32603,
        message: fhirError.message,
        data: {
          code: fhirError.code,
          details: fhirError.details,
          timestamp: fhirError.timestamp,
        },
      },
    });
  }
});

// MCP tools/list endpoint (JSON-RPC 2.0)
app.post("/mcp/tools/list", async (req, res) => {
  try {
    const allTools = [
      ...patientTools.getTools(),
      ...appointmentTools.getTools(),
      ...medicationTools.getTools(),
      ...providerTools.getTools(),
      ...clinicalTools.getTools(),
    ];

    // JSON-RPC 2.0 response format
    const jsonrpcResponse = {
      jsonrpc: "2.0",
      id: req.body.id || null,
      result: {
        tools: allTools,
      },
    };

    res.json(jsonrpcResponse);
  } catch (error: any) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body.id || null,
      error: {
        code: -32603,
        message: "Internal error",
        data: error.message,
      },
    });
  }
});

// Alternative endpoint: POST /tools/list (for compatibility)
app.post("/tools/list", async (req, res) => {
  try {
    const allTools = [
      ...patientTools.getTools(),
      ...appointmentTools.getTools(),
      ...medicationTools.getTools(),
      ...providerTools.getTools(),
      ...clinicalTools.getTools(),
    ];

    const jsonrpcResponse = {
      jsonrpc: "2.0",
      id: req.body.id || null,
      result: {
        tools: allTools,
      },
    };

    res.json(jsonrpcResponse);
  } catch (error: any) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body.id || null,
      error: {
        code: -32603,
        message: "Internal error",
        data: error.message,
      },
    });
  }
});

// MCP tools/call endpoint (JSON-RPC 2.0)
app.post("/mcp/tools/call", async (req, res) => {
  try {
    const { name, arguments: args } = req.body.params || req.body;

    let result: any;

    // Patient tools
    if (name === "search_patient") {
      result = await patientTools.searchPatient(args || {});
    } else if (name === "get_patient_details") {
      result = await patientTools.getPatientDetails(args || {});
    } else if (name === "verify_patient_identity") {
      result = await patientTools.verifyPatientIdentity(args || {});

      // Appointment tools
    } else if (name === "get_upcoming_appointments") {
      result = await appointmentTools.getUpcomingAppointments(args || {});
    } else if (name === "get_appointment_details") {
      result = await appointmentTools.getAppointmentDetails(args || {});
    } else if (name === "check_appointment_status") {
      result = await appointmentTools.checkAppointmentStatus(args || {});
    } else if (name === "find_patient_next_appointment") {
      result = await appointmentTools.findPatientNextAppointment(args || {});
    } else if (name === "get_appointments_by_date_range") {
      result = await appointmentTools.getAppointmentsByDateRange(args || {});
    } else if (name === "create_appointment") {
      result = await appointmentTools.createAppointment(args || {});

      // Medication tools
    } else if (name === "get_patient_medications") {
      result = await medicationTools.getPatientMedications(args || {});
    } else if (name === "get_medication_requests") {
      result = await medicationTools.getMedicationRequests(args || {});
    } else if (name === "check_refill_status") {
      result = await medicationTools.checkRefillStatus(args || {});
    } else if (name === "get_medication_statements") {
      result = await medicationTools.getMedicationStatements(args || {});

      // Provider tools
    } else if (name === "search_providers") {
      result = await providerTools.searchProviders(args || {});
    } else if (name === "get_provider_details") {
      result = await providerTools.getProviderDetails(args || {});
    } else if (name === "search_locations") {
      result = await providerTools.searchLocations(args || {});
    } else if (name === "get_location_details") {
      result = await providerTools.getLocationDetails(args || {});

      // Clinical tools
    } else if (name === "get_patient_conditions") {
      result = await clinicalTools.getPatientConditions(args || {});
    } else if (name === "get_allergies") {
      result = await clinicalTools.getAllergies(args || {});
    } else if (name === "get_recent_observations") {
      result = await clinicalTools.getRecentObservations(args || {});
    } else if (name === "get_patient_procedures") {
      result = await clinicalTools.getPatientProcedures(args || {});
    } else if (name === "get_patient_coverage") {
      result = await clinicalTools.getPatientCoverage(args || {});
    } else {
      throw ErrorHandler.createValidationError(`Unknown tool: ${name}`);
    }

    // JSON-RPC 2.0 response format
    const jsonrpcResponse = {
      jsonrpc: "2.0",
      id: req.body.id || null,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      },
    };

    res.json(jsonrpcResponse);
  } catch (error: any) {
    const fhirError = ErrorHandler.handleUnknownError(error);
    ErrorHandler.logError(
      fhirError,
      `Tool: ${req.body.params?.name || req.body.name}`
    );

    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body.id || null,
      error: {
        code: -32603,
        message: fhirError.message,
        data: {
          code: fhirError.code,
          details: fhirError.details,
          timestamp: fhirError.timestamp,
        },
      },
    });
  }
});

// Alternative endpoint: POST /tools/call (for compatibility)
app.post("/tools/call", async (req, res) => {
  try {
    const { name, arguments: args } = req.body.params || req.body;

    let result: any;

    // Patient tools
    if (name === "search_patient") {
      result = await patientTools.searchPatient(args || {});
    } else if (name === "get_patient_details") {
      result = await patientTools.getPatientDetails(args || {});
    } else if (name === "verify_patient_identity") {
      result = await patientTools.verifyPatientIdentity(args || {});

      // Appointment tools
    } else if (name === "get_upcoming_appointments") {
      result = await appointmentTools.getUpcomingAppointments(args || {});
    } else if (name === "get_appointment_details") {
      result = await appointmentTools.getAppointmentDetails(args || {});
    } else if (name === "check_appointment_status") {
      result = await appointmentTools.checkAppointmentStatus(args || {});
    } else if (name === "find_patient_next_appointment") {
      result = await appointmentTools.findPatientNextAppointment(args || {});
    } else if (name === "get_appointments_by_date_range") {
      result = await appointmentTools.getAppointmentsByDateRange(args || {});
    } else if (name === "create_appointment") {
      result = await appointmentTools.createAppointment(args || {});

      // Medication tools
    } else if (name === "get_patient_medications") {
      result = await medicationTools.getPatientMedications(args || {});
    } else if (name === "get_medication_requests") {
      result = await medicationTools.getMedicationRequests(args || {});
    } else if (name === "check_refill_status") {
      result = await medicationTools.checkRefillStatus(args || {});
    } else if (name === "get_medication_statements") {
      result = await medicationTools.getMedicationStatements(args || {});

      // Provider tools
    } else if (name === "search_providers") {
      result = await providerTools.searchProviders(args || {});
    } else if (name === "get_provider_details") {
      result = await providerTools.getProviderDetails(args || {});
    } else if (name === "search_locations") {
      result = await providerTools.searchLocations(args || {});
    } else if (name === "get_location_details") {
      result = await providerTools.getLocationDetails(args || {});

      // Clinical tools
    } else if (name === "get_patient_conditions") {
      result = await clinicalTools.getPatientConditions(args || {});
    } else if (name === "get_allergies") {
      result = await clinicalTools.getAllergies(args || {});
    } else if (name === "get_recent_observations") {
      result = await clinicalTools.getRecentObservations(args || {});
    } else if (name === "get_patient_procedures") {
      result = await clinicalTools.getPatientProcedures(args || {});
    } else if (name === "get_patient_coverage") {
      result = await clinicalTools.getPatientCoverage(args || {});
    } else {
      throw ErrorHandler.createValidationError(`Unknown tool: ${name}`);
    }

    const jsonrpcResponse = {
      jsonrpc: "2.0",
      id: req.body.id || null,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      },
    };

    res.json(jsonrpcResponse);
  } catch (error: any) {
    const fhirError = ErrorHandler.handleUnknownError(error);
    ErrorHandler.logError(
      fhirError,
      `Tool: ${req.body.params?.name || req.body.name}`
    );

    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body.id || null,
      error: {
        code: -32603,
        message: fhirError.message,
        data: {
          code: fhirError.code,
          details: fhirError.details,
          timestamp: fhirError.timestamp,
        },
      },
    });
  }
});

// Test patient search
app.post("/test/search-patient", async (req, res) => {
  try {
    const { name, birthDate } = req.body;
    const result = await patientTools.searchPatient({ name, birthDate });
    res.json(result);
  } catch (error: any) {
    console.error("Error in patient search:", error);
    res
      .status(500)
      .json({ error: "Failed to search patients", details: error.message });
  }
});

// Test patient details
app.post("/test/patient-details", async (req, res) => {
  try {
    const { patientId } = req.body;
    const result = await patientTools.getPatientDetails({ patientId });
    res.json(result);
  } catch (error: any) {
    console.error("Error getting patient details:", error);
    res
      .status(500)
      .json({ error: "Failed to get patient details", details: error.message });
  }
});

// Test authentication
app.get("/test/auth", async (req, res) => {
  try {
    const token = await authService.getAccessToken();
    res.json({
      success: true,
      hasToken: !!token,
      tokenLength: token ? token.length : 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Error testing authentication:", error);
    res.status(500).json({
      error: "Authentication failed",
      details: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Clear token cache (to force new token with scopes)
app.post("/test/auth/clear", async (req, res) => {
  try {
    authService.clearTokenCache();
    res.json({
      success: true,
      message:
        "Token cache cleared. Next request will get a new token with scopes.",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to clear cache",
      details: error.message,
    });
  }
});

// =============================================================================
// REST API ENDPOINTS (Using same tools as index.ts)
// =============================================================================

// Patient Operations
app.post("/api/patient/search", async (req, res) => {
  try {
    const result = await patientTools.searchPatient(req.body);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/patient/:patientId", async (req, res) => {
  try {
    const result = await patientTools.getPatientDetails({
      patientId: req.params.patientId,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/patient/verify", async (req, res) => {
  try {
    const result = await patientTools.verifyPatientIdentity(req.body);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Appointment Operations
app.get("/api/appointment", async (req, res) => {
  try {
    const { patientId, startDate, endDate, status, limit } = req.query;
    const result = await appointmentTools.getUpcomingAppointments({
      patientId: patientId as string,
      startDate: startDate as string,
      endDate: endDate as string,
      status: status as string,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/appointment/:appointmentId", async (req, res) => {
  try {
    const result = await appointmentTools.getAppointmentDetails({
      appointmentId: req.params.appointmentId,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/appointment/:appointmentId/status", async (req, res) => {
  try {
    const result = await appointmentTools.checkAppointmentStatus({
      appointmentId: req.params.appointmentId,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/appointment/next", async (req, res) => {
  try {
    const result = await appointmentTools.findPatientNextAppointment({
      patientId: req.query.patientId as string,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Medication Operations
app.get("/api/medication", async (req, res) => {
  try {
    const { patientId, status, intent, limit } = req.query;
    const result = await medicationTools.getPatientMedications({
      patientId: patientId as string,
      status: status as string,
      intent: intent as string,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/medication/requests", async (req, res) => {
  try {
    const { patientId, status, intent, limit } = req.query;
    const result = await medicationTools.getMedicationRequests({
      patientId: patientId as string,
      status: status as string,
      intent: intent as string,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/medication/:medicationId/refill", async (req, res) => {
  try {
    const { patientId } = req.query;
    const result = await medicationTools.checkRefillStatus({
      patientId: patientId as string,
      medicationName: req.params.medicationId,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/medication/statements", async (req, res) => {
  try {
    const { patientId, status, limit } = req.query;
    const result = await medicationTools.getMedicationStatements({
      patientId: patientId as string,
      status: status as string,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Provider Operations
app.get("/api/provider/search", async (req, res) => {
  try {
    const result = await providerTools.searchProviders(req.query as any);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/provider/:providerId", async (req, res) => {
  try {
    const result = await providerTools.getProviderDetails({
      providerId: req.params.providerId,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/location/search", async (req, res) => {
  try {
    const result = await providerTools.searchLocations(req.query as any);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/location/:locationId", async (req, res) => {
  try {
    const result = await providerTools.getLocationDetails({
      locationId: req.params.locationId,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Clinical Operations
app.get("/api/clinical/conditions", async (req, res) => {
  try {
    const { patientId, status, category, limit } = req.query;
    const result = await clinicalTools.getPatientConditions({
      patientId: patientId as string,
      status: status as string,
      category: category as string,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/clinical/allergies", async (req, res) => {
  try {
    const { patientId, status, limit } = req.query;
    const result = await clinicalTools.getAllergies({
      patientId: patientId as string,
      status: status as string,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/clinical/observations", async (req, res) => {
  try {
    const { patientId, category, code, limit } = req.query;
    const result = await clinicalTools.getRecentObservations({
      patientId: patientId as string,
      category: category as string,
      code: code as string,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/clinical/procedures", async (req, res) => {
  try {
    const { patientId, status, limit } = req.query;
    const result = await clinicalTools.getPatientProcedures({
      patientId: patientId as string,
      status: status as string,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/clinical/coverage", async (req, res) => {
  try {
    const { patientId, status, limit } = req.query;
    const result = await clinicalTools.getPatientCoverage({
      patientId: patientId as string,
      status: status as string,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = parseInt(process.env.MCP_SERVER_PORT || "3000");
const HOST = process.env.MCP_SERVER_HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(
    `\n╔═══════════════════════════════════════════════════════════════╗`
  );
  console.log(
    `║  Veradigm FHIR MCP - Complete Test Server                    ║`
  );
  console.log(
    `╚═══════════════════════════════════════════════════════════════╝\n`
  );
  console.log(`🚀 Server: http://${HOST}:${PORT}`);
  console.log(`📊 Environment: ${config.nodeEnv}`);
  console.log(`🔗 FHIR URL: ${config.fhirBaseUrl}`);
  console.log(
    `🔑 Auth: ${authService ? "✅ Configured" : "❌ Not configured"}`
  );
  console.log(
    `📊 Admin Portal: ${process.env.ADMIN_PORTAL_URL && process.env.ADMIN_API_KEY ? "✅ Logging enabled → " + process.env.ADMIN_PORTAL_URL : "❌ Not configured"}`
  );
  console.log(
    `🔐 Access Control: ${process.env.ADMIN_PORTAL_URL ? "✅ Enabled (API key required)" : "❌ Disabled (open access)"}\n`
  );

  console.log(`📋 Available Endpoints:\n`);
  console.log(`🔧 SYSTEM (3):`);
  console.log(`   GET  /health`);
  console.log(`   GET  /test/auth`);
  console.log(`   GET  /tools\n`);

  console.log(`👤 PATIENT (5):`);
  console.log(`   POST /test/search-patient - Legacy test endpoint`);
  console.log(`   POST /test/patient-details - Legacy test endpoint`);
  console.log(`   POST /api/patient/search`);
  console.log(`   GET  /api/patient/:patientId`);
  console.log(`   POST /api/patient/verify\n`);

  console.log(`📅 APPOINTMENT (4):`);
  console.log(`   GET  /api/appointment?patientId=xxx`);
  console.log(`   GET  /api/appointment/:appointmentId`);
  console.log(`   GET  /api/appointment/:appointmentId/status`);
  console.log(`   GET  /api/appointment/next?patientId=xxx\n`);

  console.log(`💊 MEDICATION (4):`);
  console.log(`   GET  /api/medication?patientId=xxx`);
  console.log(`   GET  /api/medication/requests?patientId=xxx`);
  console.log(`   GET  /api/medication/:medicationId/refill?patientId=xxx`);
  console.log(`   GET  /api/medication/statements?patientId=xxx\n`);

  console.log(`👨‍⚕️  PROVIDER (4):`);
  console.log(`   GET  /api/provider/search?name=xxx`);
  console.log(`   GET  /api/provider/:providerId`);
  console.log(`   GET  /api/location/search?name=xxx`);
  console.log(`   GET  /api/location/:locationId\n`);

  console.log(`🏥 CLINICAL (5):`);
  console.log(`   GET  /api/clinical/conditions?patientId=xxx`);
  console.log(`   GET  /api/clinical/allergies?patientId=xxx`);
  console.log(`   GET  /api/clinical/observations?patientId=xxx`);
  console.log(`   GET  /api/clinical/procedures?patientId=xxx`);
  console.log(`   GET  /api/clinical/coverage?patientId=xxx\n`);

  console.log(`📊 TOTAL: 28 Endpoints (using same tools as MCP server)\n`);
  
  console.log(`🔖 Multi-Client Support:`);
  console.log(`   Pass header 'X-MCP-Channel' or 'X-Channel' with value:`);
  console.log(`   RETELL | APP | WEB | API\n`);
  
  console.log(`🧪 Quick Test:`);
  console.log(`   curl http://localhost:${PORT}/health`);
  console.log(`   curl http://localhost:${PORT}/test/auth\n`);
});
