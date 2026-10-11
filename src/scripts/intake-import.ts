/**
 * Bulk import of old faxes into document intake (shadow mode measurement), at a controlled rate.
 *
 *   npm run intake:import -- --dir <folder> [--rate 20] [--max-pending 50] [--limit N] [--dry-run]
 *   (data-center container: node dist/scripts/intake-import.js --dir /mnt/old-faxes ...)
 *
 * Walks <folder> and its subfolders (no symlinks, no dot-files) for PDF, TIFF, PNG and JPEG files,
 * checks each file's bytes, and copies new ones (by SHA-256) into the intake drop folder
 * (INTAKE_DROP_DIR) as imp-<hash>.<ext>. The running server picks them up from there, as it does any
 * dropped file. The originals are only read: never moved, renamed or changed (mount the folder read-only).
 *
 *   --rate         files per minute (default 20; 0 = as fast as the backlog allows)
 *   --max-pending  wait while the drop folder plus the documents not yet read hold this many (default 50),
 *                  so OCR and matching keep up and the server is never flooded
 *   --limit        stop after this many new files (default: all)
 *   --dry-run      count only
 *
 * Dedupe: by hash against the store (items.json, read only) and the import ledger
 * (<intake dir>/import/ledger.jsonl: hash, size, time; no paths or names). Running it again
 * continues where it stopped. Prints counts only, never file names.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DROP_TYPES, dropDir, listFiles, maxFileBytes } from '../platform/modules/intake/folder';
import { intakeDir, sniffMime } from '../platform/modules/intake/store';

export interface ImportOptions {
  dir: string;
  inbox: string;
  storeDir: string;
  /** Files per minute; 0 = no pacing. */
  rate: number;
  maxPending: number;
  limit: number;
  dryRun: boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Stop asking (tests, SIGINT). */
  stopped?: () => boolean;
}

export interface ImportResult {
  seen: number;
  copied: number;
  duplicates: number;
  unsupported: number;
  too_big: number;
  unreadable: number;
  bytes: number;
}

const EXT_BY_MIME: Record<string, string> = { 'application/pdf': '.pdf', 'image/tiff': '.tif', 'image/png': '.png', 'image/jpeg': '.jpg' };

function readStore(storeDir: string): { shas: Set<string>; open: number } {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(storeDir, 'items.json'), 'utf8'));
    const items: any[] = Array.isArray(rows) ? rows : [];
    return { shas: new Set(items.map((i) => i?.file?.sha256).filter(Boolean)), open: items.filter((i) => i?.status === 'received' || i?.status === 'read').length };
  } catch {
    return { shas: new Set(), open: 0 };
  }
}

function inboxCount(inbox: string): number {
  try {
    return fs.readdirSync(inbox).filter((n) => !n.startsWith('.')).length;
  } catch {
    return 0;
  }
}

function ledgerShas(file: string): Set<string> {
  try {
    return new Set(
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => {
          try {
            return JSON.parse(l).sha256 as string;
          } catch {
            return '';
          }
        })
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

export async function runImport(o: ImportOptions): Promise<ImportResult> {
  const sleep = o.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log || ((l: string) => console.log(l));
  const stopped = o.stopped || (() => false);
  const ledger = path.join(o.storeDir, 'import', 'ledger.jsonl');
  const known = new Set([...readStore(o.storeDir).shas, ...ledgerShas(ledger)]);
  const out: ImportResult = { seen: 0, copied: 0, duplicates: 0, unsupported: 0, too_big: 0, unreadable: 0, bytes: 0 };
  const max = maxFileBytes();
  if (!o.dryRun) {
    fs.mkdirSync(o.inbox, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
  }
  const files = listFiles(o.dir, 12).filter((rel) => DROP_TYPES[path.extname(rel).toLowerCase()]);
  log(`import: ${files.length} candidate file(s)${o.dryRun ? ' (dry run)' : ''}`);
  let lastNote = 0;
  for (const rel of files) {
    if (stopped() || (o.limit > 0 && out.copied >= o.limit)) break;
    out.seen++;
    let data: Buffer;
    try {
      const st = fs.lstatSync(path.join(o.dir, rel));
      if (!st.isFile() || st.size === 0) {
        out.unreadable++;
        continue;
      }
      if (st.size > max) {
        out.too_big++;
        continue;
      }
      data = fs.readFileSync(path.join(o.dir, rel)); // read only
    } catch {
      out.unreadable++;
      continue;
    }
    const mime = sniffMime(data);
    if (!mime) {
      out.unsupported++;
      continue;
    }
    const sha = createHash('sha256').update(data).digest('hex');
    if (known.has(sha)) {
      out.duplicates++;
      continue;
    }
    known.add(sha);
    if (o.dryRun) {
      out.copied++;
      out.bytes += data.length;
      continue;
    }
    // Backpressure: let the server read what it already has.
    for (;;) {
      const pending = inboxCount(o.inbox) + readStore(o.storeDir).open;
      if (pending < o.maxPending || stopped()) break;
      if (Date.now() - lastNote > 60_000) {
        log(`import: waiting, ${pending} document(s) not yet read (copied ${out.copied} so far)`);
        lastNote = Date.now();
      }
      await sleep(5_000);
    }
    if (stopped()) break;
    const name = `imp-${sha.slice(0, 24)}${EXT_BY_MIME[mime]}`;
    const tmp = path.join(o.inbox, `.${name}.part`);
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, path.join(o.inbox, name));
    fs.appendFileSync(ledger, JSON.stringify({ sha256: sha, size: data.length, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    out.copied++;
    out.bytes += data.length;
    if (out.copied % 100 === 0) log(`import: copied ${out.copied}, duplicates ${out.duplicates}, seen ${out.seen} of ${files.length}`);
    if (o.rate > 0) await sleep(Math.round(60_000 / o.rate));
  }
  return out;
}

function main(): void {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const dir = get('--dir') || a.find((x) => !x.startsWith('--')) || '';
  if (!dir || !fs.existsSync(dir)) {
    console.error('usage: npm run intake:import -- --dir <folder> [--rate 20] [--max-pending 50] [--limit N] [--dry-run]');
    process.exitCode = 2;
    return;
  }
  const num = (k: string, d: number) => {
    const n = Number(get(k));
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
    console.log('import: stopping after the current file');
  });
  runImport({
    dir: path.resolve(dir),
    inbox: dropDir(),
    storeDir: intakeDir(),
    rate: num('--rate', 20),
    maxPending: Math.max(1, num('--max-pending', 50)),
    limit: num('--limit', 0),
    dryRun: a.includes('--dry-run'),
    stopped: () => stop,
  })
    .then((r) =>
      console.log(
        `import ${a.includes('--dry-run') ? '(dry run) ' : ''}done: ${r.copied} new (${(r.bytes / 1048576).toFixed(1)} MB), ${r.duplicates} duplicate(s), ${r.unsupported} not PDF/TIFF/PNG/JPEG, ${r.too_big} too big, ${r.unreadable} unreadable, ${r.seen} looked at`
      )
    )
    .catch((e) => {
      console.error(`FAIL import stopped (${e?.code || e?.name || 'error'})`);
      process.exitCode = 1;
    });
}

if (require.main === module) main();
