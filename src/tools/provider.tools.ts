import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { FHIRService } from "../services/fhir.service";
import { ErrorHandler, FHIRMCPError } from "../utils/error-handler";
import { FHIRParser, ParsedPractitioner } from "../utils/fhir-parser";

export class ProviderTools {
  constructor(private fhirService: FHIRService) {}

  /**
   * Search for practitioners/providers
   */
  async searchProviders(args: {
    name?: string;
    firstName?: string;
    lastName?: string;
    specialty?: string;
    identifier?: string;
    active?: boolean;
    limit?: number;
  }): Promise<{
    providers: ParsedPractitioner[];
    total: number;
    hasMore: boolean;
  }> {
    try {
      const searchParams: Record<string, string> = {};

      if (args.name) {
        searchParams.name = args.name;
      } else {
        if (args.firstName) searchParams.given = args.firstName;
        if (args.lastName) searchParams.family = args.lastName;
      }

      if (args.specialty) {
        searchParams.specialty = args.specialty;
      }
      if (args.identifier) {
        searchParams.identifier = args.identifier;
      }
      if (args.active !== undefined) {
        searchParams.active = args.active.toString();
      }

      const result = await this.fhirService.search(
        "Practitioner",
        searchParams,
        args.limit || 20
      );
      const providers = result.resources.map((practitioner) =>
        FHIRParser.parsePractitioner(practitioner)
      );

      return {
        providers,
        total: result.total,
        hasMore: result.hasMore,
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get provider details by ID
   */
  async getProviderDetails(args: {
    providerId: string;
  }): Promise<ParsedPractitioner> {
    try {
      if (!args.providerId) {
        throw ErrorHandler.createValidationError("Provider ID is required");
      }

      const practitioner = await this.fhirService.getResource(
        "Practitioner",
        args.providerId
      );
      return FHIRParser.parsePractitioner(practitioner);
    } catch (error: any) {
      if (error instanceof FHIRMCPError) {
        throw error;
      }
      // Check if it's a resource not found error
      if (
        error.message &&
        (error.message.includes("Resource not found") ||
          error.message.includes("ResourceNotFoundException") ||
          error.message.includes("does not exist"))
      ) {
        throw ErrorHandler.createValidationError(
          `Provider with ID "${args.providerId}" was not found. Please verify the provider ID is correct, or use search_providers to find available providers.`
        );
      }
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Search for locations/facilities
   */
  async searchLocations(args: {
    name?: string;
    address?: string;
    type?: string;
    status?: string;
    limit?: number;
  }): Promise<{
    locations: Array<{
      id: string;
      name: string;
      address?: string;
      type?: string;
      status: string;
      phone?: string;
      email?: string;
    }>;
    total: number;
    hasMore: boolean;
  }> {
    try {
      const searchParams: Record<string, string> = {};

      if (args.name) {
        searchParams.name = args.name;
      }
      if (args.address) {
        searchParams.address = args.address;
      }
      if (args.type) {
        searchParams.type = args.type;
      }
      if (args.status) {
        searchParams.status = args.status;
      }

      const result = await this.fhirService.search(
        "Location",
        searchParams,
        args.limit || 20
      );

      const locations = result.resources.map((location) => {
        const address = location.address?.[0];
        const telecom = location.telecom || [];
        const phone = telecom.find((t) => t.system === "phone")?.value;
        const email = telecom.find((t) => t.system === "email")?.value;

        return {
          id: location.id,
          name: location.name || "Unknown",
          address: address
            ? `${address.line?.join(", ")}, ${address.city}, ${address.state} ${
                address.postalCode
              }`
            : undefined,
          type: location.type?.[0]?.coding?.[0]?.display,
          status: location.status,
          phone,
          email,
        };
      });

      return {
        locations,
        total: result.total,
        hasMore: result.hasMore,
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get location details by ID
   */
  async getLocationDetails(args: { locationId: string }): Promise<{
    id: string;
    name: string;
    address?: string;
    type?: string;
    status: string;
    phone?: string;
    email?: string;
    description?: string;
  }> {
    try {
      if (!args.locationId) {
        throw ErrorHandler.createValidationError("Location ID is required");
      }

      const location = await this.fhirService.getResource(
        "Location",
        args.locationId
      );
      const address = location.address?.[0];
      const telecom = location.telecom || [];
      const phone = telecom.find((t) => t.system === "phone")?.value;
      const email = telecom.find((t) => t.system === "email")?.value;

      return {
        id: location.id,
        name: location.name || "Unknown",
        address: address
          ? `${address.line?.join(", ")}, ${address.city}, ${address.state} ${
              address.postalCode
            }`
          : undefined,
        type: location.type?.[0]?.coding?.[0]?.display,
        status: location.status,
        phone,
        email,
        description: location.description,
      };
    } catch (error: any) {
      if (error instanceof FHIRMCPError) {
        throw error;
      }
      // Check if it's a resource not found error
      if (
        error.message &&
        (error.message.includes("Resource not found") ||
          error.message.includes("ResourceNotFoundException") ||
          error.message.includes("does not exist"))
      ) {
        throw ErrorHandler.createValidationError(
          `Location with ID "${args.locationId}" was not found. Please verify the location ID is correct, or use search_locations to find available locations.`
        );
      }
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get MCP tool definitions for provider operations
   */
  getTools(): Tool[] {
    return [
      {
        name: "search_providers",
        description: "Search for healthcare providers/practitioners",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Full name to search for",
            },
            firstName: {
              type: "string",
              description: "First name to search for",
            },
            lastName: {
              type: "string",
              description: "Last name to search for",
            },
            specialty: {
              type: "string",
              description: "Medical specialty to filter by",
            },
            identifier: {
              type: "string",
              description: "Provider identifier (NPI, license number, etc.)",
            },
            active: {
              type: "boolean",
              description: "Filter by active status",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 20)",
              default: 20,
            },
          },
        },
      },
      {
        name: "get_provider_details",
        description: "Get detailed information for a specific provider",
        inputSchema: {
          type: "object",
          properties: {
            providerId: {
              type: "string",
              description: "FHIR Practitioner resource ID",
            },
          },
          required: ["providerId"],
        },
      },
      {
        name: "search_locations",
        description: "Search for healthcare facilities/locations",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Location name to search for",
            },
            address: {
              type: "string",
              description: "Address to search for",
            },
            type: {
              type: "string",
              description: "Location type (hospital, clinic, pharmacy, etc.)",
            },
            status: {
              type: "string",
              enum: ["active", "suspended", "inactive"],
              description: "Location status to filter by",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 20)",
              default: 20,
            },
          },
        },
      },
      {
        name: "get_location_details",
        description: "Get detailed information for a specific location",
        inputSchema: {
          type: "object",
          properties: {
            locationId: {
              type: "string",
              description: "FHIR Location resource ID",
            },
          },
          required: ["locationId"],
        },
      },
    ];
  }
}
