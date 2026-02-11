import axios, { AxiosResponse } from "axios";
import NodeCache from "node-cache";
import { config } from "../config/environment";

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface AuthError {
  error: string;
  error_description?: string;
}

export class AuthService {
  private cache: NodeCache;
  private readonly CACHE_KEY = "access_token";

  constructor() {
    this.cache = new NodeCache({
      stdTTL: config.tokenCacheTtl,
      checkperiod: 60,
    });
  }

  /**
   * Get a valid access token, using cache if available
   */
  async getAccessToken(): Promise<string> {
    if (config.cacheEnabled) {
      const cachedToken = this.cache.get<string>(this.CACHE_KEY);
      if (cachedToken) {
        return cachedToken;
      }
    }

    const tokenResponse = await this.requestNewToken();

    if (config.cacheEnabled) {
      this.cache.set(
        this.CACHE_KEY,
        tokenResponse.access_token,
        tokenResponse.expires_in,
      );
    }

    return tokenResponse.access_token;
  }

  /**
   * Request a new access token using client credentials flow
   */
  private async requestNewToken(): Promise<TokenResponse> {
    try {
      // Build params with scope for FHIR read access
      const params = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: "system/*.read",
      });

      const response: AxiosResponse<TokenResponse> = await axios.post(
        config.tokenUrl,
        params,
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
        },
      );

      return response.data;
    } catch (error) {
      console.error("Authentication failed:", error);
      if (axios.isAxiosError(error)) {
        const authError = error.response?.data as AuthError;
        throw new Error(
          `Authentication failed: ${authError?.error || error.message}`,
        );
      }
      throw new Error(`Authentication failed: ${error}`);
    }
  }

  /**
   * Pre-warm the token cache so first API call is fast
   */
  async warmUp(): Promise<void> {
    try {
      console.log("[Auth] Pre-warming token cache...");
      await this.getAccessToken();
      console.log("[Auth] Token cache warmed up successfully");
    } catch (error) {
      console.error("[Auth] Failed to pre-warm token cache:", error);
    }
  }

  /**
   * Clear cached token (useful for testing or when token is invalid)
   */
  clearTokenCache(): void {
    this.cache.del(this.CACHE_KEY);
  }

  /**
   * Check if token is cached and valid
   */
  isTokenCached(): boolean {
    return this.cache.has(this.CACHE_KEY);
  }

  /**
   * Get token info for debugging
   */
  getTokenInfo(): { cached: boolean; ttl?: number } {
    const ttl = this.cache.getTtl(this.CACHE_KEY);
    return {
      cached: this.cache.has(this.CACHE_KEY),
      ttl: ttl ? Math.floor((ttl - Date.now()) / 1000) : undefined,
    };
  }
}
