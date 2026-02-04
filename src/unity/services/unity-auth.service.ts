import axios, { AxiosResponse } from 'axios';
import NodeCache from 'node-cache';
import { unityConfig } from '../config/environment';
import { getUbiquityId, unityEndpoints, UnityTargetSystem } from '../config/unity-endpoints';

/**
 * Unity Security Token Response
 */
export interface UnityTokenResponse {
  token: string;
  expiresAt: number; // Unix timestamp
}

/**
 * Unity Authentication Error
 */
export interface UnityAuthError {
  error: string;
  error_description?: string;
}

/**
 * User Authentication Result
 */
export interface UserAuthResult {
  authenticated: boolean;
  userId?: string;
  userName?: string;
  error?: string;
}

/**
 * Unity Authentication Service
 * 
 * Handles Unity API authentication including:
 * - GetToken: Obtain security token using Unity service credentials
 * - GetUserAuthentication: Authenticate EHR/PM user (required before other actions)
 * - RetireToken: Invalidate security token
 */
export class UnityAuthService {
  private tokenCache: NodeCache;
  private userAuthCache: NodeCache;
  
  private readonly TOKEN_CACHE_KEY_PREFIX = 'unity_token_';
  private readonly USER_AUTH_CACHE_KEY_PREFIX = 'user_auth_';

  constructor() {
    // Token cache with TTL slightly less than Unity's 20-minute expiry
    this.tokenCache = new NodeCache({
      stdTTL: unityConfig.tokenCacheTtl,
      checkperiod: 60
    });
    
    // User auth cache - tied to token lifetime
    this.userAuthCache = new NodeCache({
      stdTTL: unityConfig.tokenCacheTtl,
      checkperiod: 60
    });
  }

  /**
   * Get a valid security token for the specified target system
   * Tokens are cached and reused until near expiry
   */
  async getSecurityToken(target: UnityTargetSystem = 'EHR'): Promise<string> {
    const cacheKey = `${this.TOKEN_CACHE_KEY_PREFIX}${target}`;
    
    // Check cache first
    const cachedToken = this.tokenCache.get<string>(cacheKey);
    if (cachedToken) {
      console.error(`[Unity Auth] Using cached token for ${target}`);
      return cachedToken;
    }

    // Request new token
    const token = await this.requestNewToken(target);
    
    // Cache the token
    this.tokenCache.set(cacheKey, token, unityConfig.tokenCacheTtl);
    
    return token;
  }

  /**
   * Request a new security token from Unity
   * 
   * When using Ubiquity, the service username must be prefixed with the Ubiquity ID:
   * e.g., VHCP001PM:PMGA02^8^MyUnitySvcUsername
   */
  private async requestNewToken(target: UnityTargetSystem): Promise<string> {
    try {
      const ubiquityId = getUbiquityId(target);
      
      // Prefix service username with Ubiquity ID
      const fullUsername = `${ubiquityId}${unityConfig.svcUsername}`;
      
      const payload = {
        Username: fullUsername,
        Password: unityConfig.svcPassword
      };

      console.error(`[Unity Auth] Requesting new token for ${target}...`);
      console.error(`[Unity Auth] Endpoint: ${unityEndpoints.getToken}`);

      const response: AxiosResponse<string> = await axios.post(
        unityEndpoints.getToken,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      // Response is the token string (UUID format)
      const token = response.data;
      
      if (!token || typeof token !== 'string') {
        throw new Error('Invalid token response from Unity');
      }

      console.error(`[Unity Auth] Successfully obtained token for ${target}`);
      return token;
    } catch (error) {
      console.error('[Unity Auth] Token request failed:', error);
      
      if (axios.isAxiosError(error)) {
        const authError = error.response?.data as UnityAuthError;
        throw new Error(
          `Unity authentication failed: ${authError?.error || error.message}`
        );
      }
      
      throw new Error(`Unity authentication failed: ${error}`);
    }
  }

  /**
   * Authenticate the EHR/PM user
   * This MUST be called once after GetToken before making other Unity calls
   * 
   * The authentication result is cached for the lifetime of the token
   */
  async authenticateUser(
    token: string,
    target: UnityTargetSystem = 'EHR'
  ): Promise<UserAuthResult> {
    const cacheKey = `${this.USER_AUTH_CACHE_KEY_PREFIX}${target}_${token}`;
    
    // Check cache first
    const cachedAuth = this.userAuthCache.get<UserAuthResult>(cacheKey);
    if (cachedAuth?.authenticated) {
      console.error(`[Unity Auth] Using cached user authentication for ${target}`);
      return cachedAuth;
    }

    try {
      console.error(`[Unity Auth] Authenticating EHR/PM user for ${target}...`);

      // Call GetUserAuthentication via MagicJson
      const payload = {
        Action: 'GetUserAuthentication',
        Appname: unityConfig.appName,
        AppUserID: unityConfig.ehrUsername,
        PatientID: '',
        Token: token,
        Parameter1: unityConfig.ehrPassword, // Password goes in Parameter1
        Parameter2: '',
        Parameter3: '',
        Parameter4: '',
        Parameter5: '',
        Parameter6: '',
        Data: '' // Required field for MagicJson
      };

      const response = await axios.post(
        unityEndpoints.magicJson,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      // Parse response - successful auth returns user info
      const result = this.parseAuthResponse(response.data);
      
      if (result.authenticated) {
        // Cache successful authentication
        this.userAuthCache.set(cacheKey, result, unityConfig.tokenCacheTtl);
        console.error(`[Unity Auth] User authenticated successfully for ${target}`);
      } else {
        console.error(`[Unity Auth] User authentication failed: ${result.error}`);
      }

      return result;
    } catch (error) {
      console.error('[Unity Auth] User authentication error:', error);
      
      return {
        authenticated: false,
        error: axios.isAxiosError(error) 
          ? error.response?.data?.Error || error.message
          : String(error)
      };
    }
  }

  /**
   * Parse GetUserAuthentication response
   */
  private parseAuthResponse(data: any): UserAuthResult {
    // Check for error in response
    if (data?.Error) {
      return {
        authenticated: false,
        error: data.Error
      };
    }

    // Successful authentication returns user info
    // The exact structure depends on the EHR system
    if (data) {
      return {
        authenticated: true,
        userId: data.UserID || data.userid || data.ID,
        userName: data.UserName || data.username || data.Name
      };
    }

    return {
      authenticated: false,
      error: 'Unknown authentication response'
    };
  }

  /**
   * Retire (invalidate) a security token
   * Should be called when closing the application or switching contexts
   */
  async retireToken(token: string, target: UnityTargetSystem = 'EHR'): Promise<boolean> {
    try {
      console.error(`[Unity Auth] Retiring token for ${target}...`);

      const payload = {
        Token: token,
        Appname: unityConfig.appName
      };

      await axios.post(
        unityEndpoints.retireToken,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      // Clear from cache
      const tokenCacheKey = `${this.TOKEN_CACHE_KEY_PREFIX}${target}`;
      const userAuthCacheKey = `${this.USER_AUTH_CACHE_KEY_PREFIX}${target}_${token}`;
      
      this.tokenCache.del(tokenCacheKey);
      this.userAuthCache.del(userAuthCacheKey);

      console.error(`[Unity Auth] Token retired successfully for ${target}`);
      return true;
    } catch (error) {
      console.error('[Unity Auth] Token retirement failed:', error);
      return false;
    }
  }

  /**
   * Get a fully authenticated session (token + user auth)
   * This is the primary method to use before making Unity API calls
   */
  async getAuthenticatedSession(target: UnityTargetSystem = 'EHR'): Promise<{
    token: string;
    userAuth: UserAuthResult;
  }> {
    // Get security token
    const token = await this.getSecurityToken(target);
    
    // Authenticate user
    const userAuth = await this.authenticateUser(token, target);
    
    if (!userAuth.authenticated) {
      throw new Error(`User authentication failed: ${userAuth.error}`);
    }

    return { token, userAuth };
  }

  /**
   * Clear all cached tokens and authentication
   */
  clearCache(): void {
    this.tokenCache.flushAll();
    this.userAuthCache.flushAll();
    console.error('[Unity Auth] Cache cleared');
  }

  /**
   * Check if a token is cached for the target system
   */
  isTokenCached(target: UnityTargetSystem = 'EHR'): boolean {
    const cacheKey = `${this.TOKEN_CACHE_KEY_PREFIX}${target}`;
    return this.tokenCache.has(cacheKey);
  }

  /**
   * Get token cache info for debugging
   */
  getTokenInfo(target: UnityTargetSystem = 'EHR'): { cached: boolean; ttl?: number } {
    const cacheKey = `${this.TOKEN_CACHE_KEY_PREFIX}${target}`;
    const ttl = this.tokenCache.getTtl(cacheKey);
    
    return {
      cached: this.tokenCache.has(cacheKey),
      ttl: ttl ? Math.floor((ttl - Date.now()) / 1000) : undefined
    };
  }
}

