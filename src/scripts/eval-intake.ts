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
 * Filing, page by page (sets made by the current generator carry per-page truth): every document is
 * also run through three filing set-ups and each page's outcome (filed to which chart, or staff) is
 * scored against the page's real patient:
 *   before            whole-document match; the batch lab in INTAKE_NO_AUTO_SENDERS (the old stopgap)
 *   before, no list   the same without the stopgap (shows the blind spot it covered)
 *   after             INTAKE_BATCH_SENDERS + the per-page check and split of pipeline.ts (pages.ts):
 *                     the parent is segmented, each part is extracted, matched and gated on its own
 * A wrong-patient page is a page filed to a chart other than its patient's (a page holding two
 * patients counts whenever it is filed; a cover sheet counts when it names another patient).
 * Batch sender: --batch-sender (default INTAKE_BATCH_SENDERS or "Sawtooth Rapid Lab", the synthetic
 * stand-in for Express Lab).
 *
 * Writes <set>/report[-label].md and <set>/summary[-label].json. The numbers that matter most are
 * wrong-patient pages filed and wrong-patient auto-files under "after". They must be 0. Exit code 1
 * when they are not. No network, no Veradigm call.
 */
import * as fs from 'fs';
import * as path from 'path';
import { extractFields, ExtractedFields } from '../platform/modules/intake/extract';
import { matchPatient, MatchDecision, MatchResult, normDob } from '../platform/modules/intake/match';
import { ocrMinConfidence, ocrReviewReason } from '../platform/modules/intake/ocr';
import { partOcr, segmentItem, splitPages } from '../platform/modules/intake/pages';

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
  // Per-page truth (generator with batch splitting; absent in older sets).
  batch_style?: string | null;
  obscured?: boolean;
  expected_pages_decision?: 'single' | 'split' | 'review';
  expected_pages_why?: string;
  patients_truth?: { key: string; in_roster: boolean; expected_decision: string; pages: number[] }[];
  page_truth?: { page: number; role: 'cover' | 'result'; owners: string[]; shown: string[]; blotted: string[]; names: string[]; expected_filed_to: string | null }[];
}

interface OcrMeta {
  pages?: number;
  mean_confidence?: number;
  used_text_layer?: boolean;
  page_confidences?: number[];
  error?: string;
  elapsed_ms?: number;
}

/** What one filing set-up did with a document: per page, the chart it went to ('' = staff). */
interface Filing {
  pages: string[];
  /** Documents or parts auto-filed. */
  units: number;
  /** Units auto-filed holding any page of another patient. */
  wrong_units: number;
}

interface AfterInfo {
  seg: 'single' | 'split' | 'review' | 'ocr_failed';
  reason: string;
  groups: number[][];
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
  filing?: { before: Filing; open: Filing; after: Filing; info: AfterInfo };
}

function args(): { set: string; label: string; examples: number; ocr: string; batchSender: string } {
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
  return {
    set: path.resolve(set),
    label: get('--label') || '',
    examples: Number(get('--examples') || 12),
    ocr: get('--ocr') || 'ocr',
    batchSender: get('--batch-sender') || process.env.INTAKE_BATCH_SENDERS || 'Sawtooth Rapid Lab',
  };
}

// ── Filing simulation, page by page ──────────────────────────────────────────

/** The pipeline's OCR-confidence gate (pipeline.ts / ocr.ts) on a match decision. */
function ocrGated(decision: MatchDecision, ocr: OcrMeta, minConf: number): boolean {
  return decision === 'auto' && !!ocrReviewReason({ mean_confidence: Number(ocr.mean_confidence ?? 0), used_text_layer: ocr.used_text_layer === true }, minConf);
}

/** Pages filed whole to one chart, or nowhere. */
function wholeFiling(n: number, chart: string): Filing {
  return { pages: Array.from({ length: n }, () => chart), units: chart ? 1 : 0, wrong_units: 0 };
}

/**
 * What pipeline.ts does with a document: page check (pages.ts), then either one match on the whole
 * text, a split into parts (each extracted, matched and gated on its own), or staff review.
 */
async function afterFiling(
  text: string,
  meta: OcrMeta,
  x: ExtractedFields,
  whole: MatchResult,
  n: number,
  search: ReturnType<typeof fakePatientSearch>,
  minConf: number
): Promise<{ filing: Filing; info: AfterInfo }> {
  const ocr = { engine: 'local' as const, pages: Number(meta.pages || 0), mean_confidence: Number(meta.mean_confidence ?? 0), used_text_layer: meta.used_text_layer === true, page_confidences: meta.page_confidences };
  const seg = segmentItem({ ocr }, text, x, NOW);
  const info: AfterInfo = { seg: seg.decision, reason: seg.reason, groups: seg.patients.map((g) => g.pages) };
  if (seg.decision === 'review') return { filing: wholeFiling(n, ''), info };
  if (seg.decision === 'single') {
    const auto = whole.decision === 'auto' && !ocrGated(whole.decision, meta, minConf);
    return { filing: wholeFiling(n, auto ? whole.patient!.chartPatientId : ''), info };
  }
  const texts = splitPages(text, seg.page_count);
  const filing: Filing = { pages: Array.from({ length: n }, () => ''), units: 0, wrong_units: 0 };
  for (const g of seg.patients) {
    const px = extractFields(g.pages.map((p) => texts[p - 1]).join('\f'), NOW);
    if (!px.sender && x.sender) px.sender = x.sender;
    const m = await matchPatient(px, search, () => NOW);
    const po = partOcr(ocr, g.pages)!;
    if (m.decision !== 'auto' || ocrGated(m.decision, { mean_confidence: po.mean_confidence, used_text_layer: po.used_text_layer }, minConf)) continue;
    filing.units++;
    for (const p of g.pages) if (p <= n) filing.pages[p - 1] = m.patient!.chartPatientId;
  }
  return { filing, info };
}

interface PageScore {
  result_pages: number;
  filed: number;
  right: number;
  wrong: number;
  /** Result pages whose outcome equals the ideal one (filed to that patient, or staff). */
  as_expected: number;
  expected_filed: number;
  right_when_expected: number;
}

/** Score one filing against the page truth; also marks units that hold another patient's page. */
function scorePages(t: Truth, f: Filing, chartOf: (key: string) => string): PageScore {
  const s: PageScore = { result_pages: 0, filed: 0, right: 0, wrong: 0, as_expected: 0, expected_filed: 0, right_when_expected: 0 };
  const badCharts = new Set<string>();
  for (const p of t.page_truth || []) {
    const got = f.pages[p.page - 1] || '';
    if (p.role === 'cover') {
      if (got && p.names.some((k) => chartOf(k) !== got)) {
        s.wrong++;
        badCharts.add(got);
      }
      continue;
    }
    s.result_pages++;
    const own = p.owners.length === 1 ? chartOf(p.owners[0]) : '';
    const want = p.expected_filed_to ? chartOf(p.expected_filed_to) : '';
    if (got) {
      s.filed++;
      if (own && got === own) s.right++;
      else {
        s.wrong++;
        badCharts.add(got);
      }
    }
    if (got === want) s.as_expected++;
    if (want) {
      s.expected_filed++;
      if (got === want) s.right_when_expected++;
    }
  }
  f.wrong_units = badCharts.size;
  return s;
}

function addScore(a: PageScore, b: PageScore): PageScore {
  return Object.fromEntries(Object.keys(a).map((k) => [k, (a as any)[k] + (b as any)[k]])) as unknown as PageScore;
}
const ZERO: PageScore = { result_pages: 0, filed: 0, right: 0, wrong: 0, as_expected: 0, expected_filed: 0, right_when_expected: 0 };

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
  const { set, label, examples, ocr: ocrSub, batchSender } = args();
  // "after" runs with the batch sender listed and splitting on; the old stopgap list is not used.
  process.env.INTAKE_BATCH_SENDERS = batchSender;
  delete process.env.INTAKE_NO_AUTO_SENDERS;
  delete process.env.INTAKE_SPLIT;
  // The fake search below answers, never a local roster (shadow mode has its own report: eval:shadow).
  delete process.env.INTAKE_ROSTER_CSV;
  delete process.env.INTAKE_MODE;
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
    const row: Row = { t, decision, raw_decision: match.decision, gated: gate, wrong_patient: wrong, fields: sc.ok, got: sc.got, want: sc.want, match, ocr: meta };
    if (t.page_truth) {
      const n = t.page_truth.length;
      const chart = decision === 'auto' ? match.patient!.chartPatientId : '';
      // The old stopgap only looked at the extracted sender (autoFileBlocker before INTAKE_BATCH_SENDERS).
      const listed = (x.sender?.value || '').toLowerCase().includes(batchSender.toLowerCase());
      const after = await afterFiling(text, meta, x, match, n, search, minConf);
      row.filing = { before: wholeFiling(n, listed ? '' : chart), open: wholeFiling(n, chart), after: after.filing, info: after.info };
    }
    rows.push(row);
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

  // ── Filing page by page: before / before without the stopgap / after ──
  const paged = rows.filter((r) => r.filing && r.t.page_truth);
  const chartOf = (k: string) => byKey.get(k)?.chart_patient_id || `not-in-roster:${k}`;
  const SCEN = [
    ['before', 'Before: batch lab in INTAKE_NO_AUTO_SENDERS (stopgap)'],
    ['open', 'Before, without the stopgap (the blind spot)'],
    ['after', 'After: INTAKE_BATCH_SENDERS + per-page check + split'],
  ] as const;
  type Scen = (typeof SCEN)[number][0];
  const perDoc = new Map<Row, Record<Scen, PageScore>>();
  const totals = Object.fromEntries(SCEN.map(([k]) => [k, { ...ZERO, units: 0, wrong_units: 0 }])) as Record<Scen, PageScore & { units: number; wrong_units: number }>;
  for (const r of paged) {
    const s = {} as Record<Scen, PageScore>;
    for (const [k] of SCEN) {
      const f = r.filing![k];
      s[k] = scorePages(r.t, f, chartOf);
      totals[k] = { ...addScore(totals[k], s[k]), units: totals[k].units + f.units, wrong_units: totals[k].wrong_units + f.wrong_units };
    }
    perDoc.set(r, s);
  }
  const wrongPagesAfter = paged.filter((r) => perDoc.get(r)!.after.wrong > 0);
  const wrongPagesOpen = paged.filter((r) => perDoc.get(r)!.open.wrong > 0);
  const scenTable = [
    '| Set-up | Documents / parts auto-filed | Result pages filed | ...to the right patient | **Wrong-patient pages filed** | Page recall (filed where the rules say so) | Page-level accuracy (outcome = ideal) |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...SCEN.map(([k, name]) => {
      const t = totals[k];
      return `| ${name} | ${t.units} | ${t.filed} (${pct(t.filed, t.result_pages)}) | ${t.right} | **${t.wrong}** | ${pct(t.right_when_expected, t.expected_filed)} | ${pct(t.as_expected, t.result_pages)} |`;
    }),
  ].join('\n');
  const multi = paged.filter((r) => (r.t.patients_truth?.length || 0) > 1);
  const batchDocs = paged.filter((r) => r.t.layout === 'daily_batch');
  const batchTotals = Object.fromEntries(
    SCEN.map(([k]) => [k, batchDocs.map((r) => perDoc.get(r)![k]).reduce(addScore, ZERO)])
  ) as Record<Scen, PageScore>;
  const batchTable = [
    '| Set-up (batch lab documents only) | Result pages filed | ...to the right patient | **Wrong-patient pages** | Page recall | Page-level accuracy |',
    '|---|---:|---:|---:|---:|---:|',
    ...SCEN.map(([k, name]) => {
      const t = batchTotals[k];
      return `| ${name} | ${t.filed} of ${t.result_pages} | ${t.right} | **${t.wrong}** | ${pct(t.right_when_expected, t.expected_filed)} | ${pct(t.as_expected, t.result_pages)} |`;
    }),
  ].join('\n');
  const sameGroups = (a: number[][], b: number[][]) => {
    const key = (g: number[][]) => g.map((x) => x.join('.')).sort().join('|');
    return key(a) === key(b);
  };
  let splitDocs = 0;
  let splitExact = 0;
  let splitPagesRight = 0;
  let splitPages = 0;
  for (const r of multi) {
    const info = r.filing!.info;
    if (info.seg !== 'split') continue;
    splitDocs++;
    const truthGroups = (r.t.patients_truth || []).map((p) => p.pages);
    if (sameGroups(info.groups, truthGroups)) splitExact++;
    for (const p of r.t.page_truth!.filter((x) => x.role === 'result')) {
      splitPages++;
      const g = info.groups.find((x) => x.includes(p.page));
      const own = p.owners.length === 1 ? r.t.patients_truth!.find((x) => x.key === p.owners[0])?.pages : undefined;
      if (g && own && g.join('.') === own.join('.')) splitPagesRight++;
    }
  }
  const segTable = (rs: Row[], key: (r: Row) => string, title: string) => {
    const m = new Map<string, Row[]>();
    for (const r of rs) m.set(key(r), [...(m.get(key(r)) || []), r]);
    const lines = [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => {
        const c = (d: string) => v.filter((r) => r.filing!.info.seg === d).length;
        const e = (d: string) => v.filter((r) => r.t.expected_pages_decision === d).length;
        const sc = v.map((r) => perDoc.get(r)!.after).reduce(addScore, ZERO);
        return `| ${k} | ${v.length} | ${e('single')} / ${e('split')} / ${e('review')} | ${c('single')} / ${c('split')} / ${c('review')} | ${pct(sc.right_when_expected, sc.expected_filed)} | ${pct(sc.as_expected, sc.result_pages)} | **${sc.wrong}** |`;
      });
    return [
      `| ${title} | Docs | Expected single / split / review | After: single / split / review | Page recall | Page-level accuracy | Wrong-patient pages |`,
      '|---|---:|---:|---:|---:|---:|---:|',
      ...lines,
    ].join('\n');
  };
  const reasons = new Map<string, number>();
  for (const r of [...batchDocs, ...multi.filter((x) => x.t.layout !== 'daily_batch')]) {
    if (r.filing!.info.seg !== 'review') continue;
    const k = r.filing!.info.reason.replace(/\d+/g, 'N').replace(/pages? N(, N)*/g, 'page N');
    reasons.set(k, (reasons.get(k) || 0) + 1);
  }
  const pagesSection = paged.length
    ? `## Filing page by page (batch faxes and splitting)

${paged.length} documents with per-page truth, ${totals.after.result_pages} result pages. Batch sender: "${batchSender}".
${multi.length} documents hold more than one patient (${multi.filter((r) => r.t.layout === 'daily_batch').length} daily batches, ${multi.filter((r) => r.t.layout !== 'daily_batch').length} faxes with two reports);
${batchDocs.length} documents come from the batch lab in all.

${scenTable}

${batchTable}

A wrong-patient page is a page filed to any chart other than its patient's: a page of another patient, a page holding two
patients, a page of a patient outside the roster, or a cover sheet naming another patient. Page recall counts result pages the
ideal rules would file (one readable patient per page or part, two identifiers, no batch page without an identifier) that went to
that patient. Page-level accuracy counts result pages whose outcome (filed to whom, or staff) equals the ideal one.

### Multi-patient documents (after)

- Split: ${splitDocs} of ${multi.length}; split exactly as the truth (same page groups): ${splitExact} of ${splitDocs}
- Pages in split documents assigned to the right patient's part: ${pct(splitPagesRight, splitPages)} (${splitPagesRight}/${splitPages})
- Expected split (one readable patient per page, contiguous): ${multi.filter((r) => r.t.expected_pages_decision === 'split').length}; expected review: ${multi.filter((r) => r.t.expected_pages_decision === 'review').length}

${segTable(multi, (r) => `${r.t.layout === 'daily_batch' ? r.t.batch_style : 'two reports'}${r.t.obscured ? ', identifiers blotted' : ''}`, 'Style')}

### Batch lab documents by style (after)

${segTable(batchDocs, (r) => `${(r.t.patients_truth?.length || 0) > 1 ? 'multi' : 'single'}: ${r.t.batch_style}${r.t.obscured ? ', blotted' : ''}`, 'Kind')}

### Why batch and multi-patient documents went to staff (after)

| Reason | Docs |
|---|---:|
${[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

${wrongPagesAfter.length ? `### Wrong-patient pages (after)\n\n${ex(wrongPagesAfter, (r) => `${perDoc.get(r)!.after.wrong} page(s); ${r.filing!.info.seg}: ${r.filing!.info.reason}`)}\n` : ''}
### Wrong-patient pages without the stopgap (before)

${ex(wrongPagesOpen, (r) => `${perDoc.get(r)!.open.wrong} page(s) of ${r.t.page_truth!.length} filed to one chart; ${r.t.patients_truth!.length} patient(s), style ${r.t.batch_style}${r.t.obscured ? ', identifiers blotted' : ''}`)}
`
    : '';
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
    pages: paged.length
      ? {
          batch_sender: batchSender,
          docs: paged.length,
          multi_patient_docs: multi.length,
          scenarios: totals,
          batch_lab_scenarios: batchTotals,
          split_docs: splitDocs,
          split_exact: splitExact,
          split_page_assignment: +(splitPagesRight / Math.max(1, splitPages)).toFixed(4),
          wrong_patient_pages_after: totals.after.wrong,
          wrong_patient_units_after: totals.after.wrong_units,
        }
      : null,
  };

  const md = `# Intake accuracy report${label ? ` (${label})` : ''}

Set \`${path.basename(set)}\`: ${rows.length} synthetic documents, roster of ${roster.length} invented patients. Generated ${summary.generated_at}.
OCR: ${pages} pages, ${ocrRows.filter((r) => r.ocr.used_text_layer).length} documents read from the PDF text layer, median ${median(ms)} ms per document,
mean Tesseract confidence ${confs.length ? (confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(1) : 'n/a'} on image documents. Missing OCR output: ${missingOcr}.

## Safety

${
  paged.length
    ? `- **Wrong-patient pages filed (after): ${totals.after.wrong}** ${totals.after.wrong ? '(MUST BE 0)' : '(required: 0)'}; documents or parts auto-filed with another patient's page: ${totals.after.wrong_units}
- Before, with the stopgap: ${totals.before.wrong} wrong-patient page(s); before, without it: ${totals.open.wrong}
- Whole-document match only (no sender list, no page check): wrong-patient auto decisions ${wrong.length}`
    : `- **Wrong-patient auto-files: ${wrong.length}** ${wrong.length ? '(MUST BE 0)' : '(required: 0)'}`
}
- Auto-filed although the expected decision was not "auto" (right patient): ${unexpectedAuto.length}
- Auto matches held for review by the OCR-confidence gate (< ${minConf}): ${gated.length}

${wrong.length ? `### Wrong-patient auto-files\n\n${ex(wrong, (r) => `intended ${r.t.intended_patient}, filed to chart ${r.match?.patient?.chartPatientId} (${r.match?.reason})`)}\n` : ''}
${unexpectedAuto.length ? `### Auto-filed to the right patient although "${'auto'}" was not expected\n\n${ex(unexpectedAuto, (r) => `expected ${r.t.expected_decision}; ${r.match?.reason} (document MRN \`${r.want.mrn || '-'}\` read as \`${r.got.mrn || '-'}\`, phone \`${r.want.phone || '-'}\` read as \`${r.got.phone || '-'}\`)`)}\n` : ''}
${pagesSection}
## Overall (whole-document match)

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
  if (paged.length) {
    for (const [k, name] of SCEN) {
      const t = totals[k];
      console.log(
        `${name}: units ${t.units}  pages filed ${t.filed}/${t.result_pages}  right ${t.right}  WRONG-PATIENT PAGES ${t.wrong}  page recall ${pct(t.right_when_expected, t.expected_filed)}  page accuracy ${pct(t.as_expected, t.result_pages)}`
      );
    }
    for (const [k] of SCEN) {
      const t = batchTotals[k];
      console.log(`  batch lab only, ${k}: pages filed ${t.filed}/${t.result_pages}  right ${t.right}  wrong ${t.wrong}  page recall ${pct(t.right_when_expected, t.expected_filed)}`);
    }
    console.log(`multi-patient docs ${multi.length}: split ${splitDocs} (exact ${splitExact}), page assignment in split docs ${pct(splitPagesRight, splitPages)}`);
    console.log(`whole-document match only: wrong-patient auto decisions ${wrong.length}   OCR-gated: ${gated.length}`);
  } else {
    console.log(`WRONG-PATIENT AUTO-FILES: ${wrong.length}   unexpected auto (right patient): ${unexpectedAuto.length}   OCR-gated: ${gated.length}`);
  }
  console.log(`report: ${path.join(set, `report${suffix}.md`)}`);
  if (paged.length ? totals.after.wrong || totals.after.wrong_units : wrong.length) process.exitCode = 1;
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
