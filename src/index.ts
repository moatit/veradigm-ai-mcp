#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

class VeradigmFHIRMCPServer {
  private server: Server;
  private authService: AuthService;
  private fhirService: FHIRService;
  private patientTools: PatientTools;
  private appointmentTools: AppointmentTools;
  private medicationTools: MedicationTools;
  private providerTools: ProviderTools;
  private clinicalTools: ClinicalTools;

  constructor() {
    this.server = new Server(
      {
        name: "veradigm-fhir-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize services
    this.authService = new AuthService();
    this.fhirService = new FHIRService(this.authService);

    // Initialize tool classes
    this.patientTools = new PatientTools(this.fhirService);
    this.appointmentTools = new AppointmentTools(this.fhirService);
    this.medicationTools = new MedicationTools(this.fhirService);
    this.providerTools = new ProviderTools(this.fhirService);
    this.clinicalTools = new ClinicalTools(this.fhirService);

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allTools = [
        ...this.patientTools.getTools(),
        ...this.appointmentTools.getTools(),
        ...this.medicationTools.getTools(),
        ...this.providerTools.getTools(),
        ...this.clinicalTools.getTools(),
      ];

      return {
        tools: allTools,
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const requestTime = new Date();
      const startTime = Date.now();

      try {
        let result: any;

        // Patient tools
        if (name === "search_patient") {
          result = await this.patientTools.searchPatient(args as any);
        } else if (name === "get_patient_details") {
          result = await this.patientTools.getPatientDetails(args as any);
        } else if (name === "verify_patient_identity") {
          result = await this.patientTools.verifyPatientIdentity(args as any);
        }

        // Appointment tools
        else if (name === "get_upcoming_appointments") {
          result = await this.appointmentTools.getUpcomingAppointments(
            args as any
          );
        } else if (name === "get_appointment_details") {
          result = await this.appointmentTools.getAppointmentDetails(
            args as any
          );
        } else if (name === "check_appointment_status") {
          result = await this.appointmentTools.checkAppointmentStatus(
            args as any
          );
        } else if (name === "find_patient_next_appointment") {
          result = await this.appointmentTools.findPatientNextAppointment(
            args as any
          );
        } else if (name === "get_appointments_by_date_range") {
          result = await this.appointmentTools.getAppointmentsByDateRange(
            args as any
          );
        } else if (name === "create_appointment") {
          result = await this.appointmentTools.createAppointment(args as any);
        }

        // Medication tools
        else if (name === "get_patient_medications") {
          result = await this.medicationTools.getPatientMedications(
            args as any
          );
        } else if (name === "get_medication_requests") {
          result = await this.medicationTools.getMedicationRequests(
            args as any
          );
        } else if (name === "check_refill_status") {
          result = await this.medicationTools.checkRefillStatus(args as any);
        } else if (name === "get_medication_statements") {
          result = await this.medicationTools.getMedicationStatements(
            args as any
          );
        }

        // Provider tools
        else if (name === "search_providers") {
          result = await this.providerTools.searchProviders(args as any);
        } else if (name === "get_provider_details") {
          result = await this.providerTools.getProviderDetails(args as any);
        } else if (name === "search_locations") {
          result = await this.providerTools.searchLocations(args as any);
        } else if (name === "get_location_details") {
          result = await this.providerTools.getLocationDetails(args as any);
        }

        // Clinical tools
        else if (name === "get_patient_conditions") {
          result = await this.clinicalTools.getPatientConditions(args as any);
        } else if (name === "get_allergies") {
          result = await this.clinicalTools.getAllergies(args as any);
        } else if (name === "get_recent_observations") {
          result = await this.clinicalTools.getRecentObservations(args as any);
        } else if (name === "get_patient_procedures") {
          result = await this.clinicalTools.getPatientProcedures(args as any);
        } else if (name === "get_patient_coverage") {
          result = await this.clinicalTools.getPatientCoverage(args as any);
        } else {
          throw ErrorHandler.createValidationError(`Unknown tool: ${name}`);
        }

        // Log successful call to admin portal
        const responseTime = Date.now() - startTime;
        adminLogger.logToolCall({
          toolName: name,
          requestTime,
          responseTime,
          status: 'SUCCESS',
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const fhirError = ErrorHandler.handleUnknownError(error);
        ErrorHandler.logError(fhirError, `Tool: ${name}`);

        // Log failed call to admin portal
        const responseTime = Date.now() - startTime;
        adminLogger.logToolCall({
          toolName: name,
          requestTime,
          responseTime,
          status: 'ERROR',
          errorMessage: fhirError.message,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: fhirError.code,
                  message: fhirError.message,
                  details: fhirError.details,
                  timestamp: fhirError.timestamp,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error(
      `Veradigm FHIR MCP Server started (${config.nodeEnv} environment)`
    );
    console.error(`FHIR Base URL: ${config.fhirBaseUrl}`);
    console.error(`Available tools: 22 FHIR operations (21 read, 1 write: create_appointment)`);
  }
}

// Start the server
const server = new VeradigmFHIRMCPServer();
server.start().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
