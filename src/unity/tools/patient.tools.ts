import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { UnityActions, UnityTargetSystem } from "../config/unity-endpoints";
import { UnityService } from "../services/unity.service";
import { UnityErrorHandler, UnityMCPError } from "../utils/error-handler";

/**
 * Patient Demographics Data Structure
 */
export interface PatientDemographics {
  // Required fields
  firstName: string;
  lastName: string;

  // Optional core fields
  middleName?: string;
  dateOfBirth?: string; // Format: MM/DD/YYYY
  gender?: "M" | "F" | "U"; // Male, Female, Unknown
  ssn?: string;
  mrn?: string; // Medical Record Number

  // Contact information
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  homePhone?: string;
  workPhone?: string;
  cellPhone?: string;
  email?: string;

  // Additional demographics
  race?: string;
  ethnicity?: string;
  language?: string;
  maritalStatus?: string;

  // Emergency contact
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;

  // Insurance/Guarantor
  guarantorId?: string;
  primaryInsuranceId?: string;
}

/**
 * Patient Update Fields
 */
export interface PatientUpdateData {
  patientId: string;

  // Demographic fields that can be updated
  ethnicity?: string;
  race?: string;
  language?: string;

  // Contact updates
  homePhone?: string;
  workPhone?: string;
  cellPhone?: string;
  email?: string;

  // Address updates
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}

/**
 * Parsed Patient Result
 */
export interface ParsedPatient {
  id: string;
  mrn?: string;
  firstName: string;
  lastName: string;
  middleName?: string;
  dateOfBirth?: string;
  gender?: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
  };
  phone?: {
    home?: string;
    work?: string;
    cell?: string;
  };
  email?: string;
  race?: string;
  ethnicity?: string;
  language?: string;
  maritalStatus?: string;
}

/**
 * Unity Patient Tools
 *
 * Provides MCP tools for patient write operations via Unity API:
 * - SavePatient: Create or update patient demographics
 * - UpdateDemographics: Update specific demographic fields
 * - GetPatient: Retrieve patient information
 */
export class UnityPatientTools {
  constructor(private unityService: UnityService) {}

  /**
   * Save (create or update) patient demographics
   */
  async savePatient(args: PatientDemographics): Promise<{
    success: boolean;
    patientId?: string;
    mrn?: string;
    message: string;
    patient?: ParsedPatient;
  }> {
    try {
      // Validate required fields
      if (!args.firstName) {
        throw UnityErrorHandler.createValidationError("First name is required");
      }
      if (!args.lastName) {
        throw UnityErrorHandler.createValidationError("Last name is required");
      }

      console.error(
        `[Unity Patient] Saving patient: ${args.firstName} ${args.lastName}`,
      );

      // Build patient XML for Unity SavePatient action
      const patientXml = this.buildPatientXml(args);

      // Execute SavePatient action
      // Patient demographics typically go to Practice Management
      const response = await this.unityService.executeAction<any>(
        UnityActions.Patient.SAVE_PATIENT,
        {
          Parameter1: patientXml,
          Parameter2: "", // Additional options
          Parameter3: "", // Organization (if applicable)
        },
        "", // No patient ID for new patients
        "PM",
      );

      if (!response.success) {
        throw UnityErrorHandler.createAPIError(
          response.error || "Failed to save patient",
          "SavePatient",
        );
      }

      // Parse the response
      const patientId = this.extractPatientId(response.data);
      const mrn = this.extractMRN(response.data);
      const patient = this.parsePatientResponse(response.data, args);

      return {
        success: true,
        patientId,
        mrn,
        message: patientId
          ? "Patient updated successfully"
          : "Patient created successfully",
        patient,
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, "SavePatient");
    }
  }

  /**
   * Update specific patient demographics
   *
   * This is useful for updating fields like ethnicity, race, and language
   * without modifying other patient data
   */
  async updateDemographics(args: PatientUpdateData): Promise<{
    success: boolean;
    patientId: string;
    message: string;
    updatedFields: string[];
  }> {
    try {
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError("Patient ID is required");
      }

      console.error(
        `[Unity Patient] Updating demographics for patient ${args.patientId}`,
      );

      // Build update XML based on provided fields
      const updateXml = this.buildDemographicsUpdateXml(args);
      const updatedFields = this.getUpdatedFieldNames(args);

      if (updatedFields.length === 0) {
        return {
          success: true,
          patientId: args.patientId,
          message: "No fields to update",
          updatedFields: [],
        };
      }

      // Execute UpdateDemographics action
      const response = await this.unityService.executeAction<any>(
        UnityActions.Patient.UPDATE_DEMOGRAPHICS,
        {
          Parameter1: updateXml,
        },
        args.patientId,
        "PM",
      );

      if (!response.success) {
        throw UnityErrorHandler.createAPIError(
          response.error || "Failed to update demographics",
          "UpdateDemographics",
        );
      }

      return {
        success: true,
        patientId: args.patientId,
        message: "Demographics updated successfully",
        updatedFields,
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, "UpdateDemographics");
    }
  }

  /**
   * Get patient by ID
   */
  async getPatient(args: {
    patientId: string;
    includePicture?: boolean;
    target?: UnityTargetSystem;
  }): Promise<{
    success: boolean;
    patient?: ParsedPatient;
    message: string;
  }> {
    try {
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError("Patient ID is required");
      }

      console.error(`[Unity Patient] Getting patient ${args.patientId}`);

      const response = await this.unityService.getPatient(
        args.patientId,
        args.includePicture || false,
        args.target || "EHR",
      );

      if (!response.success) {
        return {
          success: false,
          message: response.error || "Patient not found",
        };
      }

      const patient = this.parsePatientFromUnity(response.data);

      if (this.isEmptyPatient(patient)) {
        return {
          success: false,
          message:
            "No patient details returned for this ID. The record may not exist or the system returned empty data. Try searching by full name and date of birth (MM/DD/YYYY), or by MRN using unity_get_patient_by_mrn.",
        };
      }

      return {
        success: true,
        patient,
        message: "Patient retrieved successfully",
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, "GetPatient");
    }
  }

  /**
   * Search for patients
   */
  async searchPatients(args: {
    lastName?: string;
    firstName?: string;
    dateOfBirth?: string;
    mrn?: string;
    limit?: number;
  }): Promise<{
    patients: ParsedPatient[];
    total: number;
    message: string;
  }> {
    try {
      // At least one search criterion is required
      if (!args.lastName && !args.firstName && !args.dateOfBirth && !args.mrn) {
        throw UnityErrorHandler.createValidationError(
          "At least one search criterion is required (lastName, firstName, dateOfBirth, or mrn)",
        );
      }

      console.error(`[Unity Patient] Searching patients`);

      const response = await this.unityService.searchPatients({
        lastName: args.lastName,
        firstName: args.firstName,
        dob: args.dateOfBirth,
        mrn: args.mrn,
      });

      if (!response.success) {
        return {
          patients: [],
          total: 0,
          message: response.error || "Search failed",
        };
      }

      const patients = this.parsePatientsList(response.data);

      // Apply limit if specified
      const limitedPatients = args.limit
        ? patients.slice(0, args.limit)
        : patients;

      return {
        patients: limitedPatients,
        total: patients.length,
        message: `Found ${patients.length} patient(s)`,
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, "SearchPatients");
    }
  }

  /**
   * Get patient by MRN
   */
  async getPatientByMRN(args: {
    mrn: string;
    organization?: string;
    target?: UnityTargetSystem;
  }): Promise<{
    success: boolean;
    patient?: ParsedPatient;
    message: string;
  }> {
    try {
      if (!args.mrn) {
        throw UnityErrorHandler.createValidationError("MRN is required");
      }

      console.error(`[Unity Patient] Getting patient by MRN: ${args.mrn}`);

      const response = await this.unityService.executeAction<any>(
        UnityActions.Patient.GET_PATIENT_BY_MRN,
        {
          Parameter1: args.mrn,
          Parameter2: args.organization || "",
        },
        "",
        args.target || "EHR",
      );

      if (!response.success) {
        return {
          success: false,
          message: response.error || "Patient not found",
        };
      }

      let patient = this.parsePatientFromUnity(response.data);

      // GetPatientByMRN often returns a different response shape; if we have no usable details, get via search by MRN
      const hasUsableDetails =
        patient.id && (patient.firstName || patient.lastName);
      if (!hasUsableDetails) {
        try {
          const searchResult = await this.searchPatients({
            mrn: args.mrn,
            limit: 100,
          });
          const normalizedMrn = String(args.mrn || "").trim();
          const match = searchResult.patients.find(
            (p) => String(p.mrn || "").trim() === normalizedMrn
          );
          if (match) {
            console.error(
              `[Unity Patient] GetPatientByMRN returned no details; using search result for MRN ${args.mrn}`,
            );
            patient = match;
          }
        } catch (searchErr) {
          console.error(
            `[Unity Patient] Fallback search by MRN failed:`,
            searchErr,
          );
        }
      }

      if (this.isEmptyPatient(patient)) {
        return {
          success: false,
          message:
            `No patient found for MRN "${args.mrn}". Try searching by full name and date of birth (MM/DD/YYYY) using unity_search_patients.`,
        };
      }

      return {
        success: true,
        patient,
        message: "Patient retrieved successfully",
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, "GetPatientByMRN");
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * True when the parsed patient has no usable identifiers or name (treat as "not found").
   */
  private isEmptyPatient(p: ParsedPatient): boolean {
    const hasId = Boolean(p.id && String(p.id).trim());
    const hasName = Boolean(
      (p.firstName && String(p.firstName).trim()) ||
        (p.lastName && String(p.lastName).trim()),
    );
    const hasMrn = Boolean(p.mrn && String(p.mrn).trim());
    return !hasId && !hasName && !hasMrn;
  }

  /**
   * Build patient XML for SavePatient
   */
  private buildPatientXml(data: PatientDemographics): string {
    let xml = "<patient>";

    // Required fields
    xml += `<FirstName>${this.escapeXml(data.firstName)}</FirstName>`;
    xml += `<LastName>${this.escapeXml(data.lastName)}</LastName>`;

    // Optional core fields
    if (data.middleName) {
      xml += `<MiddleName>${this.escapeXml(data.middleName)}</MiddleName>`;
    }
    if (data.dateOfBirth) {
      xml += `<DOB>${this.escapeXml(data.dateOfBirth)}</DOB>`;
    }
    if (data.gender) {
      xml += `<Gender>${this.escapeXml(data.gender)}</Gender>`;
    }
    if (data.ssn) {
      xml += `<SSN>${this.escapeXml(data.ssn)}</SSN>`;
    }
    if (data.mrn) {
      xml += `<MRN>${this.escapeXml(data.mrn)}</MRN>`;
    }

    // Address
    if (data.address1) {
      xml += `<Address1>${this.escapeXml(data.address1)}</Address1>`;
    }
    if (data.address2) {
      xml += `<Address2>${this.escapeXml(data.address2)}</Address2>`;
    }
    if (data.city) {
      xml += `<City>${this.escapeXml(data.city)}</City>`;
    }
    if (data.state) {
      xml += `<State>${this.escapeXml(data.state)}</State>`;
    }
    if (data.zipCode) {
      xml += `<ZipCode>${this.escapeXml(data.zipCode)}</ZipCode>`;
    }
    if (data.country) {
      xml += `<Country>${this.escapeXml(data.country)}</Country>`;
    }

    // Contact
    if (data.homePhone) {
      xml += `<HomePhone>${this.escapeXml(data.homePhone)}</HomePhone>`;
    }
    if (data.workPhone) {
      xml += `<WorkPhone>${this.escapeXml(data.workPhone)}</WorkPhone>`;
    }
    if (data.cellPhone) {
      xml += `<CellPhone>${this.escapeXml(data.cellPhone)}</CellPhone>`;
    }
    if (data.email) {
      xml += `<Email>${this.escapeXml(data.email)}</Email>`;
    }

    // Demographics
    if (data.race) {
      xml += `<Race>${this.escapeXml(data.race)}</Race>`;
    }
    if (data.ethnicity) {
      xml += `<Ethnicity>${this.escapeXml(data.ethnicity)}</Ethnicity>`;
    }
    if (data.language) {
      xml += `<Language>${this.escapeXml(data.language)}</Language>`;
    }
    if (data.maritalStatus) {
      xml += `<MaritalStatus>${this.escapeXml(data.maritalStatus)}</MaritalStatus>`;
    }

    // Emergency contact
    if (data.emergencyContactName) {
      xml += `<EmergencyContactName>${this.escapeXml(data.emergencyContactName)}</EmergencyContactName>`;
    }
    if (data.emergencyContactPhone) {
      xml += `<EmergencyContactPhone>${this.escapeXml(data.emergencyContactPhone)}</EmergencyContactPhone>`;
    }
    if (data.emergencyContactRelation) {
      xml += `<EmergencyContactRelation>${this.escapeXml(data.emergencyContactRelation)}</EmergencyContactRelation>`;
    }

    xml += "</patient>";
    return xml;
  }

  /**
   * Build demographics update XML
   */
  private buildDemographicsUpdateXml(data: PatientUpdateData): string {
    let xml = "<demographics>";

    if (data.ethnicity) {
      xml += `<Ethnicity>${this.escapeXml(data.ethnicity)}</Ethnicity>`;
    }
    if (data.race) {
      xml += `<Race>${this.escapeXml(data.race)}</Race>`;
    }
    if (data.language) {
      xml += `<Language>${this.escapeXml(data.language)}</Language>`;
    }
    if (data.homePhone) {
      xml += `<HomePhone>${this.escapeXml(data.homePhone)}</HomePhone>`;
    }
    if (data.workPhone) {
      xml += `<WorkPhone>${this.escapeXml(data.workPhone)}</WorkPhone>`;
    }
    if (data.cellPhone) {
      xml += `<CellPhone>${this.escapeXml(data.cellPhone)}</CellPhone>`;
    }
    if (data.email) {
      xml += `<Email>${this.escapeXml(data.email)}</Email>`;
    }
    if (data.address1) {
      xml += `<Address1>${this.escapeXml(data.address1)}</Address1>`;
    }
    if (data.address2) {
      xml += `<Address2>${this.escapeXml(data.address2)}</Address2>`;
    }
    if (data.city) {
      xml += `<City>${this.escapeXml(data.city)}</City>`;
    }
    if (data.state) {
      xml += `<State>${this.escapeXml(data.state)}</State>`;
    }
    if (data.zipCode) {
      xml += `<ZipCode>${this.escapeXml(data.zipCode)}</ZipCode>`;
    }

    xml += "</demographics>";
    return xml;
  }

  /**
   * Get list of field names being updated
   */
  private getUpdatedFieldNames(data: PatientUpdateData): string[] {
    const fields: string[] = [];

    if (data.ethnicity) fields.push("ethnicity");
    if (data.race) fields.push("race");
    if (data.language) fields.push("language");
    if (data.homePhone) fields.push("homePhone");
    if (data.workPhone) fields.push("workPhone");
    if (data.cellPhone) fields.push("cellPhone");
    if (data.email) fields.push("email");
    if (data.address1) fields.push("address1");
    if (data.address2) fields.push("address2");
    if (data.city) fields.push("city");
    if (data.state) fields.push("state");
    if (data.zipCode) fields.push("zipCode");

    return fields;
  }

  /**
   * Extract patient ID from response
   */
  private extractPatientId(data: any): string {
    if (!data) return "";
    return data.PatientID || data.patientid || data.ID || data.id || "";
  }

  /**
   * Extract MRN from response
   */
  private extractMRN(data: any): string {
    if (!data) return "";
    return data.MRN || data.mrn || data.EnterpriseMRN || "";
  }

  /**
   * Parse patient response into structured format
   */
  private parsePatientResponse(
    data: any,
    original: PatientDemographics,
  ): ParsedPatient {
    return {
      id: this.extractPatientId(data),
      mrn: this.extractMRN(data) || original.mrn,
      firstName: data?.FirstName || original.firstName,
      lastName: data?.LastName || original.lastName,
      middleName: data?.MiddleName || original.middleName,
      dateOfBirth: data?.DOB || original.dateOfBirth,
      gender: data?.Gender || original.gender,
      address: {
        line1: data?.Address1 || original.address1,
        line2: data?.Address2 || original.address2,
        city: data?.City || original.city,
        state: data?.State || original.state,
        zipCode: data?.ZipCode || original.zipCode,
        country: data?.Country || original.country,
      },
      phone: {
        home: data?.HomePhone || original.homePhone,
        work: data?.WorkPhone || original.workPhone,
        cell: data?.CellPhone || original.cellPhone,
      },
      email: data?.Email || original.email,
      race: data?.Race || original.race,
      ethnicity: data?.Ethnicity || original.ethnicity,
      language: data?.Language || original.language,
      maritalStatus: data?.MaritalStatus || original.maritalStatus,
    };
  }

  /**
   * Parse patient from Unity response
   *
   * Unity uses various field naming conventions:
   * - PascalCase: PatientID, FirstName
   * - lowercase: patientid, firstname
   * - Mixed: Patientid, patientID
   */
  private parsePatientFromUnity(data: any): ParsedPatient {
    if (!data) {
      return {
        id: "",
        firstName: "",
        lastName: "",
      };
    }

    // Helper to find a value with case-insensitive key matching
    const getValue = (obj: any, ...keys: string[]): string | undefined => {
      for (const key of keys) {
        // Try exact match first
        if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
          return String(obj[key]);
        }
        // Try case-insensitive match
        const lowerKey = key.toLowerCase();
        const foundKey = Object.keys(obj).find(
          (k) => k.toLowerCase() === lowerKey,
        );
        if (
          foundKey &&
          obj[foundKey] !== undefined &&
          obj[foundKey] !== null &&
          obj[foundKey] !== ""
        ) {
          return String(obj[foundKey]);
        }
      }
      return undefined;
    };

    const patient: ParsedPatient = {
      id:
        getValue(data, "PatientID", "ID", "patientid", "id", "PID", "PatID") ||
        "",
      mrn: getValue(
        data,
        "MRN",
        "mrn",
        "EnterpriseMRN",
        "MedicalRecordNumber",
        "ChartNumber",
      ),
      firstName:
        getValue(
          data,
          "FirstName",
          "firstname",
          "First",
          "FName",
          "first_name",
        ) || "",
      lastName:
        getValue(data, "LastName", "lastname", "Last", "LName", "last_name") ||
        "",
      middleName: getValue(data, "MiddleName", "middlename", "Middle", "MName"),
      dateOfBirth: getValue(
        data,
        "DOB",
        "dob",
        "DateOfBirth",
        "BirthDate",
        "Birthday",
        "birthdate",
      ),
      gender: getValue(data, "Gender", "gender", "Sex", "sex"),
      address: {
        line1: getValue(
          data,
          "Address1",
          "address1",
          "AddressLine1",
          "Street",
          "StreetAddress",
        ),
        line2: getValue(data, "Address2", "address2", "AddressLine2"),
        city: getValue(data, "City", "city"),
        state: getValue(data, "State", "state", "ST"),
        zipCode: getValue(
          data,
          "ZipCode",
          "zipcode",
          "Zip",
          "PostalCode",
          "zip",
        ),
        country: getValue(data, "Country", "country"),
      },
      phone: {
        home: getValue(
          data,
          "HomePhone",
          "homephone",
          "Phone",
          "phone",
          "PhoneNumber",
        ),
        work: getValue(data, "WorkPhone", "workphone", "BusinessPhone"),
        cell: getValue(
          data,
          "CellPhone",
          "cellphone",
          "MobilePhone",
          "Mobile",
          "Cell",
        ),
      },
      email: getValue(data, "Email", "email", "EmailAddress", "EMail"),
      race: getValue(data, "Race", "race"),
      ethnicity: getValue(data, "Ethnicity", "ethnicity"),
      language: getValue(data, "Language", "language", "PreferredLanguage"),
      maritalStatus: getValue(
        data,
        "MaritalStatus",
        "maritalstatus",
        "Marital",
      ),
    };

    // Debug log
    console.error(
      `[Unity Patient] Parsed patient: ID=${patient.id}, Name=${patient.firstName} ${patient.lastName}`,
    );

    return patient;
  }

  /**
   * Parse list of patients
   *
   * Unity returns patient data in various nested formats:
   * - Array with { searchpatientsinfo: [...] }
   * - Direct array of patients
   * - { Table: [...] }
   */
  private parsePatientsList(data: any): ParsedPatient[] {
    if (!data) return [];

    // Debug: Log raw data structure
    console.error(
      "[Unity Patient] Raw search response:",
      JSON.stringify(data, null, 2),
    );

    let patients: any[] = [];

    // Handle array response (most common from Unity)
    if (Array.isArray(data)) {
      // Check if first element has nested patient data
      if (data.length > 0 && data[0]) {
        const firstItem = data[0];

        // Unity format: [{ searchpatientsinfo: [...] }]
        if (firstItem.searchpatientsinfo) {
          patients = firstItem.searchpatientsinfo;
        }
        // Unity format: [{ getpatientlistinfo: [...] }]
        else if (firstItem.getpatientlistinfo) {
          patients = firstItem.getpatientlistinfo;
        }
        // Unity format: [{ patientlistinfo: [...] }]
        else if (firstItem.patientlistinfo) {
          patients = firstItem.patientlistinfo;
        }
        // Direct patient objects in array
        else if (
          firstItem.PatientID ||
          firstItem.ID ||
          firstItem.FirstName ||
          firstItem.lastname
        ) {
          patients = data;
        }
        // Check for any key ending in 'info' that contains an array
        else {
          const infoKey = Object.keys(firstItem).find((k) =>
            k.toLowerCase().endsWith("info"),
          );
          if (infoKey && Array.isArray(firstItem[infoKey])) {
            patients = firstItem[infoKey];
          } else {
            patients = data;
          }
        }
      }
    }
    // Handle object response
    else if (typeof data === "object") {
      if (data.searchpatientsinfo) {
        patients = Array.isArray(data.searchpatientsinfo)
          ? data.searchpatientsinfo
          : [data.searchpatientsinfo];
      } else if (data.Table) {
        patients = Array.isArray(data.Table) ? data.Table : [data.Table];
      } else if (data.Results) {
        patients = Array.isArray(data.Results) ? data.Results : [data.Results];
      } else {
        // Check for any key ending in 'info'
        const infoKey = Object.keys(data).find((k) =>
          k.toLowerCase().endsWith("info"),
        );
        if (infoKey) {
          patients = Array.isArray(data[infoKey])
            ? data[infoKey]
            : [data[infoKey]];
        } else {
          patients = [data];
        }
      }
    }

    console.error(
      `[Unity Patient] Found ${patients.length} patient records to parse`,
    );

    return patients
      .map((item) => this.parsePatientFromUnity(item))
      .filter((p) => p.id || p.firstName || p.lastName);
  }

  /**
   * Escape XML special characters
   */
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /**
   * Get MCP tool definitions for patient operations
   */
  getTools(): Tool[] {
    return [
      {
        name: "unity_save_patient",
        description:
          "Create or update patient demographics in Veradigm Practice Management via Unity API",
        inputSchema: {
          type: "object",
          properties: {
            firstName: {
              type: "string",
              description: "Patient first name (required)",
            },
            lastName: {
              type: "string",
              description: "Patient last name (required)",
            },
            middleName: {
              type: "string",
              description: "Patient middle name",
            },
            dateOfBirth: {
              type: "string",
              description: "Date of birth in MM/DD/YYYY format",
            },
            gender: {
              type: "string",
              enum: ["M", "F", "U"],
              description: "Gender (M=Male, F=Female, U=Unknown)",
            },
            ssn: {
              type: "string",
              description: "Social Security Number",
            },
            mrn: {
              type: "string",
              description: "Medical Record Number",
            },
            address1: {
              type: "string",
              description: "Address line 1",
            },
            address2: {
              type: "string",
              description: "Address line 2",
            },
            city: {
              type: "string",
              description: "City",
            },
            state: {
              type: "string",
              description: "State (2-letter code)",
            },
            zipCode: {
              type: "string",
              description: "ZIP code",
            },
            homePhone: {
              type: "string",
              description: "Home phone number",
            },
            cellPhone: {
              type: "string",
              description: "Cell phone number",
            },
            email: {
              type: "string",
              description: "Email address",
            },
            race: {
              type: "string",
              description: "Race",
            },
            ethnicity: {
              type: "string",
              description: "Ethnicity",
            },
            language: {
              type: "string",
              description: "Preferred language",
            },
          },
          required: ["firstName", "lastName"],
        },
      },
      {
        name: "unity_update_demographics",
        description:
          "Update specific patient demographic fields in Veradigm via Unity API",
        inputSchema: {
          type: "object",
          properties: {
            patientId: {
              type: "string",
              description: "Patient ID to update (required)",
            },
            ethnicity: {
              type: "string",
              description: "Updated ethnicity",
            },
            race: {
              type: "string",
              description: "Updated race",
            },
            language: {
              type: "string",
              description: "Updated preferred language",
            },
            homePhone: {
              type: "string",
              description: "Updated home phone",
            },
            cellPhone: {
              type: "string",
              description: "Updated cell phone",
            },
            email: {
              type: "string",
              description: "Updated email address",
            },
            address1: {
              type: "string",
              description: "Updated address line 1",
            },
            city: {
              type: "string",
              description: "Updated city",
            },
            state: {
              type: "string",
              description: "Updated state",
            },
            zipCode: {
              type: "string",
              description: "Updated ZIP code",
            },
          },
          required: ["patientId"],
        },
      },
      {
        name: "unity_get_patient",
        description: "Get patient information from Veradigm via Unity API",
        inputSchema: {
          type: "object",
          properties: {
            patientId: {
              type: "string",
              description: "Patient ID to retrieve",
            },
            includePicture: {
              type: "boolean",
              description: "Include patient photo if available",
              default: false,
            },
          },
          required: ["patientId"],
        },
      },
      {
        name: "unity_search_patients",
        description: "Search for patients in Veradigm via Unity API",
        inputSchema: {
          type: "object",
          properties: {
            lastName: {
              type: "string",
              description: "Patient last name to search",
            },
            firstName: {
              type: "string",
              description: "Patient first name to search",
            },
            dateOfBirth: {
              type: "string",
              description: "Date of birth in MM/DD/YYYY format",
            },
            mrn: {
              type: "string",
              description: "Medical Record Number to search",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return",
              default: 100,
            },
          },
        },
      },
      {
        name: "unity_get_patient_by_mrn",
        description:
          "Get patient by Medical Record Number from Veradigm via Unity API",
        inputSchema: {
          type: "object",
          properties: {
            mrn: {
              type: "string",
              description: "Medical Record Number",
            },
            organization: {
              type: "string",
              description: "Organization identifier (optional)",
            },
          },
          required: ["mrn"],
        },
      },
    ];
  }
}
