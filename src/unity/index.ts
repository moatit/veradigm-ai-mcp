#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { unityConfig } from "./config/environment";
import { UnityAuthService } from "./services/unity-auth.service";
import { UnityService } from "./services/unity.service";
import { UnityAppointmentTools } from "./tools/appointment.tools";
import { UnityPatientTools } from "./tools/patient.tools";
import { UnityClinicalTools } from "./tools/clinical.tools";
import { UnityBillingTools } from "./tools/billing.tools";
import { UnityTaskTools } from "./tools/task.tools";
import { toToolFailure } from "./utils/tool-result";
import { UnityErrorHandler } from "./utils/error-handler";

/**
 * Veradigm Unity MCP Server
 *
 * Provides write operations for Veradigm EHR and Practice Management systems
 * via the Unity API. This complements the FHIR MCP Server which handles read operations.
 *
 * Architecture:
 * - FHIR MCP Server (separate container) → Read Operations
 * - Unity MCP Server (this server) → Write Operations
 */
class VeradigmUnityMCPServer {
  private server: Server;
  private authService: UnityAuthService;
  private unityService: UnityService;
  private appointmentTools: UnityAppointmentTools;
  private patientTools: UnityPatientTools;
  private clinicalTools: UnityClinicalTools;
  private billingTools: UnityBillingTools;
  private taskTools: UnityTaskTools;

  constructor() {
    this.server = new Server(
      {
        name: "veradigm-unity-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize services
    this.authService = new UnityAuthService();
    this.unityService = new UnityService(this.authService);

    // Initialize tool classes
    this.appointmentTools = new UnityAppointmentTools(this.unityService);
    this.patientTools = new UnityPatientTools(this.unityService);
    this.clinicalTools = new UnityClinicalTools(this.unityService);
    this.billingTools = new UnityBillingTools(this.unityService);
    this.taskTools = new UnityTaskTools(this.unityService);

    this.setupHandlers();
    this.setupShutdownHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allTools = [
        ...this.appointmentTools.getTools(),
        ...this.patientTools.getTools(),
        ...this.clinicalTools.getTools(),
        ...this.billingTools.getTools(),
        ...this.taskTools.getTools(),
      ];

      return {
        tools: allTools,
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result: any;

        // Appointment tools
        if (name === "unity_save_appointment") {
          result = await this.appointmentTools.saveAppointment(args as any);
        } else if (name === "unity_cancel_appointment") {
          result = await this.appointmentTools.cancelAppointment(args as any);
        } else if (name === "unity_confirm_appointment") {
          result = await this.appointmentTools.confirmAppointment(args as any);
        } else if (name === "unity_get_cancellation_reasons") {
          result = await this.appointmentTools.getCancellationReasons();
        } else if (name === "unity_get_appointment_types") {
          result = await this.appointmentTools.getAppointmentTypes();
        } else if (name === "unity_get_appointment_details") {
          result = await this.appointmentTools.getAppointmentDetails(args as any);
        } else if (name === "unity_get_open_slots") {
          result = await this.appointmentTools.getOpenSlots(args as any);
        } else if (name === "unity_get_patient_appointments") {
          result = await this.appointmentTools.getPatientAppointments(
            args as any
          );
        }

        // Patient tools
        else if (name === "unity_save_patient") {
          result = await this.patientTools.savePatient(args as any);
        } else if (name === "unity_update_demographics") {
          result = await this.patientTools.updateDemographics(args as any);
        } else if (name === "unity_get_patient") {
          result = await this.patientTools.getPatient(args as any);
        } else if (name === "unity_search_patients") {
          result = await this.patientTools.searchPatients(args as any);
        } else if (name === "unity_get_patient_by_mrn") {
          result = await this.patientTools.getPatientByMRN(args as any);
        }

        // Clinical tools (read only)
        else if (name === "unity_get_patient_problems") {
          result = await this.clinicalTools.getPatientProblems(args as any);
        } else if (name === "unity_get_patient_medications") {
          result = await this.clinicalTools.getPatientMedications(args as any);
        } else if (name === "unity_get_patient_allergies") {
          result = await this.clinicalTools.getPatientAllergies(args as any);
        } else if (name === "unity_get_patient_diagnosis") {
          result = await this.clinicalTools.getPatientDiagnosis(args as any);
        } else if (name === "unity_get_recent_results") {
          result = await this.clinicalTools.getRecentResults(args as any);
        }

        // Billing and staff task
        else if (name === "unity_get_account_balance") {
          result = await this.billingTools.getAccountBalance(args as any);
        } else if (name === "unity_get_insurance_policy") {
          result = await this.billingTools.getInsurancePolicy(args as any);
        } else if (name === "unity_create_staff_task") {
          result = await this.taskTools.createStaffTask(args as any);
        }

        // Unknown tool
        else {
          throw UnityErrorHandler.createValidationError(
            `Unknown tool: ${name}`
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const unityError = UnityErrorHandler.handleUnknownError(error, name);
        UnityErrorHandler.logError(unityError, `Tool: ${name}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(toToolFailure(unityError, name), null, 2),
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const cleanup = async () => {
      console.error("[Unity MCP] Shutting down...");
      try {
        await this.unityService.cleanup();
        console.error("[Unity MCP] Cleanup completed");
      } catch (error) {
        console.error("[Unity MCP] Cleanup error:", error);
      }
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error(
      `Veradigm Unity MCP Server started (${unityConfig.nodeEnv} environment)`
    );
    console.error(`Unity Endpoint: ${unityConfig.ubiquityEndpoint}`);
    console.error(`App Name: ${unityConfig.appName}`);
    console.error(`Available tools: 20 Unity tools (Veradigm PM and EHR)`);
    console.error("");
    console.error("Tools available:");
    console.error("  Appointments:");
    console.error("    - unity_save_appointment");
    console.error("    - unity_cancel_appointment");
    console.error("    - unity_get_open_slots");
    console.error("    - unity_get_patient_appointments");
    console.error("  Patients:");
    console.error("    - unity_save_patient");
    console.error("    - unity_update_demographics");
    console.error("    - unity_get_patient");
    console.error("    - unity_search_patients");
    console.error("    - unity_get_patient_by_mrn");
  }
}

// Start the server
const server = new VeradigmUnityMCPServer();
server.start().catch((error) => {
  console.error("Failed to start Unity MCP server:", error);
  process.exit(1);
});
