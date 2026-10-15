import axios, { AxiosResponse } from 'axios';
import NodeCache from 'node-cache';
import { unityConfig } from '../config/environment';
import { getUbiquityId, unityEndpoints, UnityActions, UnityTargetSystem } from '../config/unity-endpoints';
import { errorSummary } from '../../utils/safe-log';

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

/** GetToken, GetUserAuthentication and RetireToken give up after this long (UNITY_AUTH_TIMEOUT_MS, default 30 s). */
export function authTimeoutMs(): number {
  const n = Number(process.env.UNITY_AUTH_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 30_000;
}

/**
 * Seconds a token is reused: UNITY_TOKEN_CACHE_TTL minus UNITY_TOKEN_REFRESH_BUFFER (at least 60),
 * so a token is replaced before Unity's 20-minute inactivity expiry rather than at it.
 */
export function tokenLifetimeSeconds(ttl = unityConfig.tokenCacheTtl, buffer = unityConfig.tokenRefreshBuffer): number {
  const t = Number.isFinite(ttl) && ttl > 0 ? ttl : 1140;
  const b = Number.isFinite(buffer) && buffer >= 0 ? buffer : 60;
  return Math.max(60, t - b);
}

/** Unity's answer says the security token itself is bad (expired, retired, unknown): a fresh token may work. */
export function isTokenRejection(message: unknown): boolean {
  const m = String(message || '');
  return /\btoken\b[^.]{0,40}\b(invalid|expired|not valid|unknown|retired|not found)\b|\b(invalid|expired|unknown|retired)\b[^.]{0,40}\btoken\b/i.test(m);
}

/**
 * One line for an auth failure: HTTP status, error code and a short message. Never the axios error
 * itself: its config carries the request body (service password, EHR/PM user password, token).
 */
export function authErrorSummary(error: unknown): string {
  return errorSummary(error);
}

/**
 * Unity Authentication Service
 *
 * Handles Unity API authentication including:
 * - GetToken: Obtain security token using Unity service credentials
 * - GetUserAuthentication: Authenticate EHR/PM user (required before other actions)
 * - RetireToken: Invalidate security token
 *
 * Concurrent callers share one GetToken / GetUserAuthentication per target (single flight), and
 * invalidate() drops a token Unity no longer accepts so the next call logs in again.
 */
export class UnityAuthService {
  private tokenCache: NodeCache;
  private userAuthCache: NodeCache;
  private inflight = new Map<string, Promise<any>>();

  private readonly TOKEN_CACHE_KEY_PREFIX = 'unity_token_';
  private readonly USER_AUTH_CACHE_KEY_PREFIX = 'user_auth_';

  constructor() {
    // Token cache: entries are set with tokenLifetimeSeconds(), a little less than Unity's 20-minute expiry
    this.tokenCache = new NodeCache({
      stdTTL: tokenLifetimeSeconds(),
      checkperiod: 60
    });

    // User auth cache - tied to token lifetime
    this.userAuthCache = new NodeCache({
      stdTTL: tokenLifetimeSeconds(),
      checkperiod: 60
    });
  }

  /** Run fn once per key at a time: concurrent callers wait for the same promise. */
  private singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
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
      return cachedToken;
    }

    return this.singleFlight(`token_${target}`, async () => {
      const token = await this.requestNewToken(target);
      this.tokenCache.set(cacheKey, token, tokenLifetimeSeconds());
      return token;
    });
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

      const response: AxiosResponse<string> = await axios.post(
        unityEndpoints.getToken,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: authTimeoutMs()
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
      // Status, code and message only: the axios error holds the request body with the service password.
      console.error(`[Unity Auth] Token request failed for ${target}: ${authErrorSummary(error)}`);

      if (axios.isAxiosError(error)) {
        const authError = error.response?.data as UnityAuthError;
        throw new Error(
          `Unity authentication failed: ${authError?.error || error.message}`
        );
      }

      throw new Error(`Unity authentication failed: ${error instanceof Error ? error.message : String(error)}`);
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
      return cachedAuth;
    }

    const login = unityLogin(target);
    if (!login.user || !login.password || /^placeholder/i.test(login.user)) {
      // No credentials for this system: refuse locally instead of sending a login that would fail
      // (repeated failed logins can lock the shared sandbox account).
      return { authenticated: false, error: `${target} user not configured (set UNITY_${target}_USERNAME/PASSWORD)` };
    }

    return this.singleFlight(`user_${target}_${token}`, async () => {
      try {
        console.error(`[Unity Auth] Authenticating EHR/PM user for ${target}...`);

        // Call GetUserAuthentication via MagicJson
        const payload = {
          Action: UnityActions.Auth.GET_USER_AUTHENTICATION,
          Appname: unityConfig.appName,
          AppUserID: login.user,
          PatientID: '',
          Token: token,
          Parameter1: login.password, // Password goes in Parameter1
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
            },
            timeout: authTimeoutMs()
          }
        );

        // Parse response - successful auth returns user info
        const result = this.parseAuthResponse(response.data);

        if (result.authenticated) {
          // Cache successful authentication
          this.userAuthCache.set(cacheKey, result, tokenLifetimeSeconds());
          console.error(`[Unity Auth] User authenticated successfully for ${target}`);
        } else {
          console.error(`[Unity Auth] User authentication failed for ${target}: ${String(result.error || '').slice(0, 160)}`);
        }

        return result;
      } catch (error) {
        // Status, code and message only: the axios error holds the request body with the user's password.
        console.error(`[Unity Auth] User authentication error for ${target}: ${authErrorSummary(error)}`);

        return {
          authenticated: false,
          error: axios.isAxiosError(error)
            ? error.response?.data?.Error || error.message
            : String(error)
        };
      }
    });
  }

  /**
   * Parse GetUserAuthentication response
   */
  private parseAuthResponse(data: any): UserAuthResult {
    // Unity wraps results: [{ "Error": ... }] or [{ "getuserauthenticationinfo": [{ ValidUser, ErrorMessage, ... }] }]
    const first = Array.isArray(data) ? data[0] : data;
    if (first?.Error) {
      return { authenticated: false, error: String(first.Error) };
    }
    const info = first?.getuserauthenticationinfo?.[0];
    if (info) {
      if (String(info.ValidUser).toUpperCase() !== 'YES') {
        // Wrong or expired EHR/PM user password (or locked account): never treat as logged in.
        return {
          authenticated: false,
          error: `${info.ErrorMessage || 'EHR/PM user not valid'}${String(info.Lockout).toUpperCase() === 'YES' ? ' (account locked)' : ''}`
        };
      }
      return { authenticated: true, userId: info.UserID || info.ProviderID, userName: info.UserName || '' };
    }

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
    // Forget it locally first: a retired token must never be handed out again, even if the call fails.
    this.invalidate(target, token);
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
          },
          timeout: authTimeoutMs()
        }
      );

      console.error(`[Unity Auth] Token retired successfully for ${target}`);
      return true;
    } catch (error) {
      console.error(`[Unity Auth] Token retirement failed for ${target}: ${authErrorSummary(error)}`);
      return false;
    }
  }

  /**
   * Drop the cached token and user login for a target (after Unity rejected them), so the next
   * call starts with GetToken + GetUserAuthentication. With `token`, only if that is still the cached one.
   */
  invalidate(target: UnityTargetSystem, token?: string): void {
    const tokenCacheKey = `${this.TOKEN_CACHE_KEY_PREFIX}${target}`;
    const cached = this.tokenCache.get<string>(tokenCacheKey);
    if (!token || cached === token) this.tokenCache.del(tokenCacheKey);
    const t = token || cached;
    if (t) this.userAuthCache.del(`${this.USER_AUTH_CACHE_KEY_PREFIX}${target}_${t}`);
  }

  /**
   * Get a fully authenticated session (token + user auth)
   * This is the primary method to use before making Unity API calls
   *
   * When GetUserAuthentication says the cached token is no good, the token is dropped and the
   * login runs once more with a fresh one. A wrong password is never retried (it can lock the account).
   */
  async getAuthenticatedSession(target: UnityTargetSystem = 'EHR'): Promise<{
    token: string;
    userAuth: UserAuthResult;
  }> {
    for (let attempt = 0; ; attempt++) {
      // Get security token
      const token = await this.getSecurityToken(target);

      // Authenticate user
      const userAuth = await this.authenticateUser(token, target);
      if (userAuth.authenticated) {
        return { token, userAuth };
      }
      if (attempt === 0 && isTokenRejection(userAuth.error)) {
        console.error(`[Unity Auth] ${target} token rejected at login; getting a new token`);
        this.invalidate(target, token);
        continue;
      }
      throw new Error(`User authentication failed: ${userAuth.error}`);
    }
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

  /** The cached token for a target, without requesting one (shutdown: retire only what exists). */
  cachedToken(target: UnityTargetSystem = 'EHR'): string | undefined {
    return this.tokenCache.get<string>(`${this.TOKEN_CACHE_KEY_PREFIX}${target}`);
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

/** EHR/PM login for a Unity target (AppUserID + password). */
export function unityLogin(target: UnityTargetSystem): { user: string; password: string } {
  return target === 'PM'
    ? { user: unityConfig.pmUsername, password: unityConfig.pmPassword }
    : { user: unityConfig.ehrUsername, password: unityConfig.ehrPassword };
}
