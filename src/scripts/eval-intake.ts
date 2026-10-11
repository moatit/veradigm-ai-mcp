/**
 * Accuracy harness for document intake, on a synthetic set from tools/intake-synth (invented
 * patients only) that has been read by the OCR container (deploy/ocr).
 *
 *   npm run eval:intake -- --set deploy/local/intake/synth/set-s42 [--label after] [--ocr ocr] [--examples 15]
 *
 * Reads <set>/roster.json, <set>/truth/*.json and <set>/ocr/<id>.txt + .json. For every document it
 * runs the real extractFields() and matchPatient() (so the real decideMatch()) against the roster
 * through an in-memory fake of unity_search_patients that mimics the Veradigm® EHR search (name +
 * DOB, two-letter name prefix filter, hyphenated last names work) and returns the same shape the real
 * tool does. The pipeline's OCR-confidence gate (ocr.ts) is applied the same way.
 *
 * Writes <set>/report[-label].md and <set>/summary[-label].json. The number that matters most is
 * wrong-patient auto-files: an "auto" decision for anyone other than the intended patient. It must be 0.
 * Exit code 1 when it is not. No network, no Veradigm call.
 */
import * as fs from 'fs';
import * as path from 'path';
import { extractFields, ExtractedFields } from '../platform/modules/intake/extract';
import { matchPatient, MatchDecision, MatchResult, normDob } from '../platform/modules/intake/match';
import { ocrMinConfidence, ocrReviewReason } from '../platform/modules/intake/ocr';

// The day the synthetic set was generated for (dates on the documents are just before it).
const NOW = new Date('2026-10-11T15:00:00Z');
const DECISIONS: (MatchDecision | 'ocr_failed')[] = ['auto', 'review', 'none', 'ambiguous', 'error', 'ocr_failed'];
const FIELDS = ['name', 'dob', 'mrn', 'phone', 'sender', 'collection_date', 'kind', 'abnormal'] as const;
type Field = (typeof FIELDS)[number];

interface RosterPatient {
  key: string;
  patient_id: string;
  chart_patient_id: string;
  first: string;
  middle: string;
  last: string;
  dob: string;
  sex: string;
  pm_mrn: string;
  ehr_mrn: string;
  home_phone: string;
  cell_phone: string;
  tags: string[];
}

interface Truth {
  id: string;
  layout: string;
  case: string;
  quality: string;
  container: string;
  pages: number;
  cover_sheet: boolean;
  intended_patient: string;
  expected_decision: MatchDecision;
  kind: string;
  sender: { name: string; aliases: string[] };
  collection_date: string;
  abnormal: { flagged: boolean; critical: boolean; markers: string[] };
  printed: { first: string; last: string; dob: string; mrn: string | null; mrn_kind: string | null; phone: string | null };
  patients_on_document: number;
}

interface OcrMeta {
  pages?: number;
  mean_confidence?: number;
  used_text_layer?: boolean;
  error?: string;
  elapsed_ms?: number;
}

interface Row {
  t: Truth;
  decision: MatchDecision | 'ocr_failed';
  raw_decision?: MatchDecision;
  gated: boolean;
  wrong_patient: boolean;
  fields: Record<Field, boolean>;
  got: Record<Field, string>;
  want: Record<Field, string>;
  match?: MatchResult;
  ocr: OcrMeta;
}

function args(): { set: string; label: string; examples: number; ocr: string } {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const set = get('--set') || a.find((x) => !x.startsWith('--')) || '';
  if (!set) {
    console.error('usage: npm run eval:intake -- --set <dir> [--label name] [--ocr subdir] [--examples N]');
    process.exit(2);
  }
  return { set: path.resolve(set), label: get('--label') || '', examples: Number(get('--examples') || 12), ocr: get('--ocr') || 'ocr' };
}

// ── Fake unity_search_patients (Veradigm® EHR behaviour) ─────────────────────

const lower = (s: unknown) => String(s ?? '').trim().toLowerCase();

/**
 * Same result shape as UnityPatientTools.searchPatients: { patients, total, message }, each patient
 * with patientId (PM), chartPatientId (EHR), names, dateOfBirth, mrn and phone {home, cell}. Both
 * MRNs are returned: mrn = PM MRN, patientNumber = EHR chart MRN (= PM PatientNumber).
 */
export function fakePatientSearch(roster: RosterPatient[]) {
  return async (name: string, a: any): Promise<any> => {
    if (name !== 'unity_search_patients') return { success: false, error_code: 'UNKNOWN_TOOL', retryable: false, tool: name, message: '' };
    const dob = normDob(a?.dateOfBirth);
    const first = lower(a?.firstName);
    const last = lower(a?.lastName);
    // Real filter: DOB exact, first two letters of first and last name (patient.tools.ts filterPatients).
    const rows = roster.filter(
      (p) => normDob(p.dob) === dob && lower(p.first).slice(0, 2) === first.slice(0, 2) && lower(p.last).slice(0, 2) === last.slice(0, 2)
    );
    return {
      patients: rows.map((p) => ({
        id: p.patient_id,
        patientId: p.patient_id,
        chartPatientId: p.chart_patient_id,
        firstName: p.first,
        middleName: p.middle,
        lastName: p.last,
        dateOfBirth: p.dob,
        gender: p.sex,
        mrn: p.pm_mrn,
        patientNumber: p.ehr_mrn,
        phone: { home: p.home_phone, ...(p.cell_phone ? { cell: p.cell_phone } : {}) },
      })),
      total: rows.length,
      message: `${rows.length} patient(s) found`,
    };
  };
}

// ── Field scoring ────────────────────────────────────────────────────────────

const letters = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
const alnum = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '');
const usable = (c?: string) => c === 'high' || c === 'medium';

function score(t: Truth, x: ExtractedFields): { ok: Record<Field, boolean>; got: Record<Field, string>; want: Record<Field, string> } {
  const name = x.patient_name && usable(x.patient_name.confidence) ? x.patient_name.value : undefined;
  const mrn = x.mrn && usable(x.mrn.confidence) ? x.mrn.value : '';
  const phone = x.phone && usable(x.phone.confidence) ? x.phone.value : '';
  const sender = x.sender ? x.sender.value : '';
  const got: Record<Field, string> = {
    name: name ? `${name.first} ${name.last}` : '',
    dob: x.dob && usable(x.dob.confidence) ? x.dob.value : '',
    mrn,
    phone,
    sender,
    collection_date: x.collection_date?.value || '',
    kind: x.kind.value,
    abnormal: `${x.abnormal.flagged ? 'flagged' : 'clean'}${x.abnormal.critical ? '+critical' : ''}`,
  };
  const want: Record<Field, string> = {
    name: `${t.printed.first} ${t.printed.last}`,
    dob: t.printed.dob,
    mrn: t.printed.mrn || '',
    phone: t.printed.phone || '',
    sender: t.sender.name,
    collection_date: t.collection_date,
    kind: t.kind,
    abnormal: `${t.abnormal.flagged ? 'flagged' : 'clean'}${t.abnormal.critical ? '+critical' : ''}`,
  };
  const s = letters(sender);
  const ok: Record<Field, boolean> = {
    name: !!name && letters(name.first) === letters(t.printed.first) && letters(name.last) === letters(t.printed.last),
    dob: got.dob === want.dob,
    mrn: alnum(got.mrn) === alnum(want.mrn),
    phone: got.phone === want.phone,
    sender: !!s && t.sender.aliases.some((a) => s.includes(letters(a)) || (s.length >= 8 && letters(a).includes(s))),
    collection_date: got.collection_date === want.collection_date,
    kind: got.kind === want.kind,
    abnormal: got.abnormal === want.abnormal,
  };
  return { ok, got, want };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');

interface Group {
  n: number;
  fields: Record<Field, number>;
  auto: number;
  review: number;
  failed: number;
  correct_decision: number;
  wrong_patient: number;
  expected_auto: number;
  auto_when_expected: number;
}

function group(rows: Row[]): Group {
  const g: Group = {
    n: rows.length,
    fields: Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<Field, number>,
    auto: 0,
    review: 0,
    failed: 0,
    correct_decision: 0,
    wrong_patient: 0,
    expected_auto: 0,
    auto_when_expected: 0,
  };
  for (const r of rows) {
    for (const f of FIELDS) if (r.fields[f]) g.fields[f]++;
    if (r.decision === 'auto') g.auto++;
    else if (r.decision === 'error' || r.decision === 'ocr_failed') g.failed++;
    else g.review++;
    if (r.decision === r.t.expected_decision) g.correct_decision++;
    if (r.wrong_patient) g.wrong_patient++;
    if (r.t.expected_decision === 'auto') {
      g.expected_auto++;
      if (r.decision === 'auto') g.auto_when_expected++;
    }
  }
  return g;
}

function by(rows: Row[], key: (r: Row) => string): [string, Group][] {
  const m = new Map<string, Row[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) || []), r]);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, group(v)]);
}

function groupTable(title: string, groups: [string, Group][]): string {
  const head = `| ${title} | Docs | Name | DOB | MRN | Phone | Sender | Coll. date | Kind | Abnormal | Decision = expected | Auto-filed | Auto recall | Wrong-patient auto |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`;
  const lines = groups.map(
    ([k, g]) =>
      `| ${k} | ${g.n} | ${FIELDS.map((f) => pct(g.fields[f], g.n)).join(' | ')} | ${pct(g.correct_decision, g.n)} | ${pct(g.auto, g.n)} | ${pct(g.auto_when_expected, g.expected_auto)} | **${g.wrong_patient}** |`
  );
  return [head, ...lines].join('\n');
}

async function main(): Promise<void> {
  const { set, label, examples, ocr: ocrSub } = args();
  const roster: RosterPatient[] = JSON.parse(fs.readFileSync(path.join(set, 'roster.json'), 'utf8'));
  const byKey = new Map(roster.map((p) => [p.key, p]));
  const search = fakePatientSearch(roster);
  const truthDir = path.join(set, 'truth');
  const ocrDir = path.join(set, ocrSub);
  const ids = fs.readdirSync(truthDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  const minConf = ocrMinConfidence();

  const rows: Row[] = [];
  let missingOcr = 0;
  for (const id of ids) {
    const t: Truth = JSON.parse(fs.readFileSync(path.join(truthDir, `${id}.json`), 'utf8'));
    let meta: OcrMeta = {};
    let text = '';
    try {
      meta = JSON.parse(fs.readFileSync(path.join(ocrDir, `${id}.json`), 'utf8'));
      text = fs.readFileSync(path.join(ocrDir, `${id}.txt`), 'utf8');
    } catch {
      missingOcr++;
      meta = { error: 'NOT_RUN' };
    }
    const x = extractFields(text, NOW);
    const sc = score(t, x);
    if (meta.error) {
      rows.push({ t, decision: 'ocr_failed', gated: false, wrong_patient: false, fields: sc.ok, got: sc.got, want: sc.want, ocr: meta });
      continue;
    }
    const match = await matchPatient(x, search, () => NOW);
    // The pipeline never auto-matches on low-confidence OCR text (pipeline.ts / ocr.ts).
    const gate =
      match.decision === 'auto' &&
      !!ocrReviewReason({ mean_confidence: Number(meta.mean_confidence ?? 0), used_text_layer: meta.used_text_layer === true }, minConf);
    const decision: MatchDecision = gate ? 'review' : match.decision;
    let wrong = false;
    if (decision === 'auto') {
      const intended = byKey.get(t.intended_patient);
      wrong = !intended || match.patient?.chartPatientId !== intended.chart_patient_id;
    }
    rows.push({ t, decision, raw_decision: match.decision, gated: gate, wrong_patient: wrong, fields: sc.ok, got: sc.got, want: sc.want, match, ocr: meta });
  }

  const all = group(rows);
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    confusion[r.t.expected_decision] = confusion[r.t.expected_decision] || {};
    confusion[r.t.expected_decision][r.decision] = (confusion[r.t.expected_decision][r.decision] || 0) + 1;
  }
  const expectedOrder = ['auto', 'review', 'none', 'ambiguous'];
  const usedDecisions = DECISIONS.filter((d) => rows.some((r) => r.decision === d));
  const confusionMd = [
    `| expected \\ actual | ${usedDecisions.join(' | ')} | total |`,
    `|---|${usedDecisions.map(() => '---:').join('|')}|---:|`,
    ...expectedOrder
      .filter((e) => confusion[e])
      .map((e) => `| **${e}** | ${usedDecisions.map((d) => confusion[e][d] || 0).join(' | ')} | ${Object.values(confusion[e]).reduce((a, b) => a + b, 0)} |`),
  ].join('\n');

  const wrong = rows.filter((r) => r.wrong_patient);
  const unexpectedAuto = rows.filter((r) => r.decision === 'auto' && r.t.expected_decision !== 'auto' && !r.wrong_patient);
  const missedAuto = rows.filter((r) => r.t.expected_decision === 'auto' && r.decision !== 'auto');
  const gated = rows.filter((r) => r.gated);
  const ocrRows = rows.filter((r) => !r.ocr.error);
  const confs = ocrRows.filter((r) => !r.ocr.used_text_layer).map((r) => Number(r.ocr.mean_confidence || 0));
  const ms = ocrRows.map((r) => Number(r.ocr.elapsed_ms || 0));
  const pages = ocrRows.reduce((n, r) => n + Number(r.ocr.pages || 0), 0);

  const ex = (rs: Row[], f: (r: Row) => string) => rs.slice(0, examples).map((r) => `- \`${r.t.id}\` (${r.t.layout}, ${r.t.quality}, ${r.t.case}): ${f(r)}`).join('\n') || '- none';
  const fieldMisses = FIELDS.map((f) => {
    const miss = rows.filter((r) => !r.fields[f]);
    return `### ${f}: ${miss.length} wrong\n\n${ex(miss, (r) => `want \`${r.want[f] || '(none)'}\`, got \`${r.got[f] || '(none)'}\``)}`;
  }).join('\n\n');

  const summary = {
    label,
    generated_at: new Date().toISOString(),
    set: path.basename(set),
    docs: rows.length,
    missing_ocr: missingOcr,
    ocr_min_confidence: minConf,
    field_accuracy: Object.fromEntries(FIELDS.map((f) => [f, +(all.fields[f] / all.n).toFixed(4)])),
    decision_accuracy: +(all.correct_decision / all.n).toFixed(4),
    auto_rate: +(all.auto / all.n).toFixed(4),
    review_rate: +(all.review / all.n).toFixed(4),
    failed_rate: +(all.failed / all.n).toFixed(4),
    auto_recall: +(all.auto_when_expected / Math.max(1, all.expected_auto)).toFixed(4),
    wrong_patient_auto: wrong.length,
    unexpected_auto_right_patient: unexpectedAuto.length,
    gated_by_ocr_confidence: gated.length,
    confusion,
    by_layout: Object.fromEntries(by(rows, (r) => r.t.layout)),
    by_quality: Object.fromEntries(by(rows, (r) => r.t.quality)),
    by_case: Object.fromEntries(by(rows, (r) => r.t.case)),
  };

  const md = `# Intake accuracy report${label ? ` (${label})` : ''}

Set \`${path.basename(set)}\`: ${rows.length} synthetic documents, roster of ${roster.length} invented patients. Generated ${summary.generated_at}.
OCR: ${pages} pages, ${ocrRows.filter((r) => r.ocr.used_text_layer).length} documents read from the PDF text layer, median ${median(ms)} ms per document,
mean Tesseract confidence ${confs.length ? (confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(1) : 'n/a'} on image documents. Missing OCR output: ${missingOcr}.

## Safety

- **Wrong-patient auto-files: ${wrong.length}** ${wrong.length ? '(MUST BE 0)' : '(required: 0)'}
- Auto-filed although the expected decision was not "auto" (right patient): ${unexpectedAuto.length}
- Auto matches held for review by the OCR-confidence gate (< ${minConf}): ${gated.length}

${wrong.length ? `### Wrong-patient auto-files\n\n${ex(wrong, (r) => `intended ${r.t.intended_patient}, filed to chart ${r.match?.patient?.chartPatientId} (${r.match?.reason})`)}\n` : ''}
${unexpectedAuto.length ? `### Auto-filed to the right patient although "${'auto'}" was not expected\n\n${ex(unexpectedAuto, (r) => `expected ${r.t.expected_decision}; ${r.match?.reason} (document MRN \`${r.want.mrn || '-'}\` read as \`${r.got.mrn || '-'}\`, phone \`${r.want.phone || '-'}\` read as \`${r.got.phone || '-'}\`)`)}\n` : ''}
## Overall

| Metric | Value |
|---|---:|
| Auto-filed | ${pct(all.auto, all.n)} (${all.auto}) |
| Needs review (review + none + ambiguous) | ${pct(all.review, all.n)} (${all.review}) |
| Failed (OCR or search error) | ${pct(all.failed, all.n)} (${all.failed}) |
| Decision = expected | ${pct(all.correct_decision, all.n)} |
| Auto recall (auto when auto was expected) | ${pct(all.auto_when_expected, all.expected_auto)} (${all.auto_when_expected}/${all.expected_auto}) |
${FIELDS.map((f) => `| Field accuracy: ${f} | ${pct(all.fields[f], all.n)} |`).join('\n')}

Field accuracy counts a field as right when the extracted value (high/medium confidence only, as the
matcher uses it) equals what is printed, or when nothing is extracted and nothing is printed (MRN, phone).

## Decisions (rows: expected from what is printed; columns: what the matcher decided)

${confusionMd}

## By layout

${groupTable('Layout', by(rows, (r) => r.t.layout))}

## By fax quality

${groupTable('Quality', by(rows, (r) => r.t.quality))}

## By container

${groupTable('Container', by(rows, (r) => r.t.container))}

## By hard case

${groupTable('Case', by(rows, (r) => r.t.case))}

## Expected auto, not auto-filed (${missedAuto.length})

${ex(missedAuto, (r) => `${r.decision}${r.gated ? ' (OCR gate)' : ''}: ${r.match?.reason || r.ocr.error || ''}`)}

## Field misses (first ${examples} each)

${fieldMisses}
`;
  const suffix = label ? `-${label}` : '';
  fs.writeFileSync(path.join(set, `report${suffix}.md`), md);
  fs.writeFileSync(path.join(set, `summary${suffix}.json`), JSON.stringify(summary, null, 1));
  // One line per document for ad-hoc analysis (synthetic data only).
  fs.writeFileSync(
    path.join(set, `rows${suffix}.jsonl`),
    rows
      .map((r) =>
        JSON.stringify({
          id: r.t.id, layout: r.t.layout, quality: r.t.quality, case: r.t.case, expected: r.t.expected_decision,
          decision: r.decision, raw_decision: r.raw_decision, wrong_patient: r.wrong_patient,
          confidence: r.ocr.mean_confidence, text_layer: r.ocr.used_text_layer, fields: r.fields,
        })
      )
      .join('\n') + '\n'
  );

  console.log(`docs ${rows.length}  auto ${pct(all.auto, all.n)}  review ${pct(all.review, all.n)}  failed ${pct(all.failed, all.n)}  decision=expected ${pct(all.correct_decision, all.n)}  auto recall ${pct(all.auto_when_expected, all.expected_auto)}`);
  console.log(`fields  ${FIELDS.map((f) => `${f} ${pct(all.fields[f], all.n)}`).join('  ')}`);
  console.log(`WRONG-PATIENT AUTO-FILES: ${wrong.length}   unexpected auto (right patient): ${unexpectedAuto.length}   OCR-gated: ${gated.length}`);
  console.log(`report: ${path.join(set, `report${suffix}.md`)}`);
  if (wrong.length) process.exitCode = 1;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

main().catch((e) => {
  console.error('FAIL', e?.message || e);
  process.exitCode = 1;
});
