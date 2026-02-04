import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { UnityActions } from "../config/unity-endpoints";
import { UnityService } from "../services/unity.service";
import { UnityErrorHandler, UnityMCPError } from "../utils/error-handler";

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

      if (!response.success) {
        return {
          success: false,
          problems: [],
          total: 0,
          message: response.error || "Failed to get problems",
        };
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
          Parameter1: args.status || "active",
          Parameter2: "",
          Parameter3: "",
        },
        args.patientId,
        "EHR",
      );

      if (!response.success) {
        return {
          success: false,
          medications: [],
          total: 0,
          message: response.error || "Failed to get medications",
        };
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

      if (!response.success) {
        return {
          success: false,
          allergies: [],
          total: 0,
          message: response.error || "Failed to get allergies",
        };
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

      if (!response.success) {
        return {
          success: false,
          diagnoses: [],
          total: 0,
          message: response.error || "Failed to get diagnoses",
        };
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

  private parseProblems(data: any): any[] {
    if (!data) return [];

    // Handle various Unity response formats
    const problems = data.getpatientproblemsinfo || data.problems || data;
    if (!problems) return [];

    const items = Array.isArray(problems) ? problems : [problems];

    return items
      .map((item: any) => ({
        id: item.ProblemID || item.ID,
        code: item.Code || item.ICD10Code || item.ICD9Code,
        description: item.Description || item.ProblemDescription || item.Name,
        status: item.Status || "active",
        onsetDate: item.OnsetDate || item.StartDate,
        resolvedDate: item.ResolvedDate || item.EndDate,
        severity: item.Severity,
        type: item.Type || item.ProblemType,
      }))
      .filter((p: any) => p.id || p.code || p.description);
  }

  private parseMedications(data: any): any[] {
    if (!data) return [];

    const medications =
      data.getpatientmedicationsinfo || data.medications || data;
    if (!medications) return [];

    const items = Array.isArray(medications) ? medications : [medications];

    return items
      .map((item: any) => ({
        id: item.MedicationID || item.ID,
        name: item.MedicationName || item.DrugName || item.Name,
        dose: item.Dose || item.Dosage,
        unit: item.Unit || item.DoseUnit,
        frequency: item.Frequency || item.Sig,
        route: item.Route,
        status: item.Status || "active",
        startDate: item.StartDate || item.OrderDate,
        endDate: item.EndDate || item.StopDate,
        prescriber: item.Prescriber || item.OrderingProvider,
        pharmacy: item.Pharmacy,
        refillsRemaining: item.RefillsRemaining || item.RefillsLeft,
      }))
      .filter((m: any) => m.id || m.name);
  }

  private parseAllergies(data: any): any[] {
    if (!data) return [];

    const allergies = data.getpatientallergiesinfo || data.allergies || data;
    if (!allergies) return [];

    const items = Array.isArray(allergies) ? allergies : [allergies];

    return items
      .map((item: any) => ({
        id: item.AllergyID || item.ID,
        allergen: item.Allergen || item.AllergyName || item.Name,
        type: item.Type || item.AllergyType,
        severity: item.Severity,
        reaction: item.Reaction || item.ReactionDescription,
        status: item.Status || "active",
        onsetDate: item.OnsetDate,
        source: item.Source || item.ReportedBy,
      }))
      .filter((a: any) => a.id || a.allergen);
  }

  private parseDiagnoses(data: any): any[] {
    if (!data) return [];

    const diagnoses = data.getpatientdiagnosisinfo || data.diagnoses || data;
    if (!diagnoses) return [];

    const items = Array.isArray(diagnoses) ? diagnoses : [diagnoses];

    return items
      .map((item: any) => ({
        id: item.DiagnosisID || item.ID,
        code: item.Code || item.ICD10Code || item.DiagnosisCode,
        description: item.Description || item.DiagnosisDescription,
        type: item.Type || item.DiagnosisType,
        status: item.Status,
        date: item.Date || item.DiagnosisDate,
        provider: item.Provider || item.DiagnosingProvider,
      }))
      .filter((d: any) => d.id || d.code || d.description);
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
