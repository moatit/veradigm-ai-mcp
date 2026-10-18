import * as fs from 'fs';
import * as path from 'path';

/**
 * "The intake server is running" marker: <intake dir>/server.alive, touched every 30 s while intake runs.
 * The server keeps items.json in memory, so offline tools that rewrite the store (intake-purge-shadow.ts)
 * refuse to run while the marker is fresh: the server would write its own copy back. It works across
 * containers (a file time, not a process ID). Holds no data: the process start time only.
 */
const FILE = 'server.alive';
export const ALIVE_FRESH_MS = 90_000;

export function startAliveMarker(dir: string): () => void {
  const file = path.join(dir, FILE);
  const touch = () => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, new Date().toISOString(), { mode: 0o600 });
    } catch {
      // the store reports its own disk errors
    }
  };
  touch();
  const timer = setInterval(touch, 30_000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  };
}

/** True while an intake server has touched the marker within ALIVE_FRESH_MS. */
export function serverRunning(dir: string, now = Date.now()): boolean {
  try {
    return now - fs.statSync(path.join(dir, FILE)).mtimeMs < ALIVE_FRESH_MS;
  } catch {
    return false;
  }
}
