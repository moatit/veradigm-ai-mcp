import * as fs from 'fs';
import * as path from 'path';
import { IntakeStore } from './store';

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
export const SCAN_INTERVAL_MS = 30_000;
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

/** Start the 30 s watcher. Returns a stop function. */
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
  const timer = setInterval(tick, SCAN_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 2_000).unref?.();
  return () => clearInterval(timer);
}
