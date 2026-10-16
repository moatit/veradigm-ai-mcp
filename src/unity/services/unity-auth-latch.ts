import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { UnityTargetSystem } from '../config/unity-endpoints';
import { errorSummary } from '../../utils/safe-log';
import { securityEvent } from '../../platform/security-events';

/** A system whose sign-in Veradigm refused: no login is sent for it until an operator retries or the credentials change. */
export interface AuthLatch {
  target: UnityTargetSystem;
  /** 'unknown': the latch file was unreadable, so every system is treated as refused (fail closed). */
  stage: 'GetToken' | 'GetUserAuthentication' | 'unknown';
  /** Veradigm's reason, short and scrubbed (no account name, dates or long numbers). */
  reason: string;
  at: string;
}

interface Entry extends AuthLatch {
  /** scrypt(credentials, file salt): which credentials were refused. Not reversible; never the password or a plain hash. */
  fp: string;
}

interface Persisted {
  salt: string;
  latches: Entry[];
}

const MAX_ENTRIES = 20;

/**
 * Auth latches, kept in <dir>/unity-auth-latch.json (mode 0600; dir = CALL_RECORDS_DIR, else ./data; '' keeps
 * them in memory only), so a restart, or a crash loop, does not send a refused login again. Every server
 * process that uses the same directory honours the same latch (the file is re-read when it changes).
 *
 * A latch applies only to the credentials that were refused: each entry holds an scrypt fingerprint (random
 * per-file salt) of the service user and password, the Ubiquity ID and the system's EHR/PM user and password.
 * After the credentials change (new .env / SSM values, then a restart) the fingerprint no longer matches and
 * the latch no longer applies. An operator retry removes it.
 *
 * Fail closed: a file whose content can't be parsed (or is not a latch file) is moved aside (unity-auth-latch.json.bad-<time>) and every
 * system is latched (stage 'unknown', security event unity_signin_latched LATCH_FILE_UNREADABLE) until an
 * operator retries. A file that can't be stat'ed or read (EBUSY, EIO, ...) keeps the last known latches and
 * is tried again at the next check. A latch that appears in the file (another process, a fail-closed reload) is reported
 * through onNewLatch, so the status screen turns DOWN at once.
 */
export class AuthLatchStore {
  private data: Persisted = { salt: '', latches: [] };
  private stamp = '';
  private fps = new Map<string, string>();
  private loaded = false;
  private lastIoError = '';
  private newLatch: ((l: AuthLatch) => void) | null = null;

  /** `credentials(target)`: the values the fingerprint covers (read when needed, never stored). */
  constructor(
    private readonly credentials: (target: UnityTargetSystem) => string[],
    private readonly dir: string = process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data')
  ) {}

  private file(): string {
    return this.dir ? path.join(this.dir, 'unity-auth-latch.json') : '';
  }

  /** Called for a latch this process did not set itself (another process, a fail-closed reload). */
  onNewLatch(cb: ((l: AuthLatch) => void) | null): void {
    this.newLatch = cb;
  }

  private mine(): Map<string, AuthLatch> {
    const out = new Map<string, AuthLatch>();
    for (const t of ['PM', 'EHR'] as UnityTargetSystem[]) {
      const e = this.data.latches.find((x) => this.matches(x, t));
      if (e) out.set(`${e.target}|${e.at}|${e.fp}`, { target: e.target, stage: e.stage, reason: e.reason, at: e.at });
    }
    return out;
  }

  /**
   * The file could not be stat'ed or read (EBUSY, EIO, EMFILE, EISDIR, ...): an I/O problem, not bad content.
   * Keep the last known latches and the old stamp, so the next check tries again. Logged once per error code.
   */
  private ioError(op: string, err: unknown): void {
    const code = String((err as any)?.code || 'ERROR');
    if (code === this.lastIoError) return;
    this.lastIoError = code;
    console.error(`[Unity Auth] sign-in latch file ${op} failed (${code}): keeping the last known latches, trying again at the next check`);
  }

  /**
   * Re-read the file when another process (or an operator) changed it. Cheap: one stat per call. Only a
   * missing file (ENOENT) means "no latches"; only bad content (unparseable, not a latch file) fails closed.
   */
  private sync(): void {
    const f = this.file();
    if (!f) return;
    let stamp = '';
    try {
      const s = fs.statSync(f);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch (e: any) {
      if (e?.code !== 'ENOENT') return this.ioError('check', e);
      stamp = 'none';
    }
    if (stamp === this.stamp) return;
    let text = '';
    if (stamp !== 'none') {
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch (e: any) {
        if (e?.code !== 'ENOENT') return this.ioError('read', e);
        stamp = 'none'; // removed between the check and the read
      }
    }
    this.lastIoError = '';
    const before = this.loaded && this.data.latches.length ? this.mine() : new Map<string, AuthLatch>();
    this.stamp = stamp;
    this.data = { salt: this.data.salt, latches: [] };
    if (stamp !== 'none') {
      try {
        const d = JSON.parse(text);
        const valid =
          d && typeof d.salt === 'string' && /^[0-9a-f]{32}$/.test(d.salt) && Array.isArray(d.latches) &&
          d.latches.every((e: any) => e && (e.target === 'PM' || e.target === 'EHR') && typeof e.fp === 'string' && /^[0-9a-f]{64}$/.test(e.fp));
        if (!valid) throw new Error('not a latch file');
        this.data = { salt: d.salt, latches: d.latches.slice(-MAX_ENTRIES) };
      } catch (e) {
        this.failClosed(f, e);
      }
    }
    const wasLoaded = this.loaded;
    this.loaded = true;
    if (!wasLoaded || !this.newLatch) return;
    for (const [key, l] of this.mine()) {
      if (before.has(key)) continue;
      try {
        this.newLatch(l);
      } catch {
        // never into the caller
      }
    }
  }

  /** Unreadable latch file: we can't tell what was refused, so latch every system until an operator retries. */
  private failClosed(f: string, err: unknown): void {
    console.error(`[Unity Auth] sign-in latch file unreadable (${errorSummary(err, 80)}): every Veradigm sign-in is STOPPED until an operator retries (docs/drawbridge/VERADIGM_SIGNIN_LATCH.md)`);
    try {
      fs.renameSync(f, `${f}.bad-${Date.now()}`);
    } catch {
      // left in place; the latches below still hold in memory
    }
    this.data = { salt: randomBytes(16).toString('hex'), latches: [] };
    const at = new Date().toISOString();
    for (const target of ['PM', 'EHR'] as UnityTargetSystem[]) {
      this.data.latches.push({ target, stage: 'unknown', reason: 'latch file unreadable', at, fp: this.fingerprint(target) });
    }
    this.save();
    securityEvent('unity_signin_latched', { code: 'LATCH_FILE_UNREADABLE', object: 'unity-auth-latch.json', channel: 'veradigm' });
  }

  private save(): void {
    const f = this.file();
    if (!f) return;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, f);
      const s = fs.statSync(f);
      this.stamp = `${s.mtimeMs}:${s.size}`;
    } catch (e) {
      console.error(`[Unity Auth] sign-in latch not saved: ${errorSummary(e)}`);
    }
  }

  private fingerprint(target: UnityTargetSystem): string {
    if (!this.data.salt) this.data.salt = randomBytes(16).toString('hex');
    const key = `${this.data.salt}|${target}`;
    let fp = this.fps.get(key);
    if (!fp) {
      const material = ['drawbridge-unity-latch-v1', target, ...this.credentials(target)].join('\u0000');
      fp = scryptSync(material, Buffer.from(this.data.salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
      this.fps.set(key, fp);
    }
    return fp;
  }

  private matches(e: Entry, target: UnityTargetSystem): boolean {
    if (e.target !== target || typeof e.fp !== 'string' || e.fp.length !== 64) return false;
    return timingSafeEqual(Buffer.from(e.fp, 'hex'), Buffer.from(this.fingerprint(target), 'hex'));
  }

  get(target: UnityTargetSystem): AuthLatch | undefined {
    this.sync();
    if (!this.data.latches.length) return undefined;
    const e = this.data.latches.find((x) => this.matches(x, target));
    return e ? { target: e.target, stage: e.stage, reason: e.reason, at: e.at } : undefined;
  }

  set(latch: AuthLatch): void {
    this.sync();
    const fp = this.fingerprint(latch.target);
    this.data.latches = [...this.data.latches.filter((x) => !this.matches(x, latch.target)), { ...latch, fp }].slice(-MAX_ENTRIES);
    this.save();
  }

  /** Remove this process's latch for a target. True when there was one. */
  clear(target: UnityTargetSystem): boolean {
    this.sync();
    const before = this.data.latches.length;
    this.data.latches = this.data.latches.filter((x) => !this.matches(x, target));
    if (this.data.latches.length === before) return false;
    this.save();
    return true;
  }
}
