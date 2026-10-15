import axios, { AxiosResponse } from "axios";
import NodeCache from "node-cache";
import { randomUUID, sign } from "crypto";
import { readFileSync } from "fs";
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
   * Single-use JWT client assertion (SMART backend services), signed with the private key whose
   * public half is published at the app's registered JWKS URL. 5-minute expiry per Veradigm's sample.
   *   FHIR_JWT_PRIVATE_KEY_PATH  PEM file (pkcs8), FHIR_JWT_KID  key id in the JWKS, FHIR_JWT_ALG  RS256|RS384
   */
  private clientAssertion(): string {
    const keyPath = process.env.FHIR_JWT_PRIVATE_KEY_PATH || "";
    const kid = process.env.FHIR_JWT_KID || "";
    const alg = (process.env.FHIR_JWT_ALG || "RS256") as "RS256" | "RS384";
    const privateKey = readFileSync(keyPath);
    const now = Math.floor(Date.now() / 1000);
    const b64u = (v: object | Buffer) =>
      Buffer.from(v instanceof Buffer ? v : JSON.stringify(v)).toString("base64url");
    const input = `${b64u({ alg, typ: "JWT", kid })}.${b64u({
      iss: config.clientId,
      sub: config.clientId,
      aud: config.tokenUrl,
      jti: randomUUID(),
      iat: now,
      nbf: now,
      exp: now + 300,
    })}`;
    const signature = sign(alg === "RS384" ? "sha384" : "sha256", Buffer.from(input), privateKey);
    return `${input}.${b64u(signature)}`;
  }

  /**
   * Request a new access token using client credentials flow
   */
  private async requestNewToken(): Promise<TokenResponse> {
    try {
      // Veradigm FHIR R4 system apps authenticate with a signed JWT (private_key_jwt);
      // FHIR_AUTH_MODE=private_key_jwt switches to it. Default stays client_secret.
      const params =
        process.env.FHIR_AUTH_MODE === "private_key_jwt"
          ? new URLSearchParams({
              grant_type: "client_credentials",
              scope: process.env.FHIR_SCOPE || "system/*.read",
              client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
              client_assertion: this.clientAssertion(),
            })
          : new URLSearchParams({
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
