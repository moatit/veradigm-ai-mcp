import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { UnityActions, UnityTargetSystem } from "../config/unity-endpoints";
import { UnityService } from "../services/unity.service";
import { UnityErrorHandler, UnityMCPError } from "../utils/error-handler";
import { errorSummary } from "../../utils/safe-log";

/**
 * Parsed Patient Result
 */
export interface ParsedPatient {
  id: string;
  mrn?: string;
  /** Veradigm® PM MRN and Veradigm® EHR chart MRN (= the PM patient number). Outside documents may carry either. */
  pmMrn?: string;
  chartMrn?: string;
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
  /** Search only: Veradigm® PM patient ID (appointments, balance, insurance). */
  patientId?: string;
  /** Search only: Veradigm® EHR patient ID (medications, allergies, problems, staff tasks). */
  chartPatientId?: string;
  /**
   * Last 4 digits of the SSN, when Veradigm® returns one and doesn't flag it hidden. Never the full SSN.
   * For document matching only: stripped before any result reaches the phone agent.
   */
  ssnLast4?: string;
}

/** MM/DD/YYYY with zero padding ("3/5/1979" → "03/05/1979"); '' when not a date. */
function normalizeDob(v?: string): string {
  const m = String(v || "").trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3]}`;
}

/** One person across PM and EHR: same last name, first name and date of birth. */
function personKey(p: ParsedPatient): string {
  return `${(p.lastName || "").trim().toLowerCase()}|${(p.firstName || "").trim().toLowerCase()}|${normalizeDob(p.dateOfBirth)}`;
}

/** First data row of a Unity reply ([{ <action>info: [row] }] or [row]). */
function firstRow(data: any): Record<string, any> | undefined {
  const top = Array.isArray(data) ? data[0] : data;
  if (!top || typeof top !== "object") return undefined;
  const nested = Object.values(top).find(Array.isArray) as any[] | undefined;
  return nested ? nested[0] : top;
}

/** At most this many PM patients per search get the MRN lookup (two calls each); the rest pair by name + DOB. */
const MRN_LOOKUP_MAX = 3;

/** American Soundex code ("Beasley" and "Beesly" are both B240). */
function soundex(name: string): string {
  const s = name.toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return "";
  const codes: Record<string, string> = { B: "1", F: "1", P: "1", V: "1", C: "2", G: "2", J: "2", K: "2", Q: "2", S: "2", X: "2", Z: "2", D: "3", T: "3", L: "4", M: "5", N: "5", R: "6" };
  let out = s[0];
  let prev = codes[s[0]] || "";
  for (const ch of s.slice(1)) {
    const c = codes[ch] || "";
    if (c && c !== prev) out += c;
    if (ch !== "H" && ch !== "W") prev = c;
  }
  return (out + "000").slice(0, 4);
}

/** Last names that sound the same: equal Soundex and same first letter. */
function soundsAlike(a: string, b: string): boolean {
  return Boolean(a && b) && soundex(a) === soundex(b);
}

/**
 * Unity Patient Tools
 *
 * Provides MCP tools for patient reads via Unity API: SearchPatients, GetPatient, GetPatientByMRN.
 * SavePatient (unity_save_patient, unity_update_demographics) is not used in this release: the sandbox
 * evidence run showed it needs an AccountID the tool never had, and no certified workflow needs it.
 */
export class UnityPatientTools {
  constructor(private unityService: UnityService) {}

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

      // A failed call is an error, not "patient not found" (CLAUDE.md rule 5).
      if (!response.success) {
        throw UnityErrorHandler.createAPIError(
          response.error || "Failed to get patient",
          UnityActions.Patient.GET_PATIENT,
        );
      }

      const patient = this.parsePatientFromUnity(response.data);

      if (this.isEmptyPatient(patient)) {
        return {
          success: false,
          message: "No patient found with that ID.",
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
   * Search for patients in Veradigm® PM and Veradigm® EHR (same practice, separate patient IDs).
   *
   * SearchPatients takes plain "Last, First" text and returns name matches; date of birth is
   * filtered here. Each result carries `patientId` (PM: appointments, balance, insurance) and
   * `chartPatientId` (EHR: medications, allergies, problems). A system that fails is an error only
   * when both fail; a PM-only failure still returns chart matches without a PM ID.
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
    note?: string;
  }> {
    try {
      if (!args.lastName && !args.firstName && !args.mrn) {
        throw UnityErrorHandler.createValidationError(
          "A last name, first name or MRN is required to search",
        );
      }

      console.error(`[Unity Patient] Searching patients (PM + EHR)`);

      const dob = normalizeDob(args.dateOfBirth) || args.dateOfBirth;
      const exact = await this.searchBoth(
        { lastName: args.lastName, firstName: args.firstName, mrn: args.mrn },
        (list) => this.filterPatients(list, { ...args, dateOfBirth: dob }),
      );
      let { patients } = exact;
      const { pmOk } = exact;
      let spellingNote = "";

      // Spelling-variant fallback. Phone speech recognition often mishears last names ("Beesly" heard
      // as "Beasley"). Only with a full name AND birth date: search by the first two letters of the last
      // name + first name, then require exact DOB, exact first name and a last name that sounds the same.
      if (patients.length === 0 && args.lastName && args.firstName && normalizeDob(args.dateOfBirth)) {
        const heard = args.lastName.trim();
        const variant = await this.searchBoth(
          { lastName: heard.slice(0, 2), firstName: args.firstName },
          (list) =>
            list.filter(
              (p) =>
                normalizeDob(p.dateOfBirth) === normalizeDob(args.dateOfBirth) &&
                (p.firstName || "").trim().toLowerCase() === args.firstName!.trim().toLowerCase() &&
                soundsAlike(p.lastName || "", heard),
            ),
        ).catch(() => ({ patients: [] as ParsedPatient[], pmOk: false }));
        if (variant.patients.length === 1) {
          patients = variant.patients;
          const spelled = (patients[0].lastName || "").trim();
          spellingNote = ` Matched on a spelling variant: the record's last name is ${spelled} (${spelled.toUpperCase().split("").join("-")}), not ${heard}. Read the spelling back and get a yes before sharing anything.`;
        }
      }

      // First-name spelling variant (web test Oct 15: the caller spelled "T-E-O-D-O-R-O" and the agent searched
      // "Theodoro"). Same rule: full name AND birth date, search by last name, then exact DOB, a last name that
      // matches (or sounds the same) and a first name that sounds the same. Confirmation is still required.
      if (patients.length === 0 && args.lastName && args.firstName && normalizeDob(args.dateOfBirth)) {
        const heardFirst = args.firstName.trim();
        const heardLast = args.lastName.trim();
        const variant = await this.searchBoth(
          { lastName: heardLast },
          (list) =>
            list.filter(
              (p) =>
                normalizeDob(p.dateOfBirth) === normalizeDob(args.dateOfBirth) &&
                ((p.lastName || "").trim().toLowerCase() === heardLast.toLowerCase() || soundsAlike(p.lastName || "", heardLast)) &&
                soundsAlike(p.firstName || "", heardFirst),
            ),
        ).catch(() => ({ patients: [] as ParsedPatient[], pmOk: false }));
        if (variant.patients.length === 1) {
          patients = variant.patients;
          const first = (patients[0].firstName || "").trim();
          const last = (patients[0].lastName || "").trim();
          spellingNote = ` Matched on a spelling variant: the record's name is ${first} ${last} (${first.toUpperCase().split("").join("-")}), not ${heardFirst}. Read the spelling back and get a yes before sharing anything.`;
        }
      }
      if (args.limit) patients = patients.slice(0, args.limit);

      let message = `Found ${patients.length} patient(s)`;
      if (patients.length === 0) {
        message = args.mrn
          ? `No patient found with MRN ${args.mrn}. Try searching by patient name instead.`
          : "No patient matched that name and date of birth.";
      }
      if (!pmOk) message += " (Veradigm PM could not be reached, so appointment and billing IDs are missing.)";
      message += spellingNote;

      return { patients, total: patients.length, message, ...(spellingNote ? { note: spellingNote.trim() } : {}) };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, "SearchPatients");
    }
  }

  /** SearchPatients on PM and EHR; one entry per name + DOB (PM ID + EHR chart ID). Throws if both fail. */
  private async searchBoth(
    criteria: { lastName?: string; firstName?: string; mrn?: string },
    keep: (list: ParsedPatient[]) => ParsedPatient[],
  ): Promise<{ patients: ParsedPatient[]; pmOk: boolean }> {
    const [pmRes, ehrRes] = await Promise.all(
      (["PM", "EHR"] as UnityTargetSystem[]).map((t) =>
        this.unityService.searchPatients(criteria, t).catch((e) => ({ success: false, error: String(e?.message || e) }) as any),
      ),
    );
    // A failed search is an error, not "no match" (CLAUDE.md rule 5).
    if (!pmRes.success && !ehrRes.success) {
      throw UnityErrorHandler.createAPIError(
        pmRes.error || ehrRes.error || "Patient search failed",
        UnityActions.Patient.SEARCH_PATIENTS,
      );
    }
    const pm = pmRes.success ? keep(this.parsePatientsList(pmRes.data).filter((p) => p.id)) : [];
    const ehr = ehrRes.success ? keep(this.parsePatientsList(ehrRes.data).filter((p) => p.id)) : [];
    const key = personKey;
    // PM and EHR rows of one person are paired by MRN when one PM patient has that name + DOB (chartByPatientNumber),
    // else by name + DOB. Two different patients with the same name and DOB in one system are never merged (and
    // never paired with the other system): they stay separate entries, so the result says "more than one" instead
    // of verifying, or filing to, one of them (launch audit 2026-10-16).
    const groups = new Map<string, ParsedPatient[]>();
    const seen = new Set<string>();
    for (const p of pm) {
      if (seen.has(`pm|${p.id}`)) continue;
      seen.add(`pm|${p.id}`);
      const k = key(p);
      groups.set(k, [...(groups.get(k) || []), { ...p, patientId: p.id, pmMrn: p.mrn }]);
    }
    const pmCount = new Map<string, number>([...groups].map(([k, v]) => [k, v.length]));
    const byMrn = new Map<string, ParsedPatient>();
    await Promise.all(
      [...groups]
        .filter(([, v]) => v.length === 1)
        .slice(0, MRN_LOOKUP_MAX)
        .map(async ([k, [p]]) => {
          const chart = await this.chartByPatientNumber(p).catch(() => undefined);
          if (chart) byMrn.set(k, chart);
        }),
    );
    const ehrCount = new Map<string, number>();
    for (const p of ehr) {
      if (seen.has(`ehr|${p.id}`)) continue;
      seen.add(`ehr|${p.id}`);
      ehrCount.set(key(p), (ehrCount.get(key(p)) || 0) + 1);
    }
    seen.clear();
    for (const p of ehr) {
      if (seen.has(`ehr|${p.id}`)) continue;
      seen.add(`ehr|${p.id}`);
      const k = key(p);
      const list = groups.get(k);
      const viaMrn = byMrn.get(k);
      const existing = list && pmCount.get(k) === 1 && (viaMrn ? viaMrn.id === p.id : ehrCount.get(k) === 1) ? list[0] : undefined;
      if (existing) {
        existing.chartPatientId = p.id;
        existing.chartMrn = p.mrn;
        // Address and SSN-4 (document matching): PM's when it has them, else the EHR's.
        if (!existing.address?.line1 && p.address?.line1) existing.address = p.address;
        if (!existing.ssnLast4 && p.ssnLast4) existing.ssnLast4 = p.ssnLast4;
      } else groups.set(k, [...(list || []), { ...p, chartPatientId: p.id, chartMrn: p.mrn }]);
    }
    // The MRN found the chart but the EHR name search did not return it: pair it, unless another chart with this
    // name + DOB came back (then the result already lists more than one).
    for (const [k, chart] of byMrn) {
      const list = groups.get(k);
      if (list?.length === 1 && !list[0].chartPatientId) {
        list[0].chartPatientId = chart.id;
        list[0].chartMrn = chart.mrn;
      }
    }
    return { patients: [...groups.values()].flat(), pmOk: Boolean(pmRes.success) };
  }

  /**
   * The EHR chart of one verified PM patient, by MRN: the EHR chart MRN is the PM patient number
   * (GetPatientDemographics Patient_Number; the PM Patient_Med_Rec_No is a different number). GetPatientByMRN can
   * return more than one patient (sandbox Oct 21: two charts share one MRN), so only a chart with the PM patient's
   * name and DOB counts, and only when exactly one does. undefined: no number, no such chart, or more than one.
   */
  private async chartByPatientNumber(pm: ParsedPatient): Promise<ParsedPatient | undefined> {
    const demo = await this.unityService.executeAction<any>(UnityActions.Patient.GET_PATIENT_DEMOGRAPHICS, {}, pm.id, "PM");
    const number = demo.success ? String(firstRow(demo.data)?.Patient_Number ?? "").trim() : "";
    if (!number) return undefined;
    const res = await this.unityService.executeAction<any>(
      UnityActions.Patient.GET_PATIENT_BY_MRN,
      { Parameter1: number, Parameter2: "" },
      "",
      "EHR",
    );
    if (!res.success) return undefined;
    const same = this.parsePatientsList(res.data).filter((c) => c.id && personKey(c) === personKey(pm));
    return same.length === 1 ? { ...same[0], mrn: same[0].mrn || number } : undefined;
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
    const t0 = Date.now();
    try {
      if (!args.mrn) {
        throw UnityErrorHandler.createValidationError("MRN is required");
      }

      console.error(`[Unity Patient] Getting patient by MRN`); // never the MRN

      const response = await this.unityService.executeAction<any>(
        UnityActions.Patient.GET_PATIENT_BY_MRN,
        {
          Parameter1: args.mrn,
          Parameter2: args.organization || "",
        },
        "",
        args.target || "EHR",
      );
      console.error(`[Unity Patient] GET_PATIENT_BY_MRN API took ${Date.now() - t0}ms`);

      if (!response.success) {
        console.error(`[Unity Patient] getPatientByMRN total: ${Date.now() - t0}ms (API failed)`);
        throw UnityErrorHandler.createAPIError(
          response.error || "Failed to get patient by MRN",
          UnityActions.Patient.GET_PATIENT_BY_MRN,
        );
      }

      let patient = this.parsePatientFromUnity(response.data);

      // GetPatientByMRN often returns a different response shape; if we have no usable details, get via search by MRN
      const hasUsableDetails =
        patient.id && (patient.firstName || patient.lastName);
      if (!hasUsableDetails) {
        const t1 = Date.now();
        try {
          const searchResult = await this.searchPatients({
            mrn: args.mrn,
          });
          console.error(`[Unity Patient] Fallback search took ${Date.now() - t1}ms, found ${searchResult.total} patients`);
          const normalizedMrn = String(args.mrn || "").trim();
          const match = searchResult.patients.find(
            (p) => String(p.mrn || "").trim() === normalizedMrn,
          );
          if (match) {
            console.error(`[Unity Patient] Using search result for the MRN`);
            patient = match;
          }
        } catch (searchErr) {
          console.error(
            `[Unity Patient] Fallback search by MRN failed: ${errorSummary(searchErr)}`,
          );
        }
      }

      if (this.isEmptyPatient(patient)) {
        console.error(`[Unity Patient] getPatientByMRN total: ${Date.now() - t0}ms (not found)`);
        return {
          success: false,
          message: `No patient found with MRN ${args.mrn}.`,
        };
      }

      console.error(`[Unity Patient] getPatientByMRN total: ${Date.now() - t0}ms (found)`);
      return {
        success: true,
        patient,
        message: "Patient retrieved successfully",
      };
    } catch (error) {
      console.error(`[Unity Patient] getPatientByMRN total: ${Date.now() - t0}ms (error)`);
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
   * Client-side filter: keep patients matching the given criteria.
   *
   * Voice transcriptions are often inaccurate for names (e.g. "Albanese" →
   * "Alvinis") so we use DOB as the strongest signal and only require the
   * first 2 characters of names to match (case-insensitive).
   */
  private filterPatients(
    patients: ParsedPatient[],
    criteria: { firstName?: string; lastName?: string; dateOfBirth?: string; mrn?: string },
  ): ParsedPatient[] {
    const norm = (s?: string) => (s || "").trim().toLowerCase();
    const cFirst = norm(criteria.firstName);
    const cLast = norm(criteria.lastName);
    const cDob = norm(criteria.dateOfBirth);
    const cMrn = norm(criteria.mrn);

    // Helper: first N chars match
    const startsWith = (a: string, b: string, n: number) =>
      a.slice(0, n) === b.slice(0, n);

    return patients.filter((p) => {
      // MRN: exact match
      if (cMrn) {
        return norm(p.mrn) === cMrn;
      }

      // DOB provided → strongest filter; name is soft (first 2 chars)
      if (cDob) {
        const dobMatch = (normalizeDob(p.dateOfBirth) || norm(p.dateOfBirth)) === (normalizeDob(cDob) || cDob);
        if (!dobMatch) return false;

        // If name criteria also given, soft-match first 2 chars
        if (cFirst && !startsWith(norm(p.firstName), cFirst, 2)) return false;
        if (cLast && !startsWith(norm(p.lastName), cLast, 2)) return false;
        return true;
      }

      // No DOB → use name with 3-char prefix match
      let matches = false;
      if (cFirst) {
        matches = startsWith(norm(p.firstName), cFirst, 3);
      }
      if (cLast) {
        const lastMatch = startsWith(norm(p.lastName), cLast, 3);
        matches = cFirst ? matches && lastMatch : lastMatch;
      }
      return matches;
    });
  }

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

    if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
      const infoKey = Object.keys(data[0]).find(
        (key) =>
          key.toLowerCase().endsWith("info") && Array.isArray(data[0][key]),
      );
      if (infoKey && data[0][infoKey][0]) {
        data = data[0][infoKey][0];
      } else {
        data = data[0];
      }
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

    // SSN: only ever its last 4 digits, and only when Veradigm® doesn't flag it hidden or suppressed
    // (PM SearchPatients rows carry ssn, HideSSN, SuppressSSN; EHR rows carry ssn). Sandbox, Oct 11 2026:
    // ssn comes back blank in both, HideSSN = SuppressSSN = Y in PM. The document intake add-on compares
    // it with the last 4 on a faxed document (match.ts); it is never shown to a caller.
    const hidden = ["HideSSN", "SuppressSSN"].some((k) => /^(y|yes|true|1)$/i.test(getValue(data, k) || ""));
    const ssnDigits = (getValue(data, "ssn", "SSN", "SocialSecurityNumber") || "").replace(/\D/g, "");
    if (!hidden && ssnDigits.length >= 4) patient.ssnLast4 = ssnDigits.slice(-4);

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

    // Debug: Log data shape only (avoid dumping full payload which is very slow)
    const dataShape = Array.isArray(data)
      ? `Array[${data.length}]`
      : typeof data;
    console.error(`[Unity Patient] Raw search response shape: ${dataShape}`);

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
   * Get MCP tool definitions for patient operations
   */
  getTools(): Tool[] {
    return [
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
        description:
          "Find a patient in Veradigm PM and Veradigm EHR by last name, first name and date of birth. " +
          "Each match returns patientId (Veradigm PM: appointments, balance, insurance) and chartPatientId " +
          "(Veradigm EHR: medications, allergies, problems, staff messages). The caller is verified only when exactly one patient matches all three.",
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
