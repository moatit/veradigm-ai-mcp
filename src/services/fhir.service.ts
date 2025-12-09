import axios, { AxiosError, AxiosResponse } from "axios";
import { fhirEndpoints } from "../config/fhir-endpoints";
import { AuthService } from "./auth.service";

export interface FHIRBundle {
  resourceType: "Bundle";
  type: "searchset" | "collection";
  total?: number;
  entry?: Array<{
    resource: any;
    fullUrl?: string;
    search?: {
      mode: "match" | "include" | "outcome";
      score?: number;
    };
  }>;
  link?: Array<{
    relation: "self" | "next" | "previous" | "first" | "last";
    url: string;
  }>;
}

export interface FHIRResource {
  resourceType: string;
  id: string;
  meta?: {
    versionId?: string;
    lastUpdated?: string;
    profile?: string[];
  };
  [key: string]: any;
}

export interface FHIRSearchParams {
  [key: string]: string | number | boolean | undefined;
}

export interface FHIRSearchResult<T = FHIRResource> {
  resources: T[];
  total: number;
  hasMore: boolean;
  nextUrl?: string;
}

export class FHIRService {
  private authService: AuthService;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  /**
   * Search for FHIR resources with pagination support
   */
  async search<T = FHIRResource>(
    resourceType: string,
    params: FHIRSearchParams = {},
    pageSize: number = 20
  ): Promise<FHIRSearchResult<T>> {
    try {
      const accessToken = await this.authService.getAccessToken();
      const searchParams = this.buildSearchParams(params, pageSize);

      const response: AxiosResponse<FHIRBundle> = await axios.get(
        `${fhirEndpoints.baseUrl}/${resourceType}`,
        {
          params: searchParams,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/fhir+json",
            "Content-Type": "application/fhir+json",
          },
        }
      );

      return this.parseSearchResult<T>(response.data);
    } catch (error) {
      // Log detailed error for debugging
      if (axios.isAxiosError(error) && error.response) {
        console.error(
          `FHIR Search Error [${resourceType}]: Status ${error.response.status}`
        );
        console.error(`URL: ${error.config?.url}`);
        console.error(`Params:`, error.config?.params);
        console.error(
          `Response:`,
          JSON.stringify(error.response.data, null, 2)
        );
      }
      throw this.handleFHIRError(error);
    }
  }

  /**
   * Get a specific FHIR resource by ID
   */
  async getResource<T = FHIRResource>(
    resourceType: string,
    id: string
  ): Promise<T> {
    try {
      const accessToken = await this.authService.getAccessToken();

      const response: AxiosResponse<T> = await axios.get(
        `${fhirEndpoints.baseUrl}/${resourceType}/${id}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/fhir+json",
            "Content-Type": "application/fhir+json",
          },
        }
      );

      return response.data;
    } catch (error) {
      throw this.handleFHIRError(error);
    }
  }

  /**
   * Get next page of search results
   */
  async getNextPage<T = FHIRResource>(
    nextUrl: string
  ): Promise<FHIRSearchResult<T>> {
    try {
      const accessToken = await this.authService.getAccessToken();

      const response: AxiosResponse<FHIRBundle> = await axios.get(nextUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/fhir+json",
          "Content-Type": "application/fhir+json",
        },
      });

      return this.parseSearchResult<T>(response.data);
    } catch (error) {
      throw this.handleFHIRError(error);
    }
  }

  /**
   * Build search parameters for FHIR API
   */
  private buildSearchParams(
    params: FHIRSearchParams,
    pageSize: number
  ): Record<string, string> {
    const searchParams: Record<string, string> = {
      _count: pageSize.toString(),
    };

    // Add search parameters, filtering out undefined values
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        searchParams[key] = value.toString();
      }
    });

    return searchParams;
  }

  /**
   * Parse FHIR Bundle response into search result
   */
  private parseSearchResult<T>(bundle: FHIRBundle): FHIRSearchResult<T> {
    const resources: T[] = bundle.entry?.map((entry) => entry.resource) || [];
    const total = bundle.total || resources.length;

    // Find next page link
    const nextLink = bundle.link?.find((link) => link.relation === "next");
    const hasMore = !!nextLink;
    const nextUrl = nextLink?.url;

    return {
      resources,
      total,
      hasMore,
      nextUrl,
    };
  }

  /**
   * Handle FHIR API errors
   */
  private handleFHIRError(error: any): Error {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      if (axiosError.response) {
        const status = axiosError.response.status;
        const data: any = axiosError.response.data;

        switch (status) {
          case 401:
            return new Error("Authentication failed: Invalid or expired token");
          case 403:
            return new Error("Access forbidden: Insufficient permissions");
          case 404:
            return new Error("Resource not found");
          case 400:
            return new Error(`Bad request: ${JSON.stringify(data)}`);
          case 429:
            return new Error("Rate limit exceeded: Too many requests");
          case 500:
            // Check if there's more detail in the response
            const errorDetail =
              data?.issue?.[0]?.details?.text ||
              data?.text?.div ||
              data?.message ||
              JSON.stringify(data);
            // Check if it's actually a ResourceNotFoundException (common in Veradigm API)
            if (
              errorDetail &&
              (errorDetail.includes("ResourceNotFoundException") ||
                errorDetail.includes("Resource not found") ||
                errorDetail.includes("not found"))
            ) {
              return new Error(
                "Resource not found: The requested resource does not exist or is not accessible"
              );
            }
            return new Error(`Internal server error: ${errorDetail}`);
          default:
            return new Error(
              `FHIR API error (${status}): ${JSON.stringify(data)}`
            );
        }
      } else if (axiosError.request) {
        return new Error("Network error: Unable to connect to FHIR server");
      }
    }

    return new Error(`Unexpected error: ${error.message || error}`);
  }

  /**
   * Create a new FHIR resource
   */
  async createResource<T = FHIRResource>(
    resourceType: string,
    resource: Partial<T>
  ): Promise<T> {
    try {
      const accessToken = await this.authService.getAccessToken();

      const response: AxiosResponse<T> = await axios.post(
        `${fhirEndpoints.baseUrl}/${resourceType}`,
        {
          resourceType,
          ...resource,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/fhir+json",
            "Content-Type": "application/fhir+json",
          },
        }
      );

      return response.data;
    } catch (error) {
      // Log the actual error for debugging
      if (axios.isAxiosError(error) && error.response) {
        const status = error.response.status;
        const data = error.response.data;
        console.error(`FHIR POST Error [${resourceType}]: Status ${status}`);
        console.error(`Response: ${JSON.stringify(data, null, 2)}`);

        // Check if it's a 404 on POST - means create operation not supported
        if (status === 404) {
          const errorMessage =
            data?.issue?.[0]?.details?.text ||
            data?.text?.div ||
            JSON.stringify(data);
          if (
            errorMessage.includes("not supported") ||
            errorMessage.includes("Not Found")
          ) {
            throw new Error(
              `Create operation not supported: The FHIR API does not support creating ${resourceType} resources. This may be a limitation of your API tier or the resource type is read-only.`
            );
          }
        }
      }
      throw this.handleFHIRError(error);
    }
  }

  /**
   * Get FHIR server capabilities
   */
  async getCapabilities(): Promise<any> {
    try {
      const accessToken = await this.authService.getAccessToken();

      const response = await axios.get(`${fhirEndpoints.baseUrl}/metadata`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/fhir+json",
        },
      });

      return response.data;
    } catch (error) {
      throw this.handleFHIRError(error);
    }
  }
}
