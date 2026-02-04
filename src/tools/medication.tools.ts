import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { FHIRService } from "../services/fhir.service";
import { ErrorHandler } from "../utils/error-handler";
import { FHIRParser, ParsedMedication } from "../utils/fhir-parser";

export class MedicationTools {
  constructor(private fhirService: FHIRService) {}

  /**
   * Get patient medications (active medication requests)
   */
  async getPatientMedications(args: {
    patientId: string;
    status?: string;
    intent?: string;
    limit?: number;
  }): Promise<{
    medications: ParsedMedication[];
    total: number;
    hasMore: boolean;
  }> {
    try {
      if (!args.patientId) {
        throw ErrorHandler.createValidationError("Patient ID is required");
      }

      const searchParams: Record<string, string> = {
        patient: args.patientId,
      };

      if (args.status) {
        searchParams.status = args.status;
      }
      if (args.intent) {
        searchParams.intent = args.intent;
      }

      const result = await this.fhirService.search(
        "MedicationRequest",
        searchParams,
        args.limit || 20
      );
      const medications = result.resources.map((medication) =>
        FHIRParser.parseMedicationRequest(medication)
      );

      return {
        medications,
        total: result.total,
        hasMore: result.hasMore,
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get medication requests for a patient
   */
  async getMedicationRequests(args: {
    patientId: string;
    status?: string;
    intent?: string;
    medication?: string;
    limit?: number;
  }): Promise<{
    requests: ParsedMedication[];
    total: number;
    hasMore: boolean;
  }> {
    try {
      if (!args.patientId) {
        throw ErrorHandler.createValidationError("Patient ID is required");
      }

      const searchParams: Record<string, string> = {
        patient: args.patientId,
      };

      if (args.status) {
        searchParams.status = args.status;
      }
      if (args.intent) {
        searchParams.intent = args.intent;
      }
      if (args.medication) {
        searchParams.medication = args.medication;
      }

      const result = await this.fhirService.search(
        "MedicationRequest",
        searchParams,
        args.limit || 20
      );
      const requests = result.resources.map((medication) =>
        FHIRParser.parseMedicationRequest(medication)
      );

      return {
        requests,
        total: result.total,
        hasMore: result.hasMore,
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Check refill status for medications (read-only indicator)
   */
  async checkRefillStatus(args: {
    patientId: string;
    medicationName?: string;
  }): Promise<{
    patientId: string;
    medications: Array<{
      medicationName: string;
      status: string;
      intent: string;
      authoredOn?: string;
      canRefill: boolean;
      refillInfo?: string;
    }>;
  }> {
    try {
      if (!args.patientId) {
        throw ErrorHandler.createValidationError("Patient ID is required");
      }

      const searchParams: Record<string, string> = {
        patient: args.patientId,
      };

      if (args.medicationName) {
        searchParams.medication = args.medicationName;
      }

      const result = await this.fhirService.search(
        "MedicationRequest",
        searchParams,
        50
      );
      const medications = result.resources.map((medication) =>
        FHIRParser.parseMedicationRequest(medication)
      );

      const medicationStatus = medications.map((med) => ({
        medicationName: med.medicationName,
        status: med.status,
        intent: med.intent,
        authoredOn: med.authoredOn,
        canRefill: this.canRefill(med),
        refillInfo: this.getRefillInfo(med),
      }));

      return {
        patientId: args.patientId,
        medications: medicationStatus,
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get medication statements (historical medication use)
   */
  async getMedicationStatements(args: {
    patientId: string;
    status?: string;
    limit?: number;
  }): Promise<{
    statements: Array<{
      id: string;
      patientId: string;
      medicationName: string;
      status: string;
      effectivePeriod?: {
        start?: string;
        end?: string;
      };
      dosage?: string;
      reason?: string;
    }>;
    total: number;
    hasMore: boolean;
  }> {
    try {
      if (!args.patientId) {
        throw ErrorHandler.createValidationError("Patient ID is required");
      }

      const searchParams: Record<string, string> = {
        patient: args.patientId,
      };

      if (args.status) {
        searchParams.status = args.status;
      }

      const result = await this.fhirService.search(
        "MedicationStatement",
        searchParams,
        args.limit || 20
      );

      const statements = result.resources.map((statement) => ({
        id: statement.id,
        patientId: statement.subject?.reference?.split("/")[1] || "",
        medicationName:
          statement.medicationCodeableConcept?.coding?.[0]?.display ||
          statement.medicationReference?.display ||
          "Unknown",
        status: statement.status,
        effectivePeriod: {
          start: statement.effectivePeriod?.start,
          end: statement.effectivePeriod?.end,
        },
        dosage: statement.dosage?.[0]?.text,
        reason: statement.reasonCode?.[0]?.coding?.[0]?.display,
      }));

      return {
        statements,
        total: result.total,
        hasMore: result.hasMore,
      };
    } catch (error: any) {
      // Check if it's a permission or resource availability issue
      if (
        error.message &&
        (error.message.includes("Internal server error") ||
          error.message.includes("not supported") ||
          error.message.includes("not available"))
      ) {
        throw ErrorHandler.createValidationError(
          "MedicationStatement resource is not available or not supported by the FHIR API. This may be a limitation of your API tier. You can use get_patient_medications or get_medication_requests instead."
        );
      }
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Determine if a medication can be refilled based on status and intent
   */
  private canRefill(medication: ParsedMedication): boolean {
    // Active medications with 'order' intent can typically be refilled
    return medication.status === "active" && medication.intent === "order";
  }

  /**
   * Get refill information for a medication
   */
  private getRefillInfo(medication: ParsedMedication): string {
    if (medication.status === "active" && medication.intent === "order") {
      return "Eligible for refill";
    } else if (medication.status === "completed") {
      return "Completed - may need new prescription";
    } else if (medication.status === "cancelled") {
      return "Cancelled - cannot refill";
    } else if (medication.status === "entered-in-error") {
      return "Error in record - contact provider";
    } else {
      return "Status unclear - contact provider";
    }
  }

  /**
   * Get MCP tool definitions for medication operations
   */
  getTools(): Tool[] {
    return [
      {
        name: "get_patient_medications",
        description: "Get active medications for a patient",
        inputSchema: {
          type: "object",
          properties: {
            patientId: {
              type: "string",
              description: "FHIR Patient resource ID",
            },
            status: {
              type: "string",
              enum: [
                "draft",
                "active",
                "on-hold",
                "revoked",
                "completed",
                "entered-in-error",
                "unknown",
              ],
              description: "Medication request status to filter by",
            },
            intent: {
              type: "string",
              enum: [
                "proposal",
                "plan",
                "order",
                "original-order",
                "reflex-order",
                "filler-order",
                "instance-order",
                "option",
              ],
              description: "Medication request intent to filter by",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 20)",
              default: 20,
            },
          },
          required: ["patientId"],
        },
      },
      {
        name: "get_medication_requests",
        description:
          "Get medication requests for a patient with optional filtering",
        inputSchema: {
          type: "object",
          properties: {
            patientId: {
              type: "string",
              description: "FHIR Patient resource ID",
            },
            status: {
              type: "string",
              enum: [
                "draft",
                "active",
                "on-hold",
                "revoked",
                "completed",
                "entered-in-error",
                "unknown",
              ],
              description: "Medication request status to filter by",
            },
            intent: {
              type: "string",
              enum: [
                "proposal",
                "plan",
                "order",
                "original-order",
                "reflex-order",
                "filler-order",
                "instance-order",
                "option",
              ],
              description: "Medication request intent to filter by",
            },
            medication: {
              type: "string",
              description: "Medication name or code to filter by",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 20)",
              default: 20,
            },
          },
          required: ["patientId"],
        },
      },
      {
        name: "check_refill_status",
        description:
          "Check refill status for patient medications (read-only indicator)",
        inputSchema: {
          type: "object",
          properties: {
            patientId: {
              type: "string",
              description: "FHIR Patient resource ID",
            },
            medicationName: {
              type: "string",
              description: "Specific medication name to check (optional)",
            },
          },
          required: ["patientId"],
        },
      },
      {
        name: "get_medication_statements",
        description:
          "Get medication statements (historical medication use) for a patient",
        inputSchema: {
          type: "object",
          properties: {
            patientId: {
              type: "string",
              description: "FHIR Patient resource ID",
            },
            status: {
              type: "string",
              enum: [
                "active",
                "completed",
                "entered-in-error",
                "intended",
                "stopped",
                "on-hold",
                "unknown",
                "not-taken",
              ],
              description: "Medication statement status to filter by",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 20)",
              default: 20,
            },
          },
          required: ["patientId"],
        },
      },
    ];
  }
}
