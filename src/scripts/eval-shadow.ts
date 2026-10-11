/**
 * Shadow-mode report: what intake would have done on real documents, against what staff confirmed.
 *
 *   npm run eval:shadow -- [--dir <intake dir>] [--out <report.md>] [--csv] [--min-sender 5] [--label name]
 *   (in the data-center container: node dist/scripts/eval-shadow.js ...)
 *
 * Reads <dir>/items.json (default: the store under CALL_RECORDS_DIR, /app/data/intake) without
 * changing it, and the document texts for the layout fingerprint. Writes:
 *   <dir>/reports/shadow-report[-label]-<stamp>.md and .json (or --out): counts and percentages only,
 *       safe to share. Checked against every name, DOB, MRN and chart key in the store before it is
 *       written; if any appears, nothing is written (exit 2).
 *   --csv: <dir>/reports/shadow-documents-<stamp>.csv, one row per document with patient
 *       identifiers, for staff. Always inside the data directory, mode 0600, PHI warning on line 1.
 *
 * Exit code 1 when any wrong-patient auto-file was confirmed (the number that must stay 0).
 * No network. Prints counts only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadRoster, rosterPath } from '../platform/modules/intake/roster';
import { buildShadowReport, documentCsv, findLeaks, identifiersOf, shadowReportMarkdown } from '../platform/modules/intake/shadow-report';
import { intakeDir, type IntakeItem } from '../platform/modules/intake/store';

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    dir: path.resolve(get('--dir') || intakeDir()),
    out: get('--out'),
    csv: a.includes('--csv'),
    minSender: Number(get('--min-sender') || 5),
    label: (get('--label') || '').replace(/[^\w-]/g, '').slice(0, 30),
  };
}

/** Inside `dir` (after resolving), so the per-document file never lands outside the data directory. */
export function insideDir(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function main(): void {
  const o = args();
  let items: IntakeItem[];
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(o.dir, 'items.json'), 'utf8'));
    items = Array.isArray(rows) ? rows : [];
  } catch (e: any) {
    console.error(`FAIL cannot read the intake store (${e?.code || e?.name || 'error'})`);
    process.exitCode = 2;
    return;
  }
  const text = (id: string) => {
    if (!/^in_[a-z0-9]{6,40}$/.test(id)) return '';
    try {
      return fs.readFileSync(path.join(o.dir, 'files', `${id}.txt`), 'utf8');
    } catch {
      return '';
    }
  };
  let personNames: string[] = [];
  if (rosterPath()) {
    try {
      personNames = loadRoster().patients.map((p) => `${p.first}${p.last}`);
    } catch {
      // The store's own names are still used.
    }
  }
  const now = new Date();
  const report = buildShadowReport(items, { now, text, minSender: Number.isFinite(o.minSender) && o.minSender >= 1 ? o.minSender : 5, personNames });
  const md = shadowReportMarkdown(report);
  const json = JSON.stringify(report, null, 1);
  const ids = identifiersOf(items);
  const leaks = findLeaks(md, ids) + findLeaks(json, ids);
  if (leaks) {
    console.error(`FAIL the report would contain ${leaks} patient identifier(s); nothing was written. Raise --min-sender or check the sender labels.`);
    process.exitCode = 2;
    return;
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reports = path.join(o.dir, 'reports');
  fs.mkdirSync(reports, { recursive: true, mode: 0o700 });
  const mdPath = o.out ? path.resolve(o.out) : path.join(reports, `shadow-report${o.label ? `-${o.label}` : ''}-${stamp}.md`);
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(mdPath.replace(/\.md$/i, '') + '.json', json);
  if (o.csv) {
    const csvPath = path.join(reports, `shadow-documents-${stamp}.csv`);
    if (!insideDir(csvPath, o.dir)) throw new Error('per-document file must stay inside the data directory');
    fs.writeFileSync(csvPath, documentCsv(items), { mode: 0o600 });
    console.log(`per-document file (PHI, staff only): ${csvPath}`);
  }
  const w = report.wrong_patient.total;
  const p = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
  console.log(
    `documents ${report.documents}  units ${report.units}  would auto-file ${report.would_auto_file} (${p(report.would_auto_file, report.units)})  confirmed ${report.confirmed_units}  precision ${p(report.precision.right, report.precision.of)}  WRONG-PATIENT ${w}  category ${p(report.category.right, report.category.of)}  failed ${report.failed}`
  );
  console.log(`report: ${mdPath}`);
  if (w) process.exitCode = 1;
}

if (require.main === module) main();
