import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { UnityActions } from "../config/unity-endpoints";
import { UnityService } from "../services/unity.service";
import { UnityErrorHandler, UnityMCPError } from "../utils/error-handler";
import { pick, unityRows } from "../utils/unity-rows";

/**
 * Unity Clinical Tools
 *
 * Provides MCP tools for retrieving clinical data via Unity API:
 * - GetPatientProblems: Get patient's active problems/conditions
 * - GetPatientMedications: Get patient's medications
 * - GetPatientAllergies: Get patient's allergies
 */
export class UnityClinicalTools {
  constructor(private unityService: UnityService) {}

  /**
   * Get patient's problems/conditions
   */
  async getPatientProblems(args: {
    patientId: string;
    status?: "active" | "inactive" | "all";
  }): Promise<{
    success: boolean;
    problems: any[];
    total: number;
    message: string;
  }> {
    try {
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError("Patient ID is required");
      }

      console.error(
        `[Unity Clinical] Getting problems for patient ${args.patientId}`,
      );

      const response = await this.unityService.executeAction<any>(
        UnityActions.Clinical.GET_PATIENT_PROBLEMS,
        {
          Parameter1: args.status || "active",
          Parameter2: "",
          Parameter3: "",
        },
        args.patientId,
        "EHR",
      );

      // A failed call is an error, never an empty problems list (CLAUDE.md rule 5).
      if (!response.success) {
        throw UnityErrorHandler.createAPIError(response.error || "Failed to get problems");
      }

      const problems = this.parseProblems(response.data);

      return {
        success: true,
        problems,
        total: problems.length,
        message: `Found ${problems.length} problem(s)`,
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, "GetPatientProblems");
    }
  }

  /**
   * Get patient's medications
   */
  async getPatientMedications(args: {
    patientId: string;
    status?: "active" | "all";
  }): Promise<{
    success: boolean;
    medications: any[];
    total: number;
    message: string;
  }> {
    try {
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError("Patient ID is required");
      }

      console.error(
        `[Unity Clinical] Getting medications for patient ${args.patientId}`,
      );

      const response = await this.unityService.executeAction<any>(
        UnityActions.Clinical.GET_PATIENT_MEDICATIONS,
        {
          // GetClinicalSummary takes the section name in Parameter1 (unverified until the EHR user is set)
          Parameter1:
            UnityActions.Clinical.GET_PATIENT_MEDICATIONS === "GetClinicalSummary"
              ? process.env.UNITY_MEDS_SECTION || "medications"
              : args.status || "active",
          Parameter2: "",
          Parameter3: "",
        },
        args.patientId,
        "EHR",
      );

      // A failed call is an error, never an empty medications list (CLAUDE.md rule 5).
      if (!response.success) {
        throw UnityErrorHandler.createAPIError(response.error || "Failed to get medications");
      }

      const medications = this.parseMedications(response.data);

      return {
        success: true,
        medications,
        total: medications.length,
        message: `Found ${medications.length} medication(s)`,
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(
        error,
        "GetPatientMedications",
      );
    }
  }

  /**
   * Get patient's allergies
   */
  async getPatientAllergies(args: { patientId: string }): Promise<{
    success: boolean;
    allergies: any[];
    total: number;
    message: string;
  }> {
    try {
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError("Patient ID is required");
      }

      console.error(
        `[Unity Clinical] Getting allergies for patient ${args.patientId}`,
      );

      const response = await this.unityService.executeAction<any>(
        UnityActions.Clinical.GET_PATIENT_ALLERGIES,
        {
          Parameter1: "",
          Parameter2: "",
          Parameter3: "",
        },
        args.patientId,
        "EHR",
      );

      // A failed call is an error, never an empty allergies list (CLAUDE.md rule 5).
      if (!response.success) {
        throw UnityErrorHandler.createAPIError(response.error || "Failed to get allergies");
      }

      const allergies = this.parseAllergies(response.data);

      return {
        success: true,
        allergies,
        total: allergies.length,
        message: `Found ${allergies.length} allergy(ies)`,
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, "GetPatientAllergies");
    }
  }

  /**
   * Get patient's diagnoses
   */
  async getPatientDiagnosis(args: {
    patientId: string;
    encounterId?: string;
  }): Promise<{
    success: boolean;
    diagnoses: any[];
    total: number;
    message: string;
  }> {
    try {
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError("Patient ID is required");
      }

      console.error(
        `[Unity Clinical] Getting diagnoses for patient ${args.patientId}`,
      );

      const response = await this.unityService.executeAction<any>(
        UnityActions.Clinical.GET_PATIENT_DIAGNOSIS,
        {
          Parameter1: args.encounterId || "",
          Parameter2: "",
          Parameter3: "",
        },
        args.patientId,
        "EHR",
      );

      // A failed call is an error, never an empty diagnoses list (CLAUDE.md rule 5).
      if (!response.success) {
        throw UnityErrorHandler.createAPIError(response.error || "Failed to get diagnoses");
      }

      const diagnoses = this.parseDiagnoses(response.data);

      return {
        success: true,
        diagnoses,
        total: diagnoses.length,
        message: `Found ${diagnoses.length} diagnosis(es)`,
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, "GetPatientDiagnosis");
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  // Parsers flatten Unity's [{ "<action>info": [rows] }] wrapper and read fields
  // case-insensitively, so they work with both the repo action names and the
  // Veradigm reference actions (GetProblems, GetAllergies, GetClinicalSummary).

  private parseProblems(data: any): any[] {
    return unityRows(data)
      .map((item) => ({
        id: pick(item, "ProblemID", "ID"),
        code: pick(item, "Code", "ICD10Code", "ICD9Code"),
        description: pick(item, "Description", "ProblemDescription", "Name", "DisplayName"),
        status: pick(item, "Status") || "active",
        onsetDate: pick(item, "OnsetDate", "StartDate"),
        resolvedDate: pick(item, "ResolvedDate", "EndDate"),
        severity: pick(item, "Severity"),
        type: pick(item, "Type", "ProblemType"),
      }))
      .filter((p) => p.id || p.code || p.description);
  }

  private parseMedications(data: any): any[] {
    return unityRows(data)
      // GetClinicalSummary returns every section; keep medication rows only when a section is labelled.
      .filter((item) => {
        const section = pick(item, "Section", "SectionName").toLowerCase();
        return !section || section.includes("med");
      })
      .map((item) => ({
        id: pick(item, "MedicationID", "ID", "TransID"),
        name: pick(item, "MedicationName", "DrugName", "Name", "Description", "DisplayName"),
        dose: pick(item, "Dose", "Dosage"),
        unit: pick(item, "Unit", "DoseUnit"),
        frequency: pick(item, "Frequency", "Sig"),
        route: pick(item, "Route"),
        status: pick(item, "Status") || "active",
        startDate: pick(item, "StartDate", "OrderDate"),
        endDate: pick(item, "EndDate", "StopDate"),
        prescriber: pick(item, "Prescriber", "OrderingProvider"),
        pharmacy: pick(item, "Pharmacy"),
        refillsRemaining: pick(item, "RefillsRemaining", "RefillsLeft"),
      }))
      .filter((m) => m.id || m.name);
  }

  private parseAllergies(data: any): any[] {
    return unityRows(data)
      .map((item) => ({
        id: pick(item, "AllergyID", "ID"),
        allergen: pick(item, "Allergen", "AllergyName", "Name", "Description", "DisplayName"),
        type: pick(item, "Type", "AllergyType"),
        severity: pick(item, "Severity"),
        reaction: pick(item, "Reaction", "ReactionDescription"),
        status: pick(item, "Status") || "active",
        onsetDate: pick(item, "OnsetDate"),
        source: pick(item, "Source", "ReportedBy"),
      }))
      .filter((a) => a.id || a.allergen);
  }

  private parseDiagnoses(data: any): any[] {
    return unityRows(data)
      .map((item) => ({
        id: pick(item, "DiagnosisID", "ID"),
        code: pick(item, "Code", "ICD10Code", "DiagnosisCode"),
        description: pick(item, "Description", "DiagnosisDescription"),
        type: pick(item, "Type", "DiagnosisType"),
        status: pick(item, "Status"),
        date: pick(item, "Date", "DiagnosisDate"),
        provider: pick(item, "Provider", "DiagnosingProvider"),
      }))
      .filter((d) => d.id || d.code || d.description);
  }

  /**
   * Get MCP tool definitions for clinical operations
   */
  getTools(): Tool[] {
    return [
      {
        name: "unity_get_patient_problems",
        description:
          "Get patient problems/conditions from Veradigm EHR via Unity API. Returns active health problems and conditions.",
        inputSchema: {
          type: "object",
          properties: {
            patientId: {
              type: "string",
              description: "Patient ID to retrieve problems for",
            },
            status: {
              type: "string",
              enum: ["active", "inactive", "all"],
              description: "Filter by problem status (default: active)",
              default: "active",
            },
          },
          required: ["patientId"],
        },
      },
      {
        name: "unity_get_patient_medications",
        description:
          "Get patient medications from Veradigm EHR via Unity API. Returns current prescriptions and medication list.",
        inputSchema: {
          type: "object",
          properties: {
            patientId: {
              type: "string",
              description: "Patient ID to retrieve medications for",
            },
            status: {
              type: "string",
              enum: ["active", "all"],
              description: "Filter by medication status (default: active)",
              default: "active",
            },
          },
          required: ["patientId"],
        },
      },
      {
        name: "unity_get_patient_allergies",
        description:
          "Get patient allergies from Veradigm EHR via Unity API. Returns documented allergies and adverse reactions.",
        inputSchema: {
          type: "object",
          properties: {
            patientId: {
              type: "string",
              description: "Patient ID to retrieve allergies for",
            },
          },
          required: ["patientId"],
        },
      },
      {
        name: "unity_get_patient_diagnosis",
        description:
          "Get patient diagnoses from Veradigm EHR via Unity API. Returns diagnosis codes and descriptions.",
        inputSchema: {
          type: "object",
          properties: {
            patientId: {
              type: "string",
              description: "Patient ID to retrieve diagnoses for",
            },
            encounterId: {
              type: "string",
              description: "Optional encounter ID to filter diagnoses",
            },
          },
          required: ["patientId"],
        },
      },
    ];
  }
}
