import * as fs from 'fs';
import * as path from 'path';
import { IntakeStore } from './store';
import { envSeconds } from '../../clinic';

/**
 * Drop-folder watcher: emailed results, scans and files from other systems.
 *
 *   INTAKE_DROP_DIR       default /app/intake/inbox (dev: bind mount deploy/local/intake, git-ignored)
 *   INTAKE_MAX_FILE_MB    default 25; larger files are left in place
 *
 * Every 30 s: top-level regular files with an allowed extension, untouched for at least 10 s
 * (so half-copied files are skipped), are copied into the intake store and then removed from the
 * inbox. A file whose hash is already in the store is removed as a duplicate. Other files stay put.
 * Logs carry counts only, never file names (they often contain patient names).
 */
export const DROP_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};
/** Folder scan interval: INTAKE_SCAN_INTERVAL_SEC (default 30, at least 5). */
export const scanIntervalMs = (): number => envSeconds('INTAKE_SCAN_INTERVAL_SEC', 30, 5) * 1000;
export const MIN_AGE_MS = 10_000;

export const dropDir = (): string => process.env.INTAKE_DROP_DIR || '/app/intake/inbox';
export function maxFileBytes(): number {
  const mb = Number(process.env.INTAKE_MAX_FILE_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 25) * 1024 * 1024;
}

export interface ScanResult {
  /** New item IDs. */
  added: string[];
  duplicates: number;
  /** Too new, too big, wrong type or unreadable; left in the folder. */
  skipped: number;
}

export function scanDropFolder(store: IntakeStore, dir: string = dropDir(), now: number = Date.now()): ScanResult {
  const out: ScanResult = { added: [], duplicates: 0, skipped: 0 };
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out; // folder not mounted: nothing to do
  }
  const max = maxFileBytes();
  for (const name of names) {
    const mime = DROP_TYPES[path.extname(name).toLowerCase()];
    if (!mime || name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, name);
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || now - st.mtimeMs < MIN_AGE_MS || st.size === 0 || st.size > max) {
        out.skipped++;
        continue;
      }
      const data = fs.readFileSync(full);
      const r = store.addDocument({ source: 'folder', source_ref: `folder:${name}:${st.size}:${Math.round(st.mtimeMs)}`, name, mime, data });
      fs.unlinkSync(full); // the store holds the copy now
      if (r.duplicate) out.duplicates++;
      else out.added.push(r.item.id);
    } catch {
      out.skipped++;
    }
  }
  return out;
}

// ── Watched folders, read in place ───────────────────────────────────────────

/**
 * INTAKE_WATCH_DIRS: folders another system writes to (e.g. the Express Lab results folder),
 * mounted read-only. Unlike the drop folder, nothing in them is ever moved, changed or deleted:
 * each file is copied into the intake store once, in subfolders too (no symlinks, depth ≤ 6).
 *
 *   INTAKE_WATCH_DIRS     comma-separated absolute paths (unset: none)
 *   INTAKE_WATCH_SINCE    optional YYYY-MM-DD: files last changed before this day are ignored
 *   INTAKE_WATCH_MAX      files taken in per scan (default 200; the rest wait for the next scan)
 *
 * A file is known by folder + relative path + size + time (source_ref "watch:..."): known files are
 * only stat'ed, never read again. Same bytes as an earlier item = duplicate (by hash). Logs carry counts only.
 */
export const watchDirs = (): string[] =>
  String(process.env.INTAKE_WATCH_DIRS || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

export function watchSince(): number {
  const v = String(process.env.INTAKE_WATCH_SINCE || '').trim();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Files under `dir` (relative paths, sorted), no symlinks, no dot-entries, at most `depth` levels down. */
export function listFiles(dir: string, depth = 6, rel = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory() && depth > 0) out.push(...listFiles(dir, depth - 1, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

export function scanWatchFolder(
  store: IntakeStore,
  dir: string,
  now: number = Date.now(),
  opts: { since?: number; max?: number; known?: Set<string> } = {}
): ScanResult {
  const out: ScanResult = { added: [], duplicates: 0, skipped: 0 };
  const known = opts.known || new Set(store.list().map((i) => i.source_ref));
  const max = maxFileBytes();
  const cap = opts.max ?? (Number(process.env.INTAKE_WATCH_MAX) > 0 ? Number(process.env.INTAKE_WATCH_MAX) : 200);
  const since = opts.since ?? watchSince();
  let taken = 0;
  for (const rel of listFiles(dir)) {
    const mime = DROP_TYPES[path.extname(rel).toLowerCase()];
    if (!mime) continue;
    if (taken >= cap) break;
    const full = path.join(dir, rel);
    try {
      const st = fs.lstatSync(full);
      const ref = `watch:${path.resolve(dir)}:${rel.split(path.sep).join('/')}:${st.size}:${Math.round(st.mtimeMs)}`;
      if (known.has(ref)) continue;
      if (!st.isFile() || st.mtimeMs < since || now - st.mtimeMs < MIN_AGE_MS || st.size === 0 || st.size > max) {
        out.skipped++;
        continue;
      }
      const data = fs.readFileSync(full); // read only: the original stays as it is
      const r = store.addDocument({ source: 'folder', source_ref: ref, name: path.basename(rel), mime, data });
      known.add(ref);
      taken++;
      if (r.duplicate) out.duplicates++;
      else out.added.push(r.item.id);
    } catch {
      out.skipped++;
    }
  }
  return out;
}

/** Start scanning INTAKE_WATCH_DIRS every 30 s (none set: nothing runs). Returns a stop function. */
export function startWatchFolders(store: () => IntakeStore, onAdded: (id: string) => void, dirs: string[] = watchDirs()): () => void {
  if (!dirs.length) return () => undefined;
  let running = false;
  // Files seen by this process, including same-bytes duplicates (their refs are not in the store).
  const known = new Set<string>();
  const tick = () => {
    if (running) return;
    running = true;
    try {
      const s = store();
      for (const i of s.list()) known.add(i.source_ref);
      for (const dir of dirs) {
        const r = scanWatchFolder(s, dir, Date.now(), { known });
        if (r.added.length || r.duplicates) console.log(`[Intake] watched folder: ${r.added.length} new, ${r.duplicates} duplicate(s)`);
        for (const id of r.added) onAdded(id);
      }
    } catch (e: any) {
      console.error(`[Intake] watched folder scan failed: ${e?.code || e?.name || 'error'}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, scanIntervalMs());
  timer.unref?.();
  setTimeout(tick, 3_000).unref?.();
  return () => clearInterval(timer);
}

/** Start the drop-folder watcher (every INTAKE_SCAN_INTERVAL_SEC, default 30 s). Returns a stop function. */
export function startFolderWatcher(store: () => IntakeStore, onAdded: (id: string) => void, dir: string = dropDir()): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      const r = scanDropFolder(store(), dir);
      if (r.added.length || r.duplicates) {
        console.log(`[Intake] drop folder: ${r.added.length} new, ${r.duplicates} duplicate(s)`);
      }
      for (const id of r.added) onAdded(id);
    } catch (e: any) {
      console.error(`[Intake] drop folder scan failed: ${e?.code || e?.name || 'error'}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, scanIntervalMs());
  timer.unref?.();
  setTimeout(tick, 2_000).unref?.();
  return () => clearInterval(timer);
}
