import axios, { AxiosResponse } from 'axios';
import NodeCache from 'node-cache';
import { unityConfig } from '../config/environment';
import { getUbiquityId, isCertifiedAction, unityEndpoints, UnityActions, UnityTargetSystem } from '../config/unity-endpoints';
import { errorSummary } from '../../utils/safe-log';
import { securityEvent } from '../../platform/security-events';
import { scrubLogText } from './unity-diagnostics';
import { AuthLatch, AuthLatchStore } from './unity-auth-latch';

export type { AuthLatch } from './unity-auth-latch';
export type LatchOrigin = 'refused' | 'file';

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
  /** Veradigm refused the login itself: ValidUser != YES, or an error reply that says access is denied. */
  rejected?: boolean;
  /** Refused because of the token (a token error, or a plain HTTP 401): one retry with a fresh token. */
  tokenRefused?: boolean;
}

/** GetToken, GetUserAuthentication and RetireToken give up after this long (UNITY_AUTH_TIMEOUT_MS, default 30 s). */
export function authTimeoutMs(): number {
  const n = Number(process.env.UNITY_AUTH_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 30_000;
}

/**
 * Hard deadline for one GetToken / GetUserAuthentication / RetireToken request. axios' `timeout` only fires
 * when the connection goes idle, so a reply that trickles in forever would otherwise hold the per-system
 * login queue; the abort ends it after UNITY_AUTH_TIMEOUT_MS whatever the server does.
 */
export function authDeadline(): AbortSignal {
  return AbortSignal.timeout(authTimeoutMs());
}

/** The request was aborted by authDeadline (or axios gave up): reported as a timeout, never a refusal. */
function timedOut(error: unknown): boolean {
  const e = error as any;
  return e?.code === 'ERR_CANCELED' || e?.code === 'ECONNABORTED' || e?.name === 'CanceledError' || e?.name === 'AbortError' || e?.name === 'TimeoutError';
}

/** HTTP 401 with no denial text: usually a stale or not-yet-valid token, worth one try with a fresh token. */
function plainUnauthorized(error: unknown): boolean {
  const e = error as any;
  return Number(e?.response?.status) === 401 && !isDenialText(faultText(e.response.data) || (typeof e.response.data === 'string' ? e.response.data : ''));
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
  return scrubAuthText(errorSummary(error), 200);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Veradigm refusal text made safe for logs, thrown errors and the agent: the configured service, EHR and PM
 * account names and any "prefix^n^user" account become [account]; e-mail addresses, dates and long numbers
 * are masked (scrubLogText).
 */
export function scrubAuthText(text: unknown, max = 160): string {
  let s = String(text ?? '').replace(/[A-Za-z0-9]+\^\d+\^[^\s,;()]+/g, '[account]');
  for (const name of [unityConfig.svcUsername, unityConfig.ehrUsername, unityConfig.pmUsername]) {
    const n = String(name || '').trim();
    if (n.length >= 3) s = s.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(n)}(?![A-Za-z0-9])`, 'gi'), '[account]');
  }
  return scrubLogText(s, max);
}

/** Text that says the credentials were refused (not a token problem, not an outage). */
export function isDenialText(text: unknown): boolean {
  return /access is denied|invalid (user ?name|password|credential)|(user ?name|password|credentials?)[^.]{0,30}(invalid|incorrect|not valid|expired)|not authori[sz]ed|account (is )?locked|locked out/i.test(String(text || ''));
}

/** The message of a JSON or WCF/SOAP fault body; '' for anything else (an HTML error page, a proxy's text). */
function faultText(data: unknown): string {
  if (data && typeof data === 'object') {
    const d = data as any;
    return String(d.error || d.Error || d.message || d.Message || d.ExceptionDetail?.Message || d.Fault?.Reason || '');
  }
  const s = typeof data === 'string' ? data.trim() : '';
  if (/^[{[]/.test(s)) {
    try {
      const j = JSON.parse(s);
      return faultText(Array.isArray(j) ? j[0] : j);
    } catch {
      return '';
    }
  }
  if (/^</.test(s) && /Fault\b/i.test(s) && !/<html/i.test(s)) {
    const m = s.match(/<(?:\w+:)?(?:faultstring|Text|Message)\b[^>]*>([^<]{1,300})</i);
    return m ? m[1] : '';
  }
  return '';
}

/**
 * Veradigm refused the credentials and a retry will not fix it: HTTP 401/403 (Ubiquity), or a JSON/WCF fault
 * that says access is denied or the credentials are invalid (on any status: a WCF fault can come back as HTTP
 * 500; on a 4xx a short plain-text answer counts too). No HTTP answer (network error, timeout), 408, 429, an
 * HTML error page and a 5xx without such a fault are transient: never latched.
 */
export function isCredentialRejection(error: unknown): boolean {
  const e = error as any;
  const status = Number(e?.response?.status) || 0;
  if (!status || status === 408 || status === 429) return false;
  if (status === 401 || status === 403) return true;
  const data = e.response.data;
  const plain = status < 500 && typeof data === 'string' && !/^\s*</.test(data) ? data.slice(0, 300) : '';
  return isDenialText(faultText(data) || plain);
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
 * invalidate() drops a token Unity no longer accepts so the next call logs in again. All logins of one
 * system (GetToken and GetUserAuthentication, from tools, keep-warm or the health probe) run one at a time,
 * and each checks the latch again before it is sent, so two refused logins can never go out together.
 *
 * Auth latch: when Veradigm refuses a sign-in for a reason a retry will not fix (GetUserAuthentication
 * ValidUser != YES or a denial reply, a GetToken denial: isCredentialRejection, or a token still refused
 * after the one fresh-token retry), that target is latched. While latched every caller (health probe,
 * keep-warm, phone-agent tools, intake, staff screens) gets an immediate local AUTH_ERROR and nothing is sent
 * to Veradigm, so repeated logins can't lock the account. The latch is saved (AuthLatchStore,
 * unity-auth-latch.ts), so a restart or a crash loop does not try again; it no longer applies once the
 * credentials change, and an operator clears it with retrySignIn ("Veradigm connection" screen). Engaging
 * it is a security event (unity_signin_latched) and calls the onLatch hook once (server: help-desk alert);
 * a retry is a security event too (unity_signin_retry). Network errors, timeouts and 5xx never latch.
 * Runbook: docs/drawbridge/VERADIGM_SIGNIN_LATCH.md.
 */
export class UnityAuthService {
  private tokenCache: NodeCache;
  private userAuthCache: NodeCache;
  private inflight = new Map<string, Promise<any>>();
  private loginQueue = new Map<UnityTargetSystem, Promise<unknown>>();
  private latches: AuthLatchStore;
  private latchHook: ((latch: AuthLatch, origin: LatchOrigin) => unknown) | null = null;

  private readonly TOKEN_CACHE_KEY_PREFIX = 'unity_token_';
  private readonly USER_AUTH_CACHE_KEY_PREFIX = 'user_auth_';

  /** `latchDir`: where the latch file lives (default CALL_RECORDS_DIR, else ./data; '' = memory only). */
  constructor(opts: { latchDir?: string } = {}) {
    this.latches = new AuthLatchStore(latchCredentials, opts.latchDir);
    // A latch found in the file (set by another process, or the fail-closed reload of an unreadable file):
    // same effect here at once (cached token dropped, hook: status DOWN), no second security event.
    this.latches.onNewLatch((l) => {
      this.invalidate(l.target);
      console.error(`[Unity Auth] ${l.target} sign-in STOPPED (found in the latch file: ${l.stage}, ${l.reason})`);
      this.callHook(l, 'file');
    });
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
   * One login request per system at a time (GetToken and GetUserAuthentication alike), in arrival order.
   * Every request has a hard deadline (authDeadline); as a second guard, a waiting request never waits more
   * than that deadline plus 5 s for the one before it, so the queue can't stay blocked.
   */
  private oneLoginAtATime<T>(target: UnityTargetSystem, fn: () => Promise<T>): Promise<T> {
    const before = this.loginQueue.get(target) || Promise.resolve();
    const prev = new Promise<void>((resolve) => {
      const guard = setTimeout(resolve, authTimeoutMs() + 5_000);
      guard.unref?.();
      const done = () => {
        clearTimeout(guard);
        resolve();
      };
      before.then(done, done);
    });
    const run = prev.then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.loginQueue.set(target, tail);
    void tail.then(() => {
      if (this.loginQueue.get(target) === tail) this.loginQueue.delete(target);
    });
    return run;
  }

  /**
   * Register the latch hook (server: mark the system DOWN, which sends the help-desk alert). Must not throw.
   * `origin` is 'refused' when Veradigm refused a login in this process, 'file' when the latch was found in the
   * shared latch file (another process latched it, or the file was unreadable).
   */
  onLatch(hook: ((latch: AuthLatch, origin: LatchOrigin) => unknown) | null): void {
    this.latchHook = hook;
  }

  private callHook(l: AuthLatch, origin: LatchOrigin): void {
    try {
      Promise.resolve(this.latchHook?.(l, origin)).catch(() => undefined);
    } catch {
      // alerting must never break the caller
    }
  }

  /** The latch for a target, if Veradigm refused its sign-in with the credentials configured now. */
  latched(target: UnityTargetSystem): AuthLatch | undefined {
    return this.latches.get(target);
  }

  latchedTargets(): AuthLatch[] {
    return (['PM', 'EHR'] as UnityTargetSystem[]).map((t) => this.latches.get(t)).filter((l): l is AuthLatch => !!l);
  }

  private latch(target: UnityTargetSystem, stage: AuthLatch['stage'], reason: unknown): void {
    if (this.latches.get(target)) return;
    const clean = scrubAuthText(reason, 100) || 'refused';
    const l: AuthLatch = { target, stage, reason: clean, at: new Date().toISOString() };
    this.latches.set(l);
    // No cached token for a latched system is used or retired.
    this.invalidate(target);
    console.error(`[Unity Auth] ${target} sign-in STOPPED: Veradigm refused ${stage} (${clean}). No login is sent for ${target} until an operator retries sign-in or the credentials change. Runbook: docs/drawbridge/VERADIGM_SIGNIN_LATCH.md`);
    securityEvent('unity_signin_latched', { code: target, object: `veradigm_${target.toLowerCase()}:${stage}`, channel: 'veradigm' });
    this.callHook(l, 'refused');
  }

  /** Local AUTH_ERROR for a latched target (nothing is sent to Veradigm). */
  private assertNotLatched(target: UnityTargetSystem): void {
    const l = this.latches.get(target);
    if (!l) return;
    throw Object.assign(new Error(`Unity authentication failed: ${target} sign-in stopped after Veradigm refused ${l.stage} (${l.reason}); retry sign-in after fixing the credentials`), { code: 'AUTH_ERROR' });
  }

  /**
   * Operator: clear the latch for one target (or both) so the next call signs in again. Returns the targets
   * cleared. `user` is the operator (log line and security event unity_signin_retry).
   */
  retrySignIn(target?: UnityTargetSystem, user = 'operator'): UnityTargetSystem[] {
    const cleared = (['PM', 'EHR'] as UnityTargetSystem[]).filter((t) => (!target || t === target) && this.latches.clear(t));
    for (const t of cleared) {
      this.invalidate(t);
      console.error(`[Unity Auth] ${t} sign-in retry requested by ${String(user).slice(0, 60)}; the next call signs in again`);
      securityEvent('unity_signin_retry', { user, code: t, object: `veradigm_${t.toLowerCase()}`, channel: 'veradigm' });
    }
    return cleared;
  }

  /**
   * Get a valid security token for the specified target system
   * Tokens are cached and reused until near expiry
   */
  async getSecurityToken(target: UnityTargetSystem = 'EHR'): Promise<string> {
    this.assertNotLatched(target);
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
   *
   * One login per system at a time; the latch is checked again once it is this request's turn.
   */
  private async requestNewToken(target: UnityTargetSystem): Promise<string> {
    this.assertNotLatched(target);
    return this.oneLoginAtATime(target, () => this.sendGetToken(target));
  }

  private async sendGetToken(target: UnityTargetSystem): Promise<string> {
    this.assertNotLatched(target);
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
          timeout: authTimeoutMs(),
          signal: authDeadline()
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

      if (timedOut(error)) throw new Error(`Unity authentication failed: GetToken timeout after ${authTimeoutMs()} ms`);
      if (axios.isAxiosError(error)) {
        const authError = error.response?.data as UnityAuthError;
        const reason = scrubAuthText(authError?.error || error.message);
        // Bad service credentials / access denied: stop here (no retry can fix it; retries can lock the account).
        if (isCredentialRejection(error)) this.latch(target, 'GetToken', reason);
        throw new Error(
          `Unity authentication failed: ${reason}`
        );
      }

      throw new Error(`Unity authentication failed: ${scrubAuthText(error instanceof Error ? error.message : String(error))}`);
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

    const stopped = this.latches.get(target);
    if (stopped) {
      return { authenticated: false, error: `${target} sign-in stopped after Veradigm refused ${stopped.stage} (${stopped.reason})` };
    }

    const login = unityLogin(target);
    if (!login.user || !login.password || /^placeholder/i.test(login.user)) {
      // No credentials for this system: refuse locally instead of sending a login that would fail
      // (repeated failed logins can lock the shared sandbox account).
      return { authenticated: false, error: `${target} user not configured (set UNITY_${target}_USERNAME/PASSWORD)` };
    }

    // One login per system at a time; once it is this login's turn the latch is checked again (another
    // login may just have been refused), so two refused logins never go out together.
    return this.singleFlight(`user_${target}_${token}`, () => this.oneLoginAtATime(target, async (): Promise<UserAuthResult> => {
      const refused = this.latches.get(target);
      if (refused) return { authenticated: false, error: `${target} sign-in stopped after Veradigm refused ${refused.stage} (${refused.reason})` };
      if (!isCertifiedAction(UnityActions.Auth.GET_USER_AUTHENTICATION)) {
        return { authenticated: false, error: `${UnityActions.Auth.GET_USER_AUTHENTICATION} is not a declared Veradigm action (UNITY_ACTION_GET_USER_AUTHENTICATION)` };
      }
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
            timeout: authTimeoutMs(),
            signal: authDeadline()
          }
        );

        // Parse response - successful auth returns user info
        const result = this.parseAuthResponse(response.data);

        if (result.authenticated) {
          // Cache successful authentication
          this.userAuthCache.set(cacheKey, result, tokenLifetimeSeconds());
          console.error(`[Unity Auth] User authenticated successfully for ${target}`);
        } else {
          // ValidUser != YES or a denial reply: wrong/expired password or locked account. Stop (a token
          // problem is retried once with a fresh token instead).
          if (result.rejected && !isTokenRejection(result.error)) this.latch(target, 'GetUserAuthentication', result.error);
          result.error = scrubAuthText(result.error);
          console.error(`[Unity Auth] User authentication failed for ${target}: ${result.error}`);
        }

        return result;
      } catch (error) {
        // Status, code and message only: the axios error holds the request body with the user's password.
        console.error(`[Unity Auth] User authentication error for ${target}: ${authErrorSummary(error)}`);
        if (timedOut(error)) return { authenticated: false, error: `GetUserAuthentication timeout after ${authTimeoutMs()} ms` };
        const said = axios.isAxiosError(error) ? error.response?.data?.Error || error.message : String(error);
        // A plain 401 (or a token error) may be a stale token: the caller retries once with a fresh one.
        const tokenRefused = plainUnauthorized(error) || isTokenRejection(said);
        // HTTP 403 or a denial fault (not a token problem): refused, stop.
        if (!tokenRefused && isCredentialRejection(error)) this.latch(target, 'GetUserAuthentication', said);

        return {
          authenticated: false,
          error: scrubAuthText(said),
          tokenRefused
        };
      }
    }));
  }

  /**
   * Parse GetUserAuthentication response
   */
  private parseAuthResponse(data: any): UserAuthResult {
    // Unity wraps results: [{ "Error": ... }] or [{ "getuserauthenticationinfo": [{ ValidUser, ErrorMessage, ... }] }]
    const first = Array.isArray(data) ? data[0] : data;
    if (first?.Error) {
      const error = String(first.Error);
      return { authenticated: false, error, rejected: isDenialText(error) && !isTokenRejection(error), tokenRefused: isTokenRejection(error) };
    }
    const info = first?.getuserauthenticationinfo?.[0];
    if (info) {
      if (String(info.ValidUser).toUpperCase() !== 'YES') {
        // Wrong or expired EHR/PM user password (or locked account): never treat as logged in.
        return {
          authenticated: false,
          rejected: true,
          error: `${info.ErrorMessage || 'EHR/PM user not valid'}${String(info.Lockout).toUpperCase() === 'YES' ? ' (account locked)' : ''}`
        };
      }
      return { authenticated: true, userId: info.UserID || info.ProviderID, userName: info.UserName || '' };
    }

    // Check for error in response
    if (data?.Error) {
      const error = String(data.Error);
      return { authenticated: false, error, rejected: isDenialText(error) && !isTokenRejection(error), tokenRefused: isTokenRejection(error) };
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
          timeout: authTimeoutMs(),
          signal: authDeadline()
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
      const tokenRefused = userAuth.tokenRefused || isTokenRejection(userAuth.error);
      if (attempt === 0 && tokenRefused) {
        console.error(`[Unity Auth] ${target} token refused at login; getting a new token`);
        this.invalidate(target, token);
        continue;
      }
      // A brand-new token refused as well: not a stale token, so stop like any other refusal.
      if (attempt > 0 && tokenRefused) this.latch(target, 'GetUserAuthentication', userAuth.error);
      throw new Error(`User authentication failed: ${userAuth.error}`);
    }
  }

  /**
   * Keep-warm: log in again now (GetToken + GetUserAuthentication) and swap the cached session only
   * when both succeed, so callers keep using the current token meanwhile and never wait for a login.
   * The replaced token simply expires on Veradigm's side. A failure leaves the cache as it was.
   */
  async refreshSession(target: UnityTargetSystem = 'EHR'): Promise<boolean> {
    return this.singleFlight(`refresh_${target}`, async () => {
      for (let attempt = 0; ; attempt++) {
        const token = await this.requestNewToken(target);
        const auth = await this.authenticateUser(token, target);
        if (auth.authenticated) {
          this.tokenCache.set(`${this.TOKEN_CACHE_KEY_PREFIX}${target}`, token, tokenLifetimeSeconds());
          return true;
        }
        // Same rule as getAuthenticatedSession: one more fresh token, then a refused token is a refusal.
        const tokenRefused = auth.tokenRefused || isTokenRejection(auth.error);
        if (attempt === 0 && tokenRefused) continue;
        if (tokenRefused) this.latch(target, 'GetUserAuthentication', auth.error);
        throw new Error(`User authentication failed: ${auth.error}`);
      }
    });
  }

  /** Seconds until the cached token for a target is replaced (undefined when none is cached). */
  tokenSecondsLeft(target: UnityTargetSystem = 'EHR'): number | undefined {
    const ttl = this.tokenCache.getTtl(`${this.TOKEN_CACHE_KEY_PREFIX}${target}`);
    return ttl ? Math.max(0, Math.floor((ttl - Date.now()) / 1000)) : undefined;
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

/** Targets with a usable EHR/PM login (PM is optional; calls to an unconfigured target are refused locally). */
export function configuredTargets(): UnityTargetSystem[] {
  return (['PM', 'EHR'] as UnityTargetSystem[]).filter((t) => {
    const l = unityLogin(t);
    return !!l.user && !!l.password && !/^placeholder/i.test(l.user);
  });
}

/** What the sign-in latch fingerprint covers for a target (AuthLatchStore keeps only an scrypt of it). */
function latchCredentials(target: UnityTargetSystem): string[] {
  const l = unityLogin(target);
  return [unityConfig.svcUsername, unityConfig.svcPassword, getUbiquityId(target), l.user, l.password];
}

/** EHR/PM login for a Unity target (AppUserID + password). */
export function unityLogin(target: UnityTargetSystem): { user: string; password: string } {
  return target === 'PM'
    ? { user: unityConfig.pmUsername, password: unityConfig.pmPassword }
    : { user: unityConfig.ehrUsername, password: unityConfig.ehrPassword };
}

let current: UnityAuthService | null = null;
/** The running server's auth service (staff "Veradigm connection" screen: latch state, retry sign-in). */
export function getUnityAuth(): UnityAuthService | null {
  return current;
}
export function setUnityAuth(a: UnityAuthService | null): void {
  current = a;
}
