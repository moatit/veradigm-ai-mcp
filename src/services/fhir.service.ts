import axios, { AxiosResponse, AxiosError } from 'axios';
import { AuthService } from './auth.service';
import { fhirEndpoints } from '../config/fhir-endpoints';

export interface FHIRBundle {
  resourceType: 'Bundle';
  type: 'searchset' | 'collection';
  total?: number;
  entry?: Array<{
    resource: any;
    fullUrl?: string;
    search?: {
      mode: 'match' | 'include' | 'outcome';
      score?: number;
    };
  }>;
  link?: Array<{
    relation: 'self' | 'next' | 'previous' | 'first' | 'last';
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
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/fhir+json',
            'Content-Type': 'application/fhir+json'
          }
        }
      );

      return this.parseSearchResult<T>(response.data);
    } catch (error) {
      throw this.handleFHIRError(error);
    }
  }

  /**
   * Get a specific FHIR resource by ID
   */
  async getResource<T = FHIRResource>(resourceType: string, id: string): Promise<T> {
    try {
      const accessToken = await this.authService.getAccessToken();
      
      const response: AxiosResponse<T> = await axios.get(
        `${fhirEndpoints.baseUrl}/${resourceType}/${id}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/fhir+json',
            'Content-Type': 'application/fhir+json'
          }
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
  async getNextPage<T = FHIRResource>(nextUrl: string): Promise<FHIRSearchResult<T>> {
    try {
      const accessToken = await this.authService.getAccessToken();
      
      const response: AxiosResponse<FHIRBundle> = await axios.get(nextUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/fhir+json',
          'Content-Type': 'application/fhir+json'
        }
      });

      return this.parseSearchResult<T>(response.data);
    } catch (error) {
      throw this.handleFHIRError(error);
    }
  }

  /**
   * Build search parameters for FHIR API
   */
  private buildSearchParams(params: FHIRSearchParams, pageSize: number): Record<string, string> {
    const searchParams: Record<string, string> = {
      _count: pageSize.toString()
    };

    // Add search parameters, filtering out undefined values
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        searchParams[key] = value.toString();
      }
    });

    return searchParams;
  }

  /**
   * Parse FHIR Bundle response into search result
   */
  private parseSearchResult<T>(bundle: FHIRBundle): FHIRSearchResult<T> {
    const resources: T[] = bundle.entry?.map(entry => entry.resource) || [];
    const total = bundle.total || resources.length;
    
    // Find next page link
    const nextLink = bundle.link?.find(link => link.relation === 'next');
    const hasMore = !!nextLink;
    const nextUrl = nextLink?.url;

    return {
      resources,
      total,
      hasMore,
      nextUrl
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
        const data = axiosError.response.data;
        
        switch (status) {
          case 401:
            return new Error('Authentication failed: Invalid or expired token');
          case 403:
            return new Error('Access forbidden: Insufficient permissions');
          case 404:
            return new Error('Resource not found');
          case 400:
            return new Error(`Bad request: ${JSON.stringify(data)}`);
          case 429:
            return new Error('Rate limit exceeded: Too many requests');
          case 500:
            return new Error('Internal server error');
          default:
            return new Error(`FHIR API error (${status}): ${JSON.stringify(data)}`);
        }
      } else if (axiosError.request) {
        return new Error('Network error: Unable to connect to FHIR server');
      }
    }
    
    return new Error(`Unexpected error: ${error.message || error}`);
  }

  /**
   * Get FHIR server capabilities
   */
  async getCapabilities(): Promise<any> {
    try {
      const accessToken = await this.authService.getAccessToken();
      
      const response = await axios.get(
        `${fhirEndpoints.baseUrl}/metadata`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/fhir+json'
          }
        }
      );

      return response.data;
    } catch (error) {
      throw this.handleFHIRError(error);
    }
  }
}

