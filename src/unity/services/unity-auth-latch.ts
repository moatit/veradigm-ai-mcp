import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { UnityTargetSystem } from '../config/unity-endpoints';
import { errorSummary } from '../../utils/safe-log';

/** A system whose sign-in Veradigm refused: no login is sent for it until an operator retries or the credentials change. */
export interface AuthLatch {
  target: UnityTargetSystem;
  stage: 'GetToken' | 'GetUserAuthentication';
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
 */
export class AuthLatchStore {
  private data: Persisted = { salt: '', latches: [] };
  private stamp = '';
  private fps = new Map<string, string>();

  /** `credentials(target)`: the values the fingerprint covers (read when needed, never stored). */
  constructor(
    private readonly credentials: (target: UnityTargetSystem) => string[],
    private readonly dir: string = process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data')
  ) {}

  private file(): string {
    return this.dir ? path.join(this.dir, 'unity-auth-latch.json') : '';
  }

  /** Re-read the file when another process (or an operator) changed it. Cheap: one stat per call. */
  private sync(): void {
    const f = this.file();
    if (!f) return;
    let stamp = '';
    try {
      const s = fs.statSync(f);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch {
      stamp = 'none';
    }
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.data = { salt: this.data.salt, latches: [] };
    if (stamp === 'none') return;
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (d && typeof d.salt === 'string' && Array.isArray(d.latches)) this.data = { salt: d.salt, latches: d.latches.slice(-MAX_ENTRIES) };
    } catch (e) {
      console.error(`[Unity Auth] sign-in latch file unreadable: ${errorSummary(e)}`);
    }
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
