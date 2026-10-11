import { createHash } from 'crypto';
import { splitPages } from './pages';
import { agreement, REASON_LABEL, unitTruth, wrongPatient, type UnitTruth } from './shadow';
import type { IntakeItem } from './store';

/**
 * Shadow-mode report (npm run eval:shadow): what Drawbridge would have done, against what staff
 * confirmed. Pure: items in, numbers and markdown out.
 *
 * The report holds counts and percentages only: no patient names, dates of birth, MRNs, item IDs,
 * file names or document text. Sender names (labs and offices) appear only for senders with at least
 * `minSender` documents, and never when the label contains a patient's full name; layouts are
 * described with a fixed vocabulary of label words. findLeaks() checks the finished text against
 * every identifier in the store before anything is written.
 *
 * Unit = what would be filed on its own: a whole document, or one part of a split file. Truth for a
 * part comes from its own confirmation or from its parent's (shadow.ts unitTruth).
 */
export interface ShadowReportOptions {
  now: Date;
  /** Document text of an item ('' when gone): used for the layout fingerprint only. */
  text?: (id: string) => string;
  /** Senders with fewer documents are pooled as "other senders" (default 5). */
  minSender?: number;
  /** Full patient names ("first last"): a sender label containing one is never shown. */
  personNames?: string[];
  /** Layouts listed (default 10). */
  topLayouts?: number;
}

interface Tally {
  docs: number;
  units: number;
  auto: number;
  staff: number;
  confirmed: number;
  auto_confirmed: number;
  auto_right: number;
  wrong: number;
}
const tally = (): Tally => ({ docs: 0, units: 0, auto: 0, staff: 0, confirmed: 0, auto_confirmed: 0, auto_right: 0, wrong: 0 });

export interface ShadowReport {
  generated_at: string;
  period: { first: string; last: string } | null;
  documents: number;
  units: number;
  split_parents: number;
  pending: number;
  failed: number;
  failed_by_code: Record<string, number>;
  /** Items finished before shadow mode was on (no decision recorded). */
  undecided: number;
  would_auto_file: number;
  would_staff: number;
  auto_file_rate: number | null;
  documents_fully_auto: number;
  documents_decided: number;
  confirmed_units: number;
  confirmed_documents: number;
  precision: { right: number; of: number; rate: number | null };
  wrong_patient: { total: number; different_patient: number; not_iki: number; several: number };
  auto_unreadable: number;
  auto_rate_on_confirmed_patient_docs: { auto: number; of: number; rate: number | null };
  category: { right: number; of: number; rate: number | null; auto_right: number; auto_of: number; none_predicted: number };
  disagreements: number;
  staff_reasons: { code: string; label: string; units: number; share: number | null; confirmed: number; candidate_right: number }[];
  splits: { parents: number; confirmed_several: number; groups_exact: number };
  by_sender: (Tally & { sender: string })[];
  by_quality: (Tally & { quality: string })[];
  by_origin: (Tally & { origin: string })[];
  layouts: { layout: string; sender: string; docs: number; units: number; auto: number; pages_median: number; ocr_mean: number | null; top_reason: string; labels: string[] }[];
}

const rate = (n: number, d: number) => (d ? n / d : null);
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');

// ── Buckets ──────────────────────────────────────────────────────────────────

export function qualityBand(i: Pick<IntakeItem, 'ocr'>): string {
  const o = i.ocr;
  if (!o) return 'No OCR data (text from MOATiT Fax or with the file)';
  if (o.used_text_layer) return 'Text layer (emailed or digital PDF)';
  const c = o.mean_confidence;
  if (c >= 85) return 'OCR confidence 85+';
  if (c >= 75) return 'OCR confidence 75-84';
  if (c >= 60) return 'OCR confidence 60-74';
  return 'OCR confidence under 60';
}
const QUALITY_ORDER = ['Text layer (emailed or digital PDF)', 'OCR confidence 85+', 'OCR confidence 75-84', 'OCR confidence 60-74', 'OCR confidence under 60', 'No OCR data (text from MOATiT Fax or with the file)'];

export function originOf(root: IntakeItem): string {
  if (root.source === 'moatit_fax') return 'MOATiT Fax';
  if (root.source === 'upload') return 'Staff upload';
  if (root.source_ref.startsWith('watch:')) return 'Watched folder (e.g. Express Lab)';
  if (/^imp-[0-9a-f]{8,}/.test(root.file?.name || '')) return 'Bulk import (old faxes)';
  return 'Drop folder';
}

const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** A sender label safe for the report: plain characters, 40 max, never a person's full name. */
export function senderLabel(raw: string | undefined, personNames: Set<string>): string {
  const s = String(raw || '').replace(/[^A-Za-z0-9 &.,'()-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!s || letters(s).length < 3) return '';
  const l = letters(s);
  for (const n of personNames) if (n.length >= 5 && l.includes(n)) return '';
  return s;
}

/** Label words in reading order on the first page with a patient label: the layout's shape, never its values. */
const LAYOUT_WORDS: [string, RegExp][] = [
  ['fax cover', /fax\s*cover|cover\s*sheet|confidentiality/i],
  ['from', /^\s*from\s*[:;.]/i],
  ['to', /^\s*to\s*[:;.]/i],
  ['re', /^\s*re\s*[:;.]/i],
  ['patient name', /patient\s*name/i],
  ['pt', /\bPT\s*[:;.]/],
  ['name', /^\s*name\s*[:;.]/i],
  ['dob', /\bD[.,]?\s*[O0][.,]?\s*B\b|date\s*of\s*birth|birth\s*date/i],
  ['mrn', /\bMRN\b|med(ical)?\s*re[ce]/i],
  ['patient id', /patient\s*[I1l]D\b/i],
  ['account', /\bacc(oun)?t\b/i],
  ['accession', /accession/i],
  ['phone', /\bphone\b|\btel\b/i],
  ['sex', /\bsex\b|\bgender\b/i],
  ['collected', /coll(ected|ection|actad)?\b|\bCOLL\s*[:;]/i],
  ['received', /\breceived\b/i],
  ['reported', /\breported\b/i],
  ['ordering', /ordering|ordered\s*by|referring/i],
  ['specimen', /specimen/i],
  ['result table', /reference\s*range|\bresult\b.*\bflag\b|\btest\b.*\bresult\b/i],
  ['exam', /^\s*exam\b/i],
  ['findings', /findings/i],
  ['impression', /impression/i],
  ['assessment', /assessment|\bplan\b/i],
  ['page x of y', /page\s*\d+\s*of\s*\d+/i],
];

export function layoutLabels(text: string): string[] {
  const pages = splitPages(text);
  const page = pages.find((p) => /patient\s*name|\bD[.,]?\s*[O0][.,]?\s*B\b|date\s*of\s*birth|\bMRN\b/i.test(p)) ?? pages[0] ?? '';
  const out: string[] = [];
  for (const line of page.split(/\r?\n/).slice(0, 80)) {
    for (const [word, re] of LAYOUT_WORDS) if (!out.includes(word) && re.test(line)) out.push(word);
    if (out.length >= 14) break;
  }
  return out;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// ── The report ───────────────────────────────────────────────────────────────

export function buildShadowReport(items: IntakeItem[], opts: ShadowReportOptions): ShadowReport {
  const byIdMap = new Map(items.map((i) => [i.id, i]));
  const byId = (id: string) => byIdMap.get(id);
  const rootOf = (i: IntakeItem) => (i.parent_id ? byId(i.parent_id) || i : i);
  const minSender = opts.minSender ?? 5;
  const names = new Set((opts.personNames || []).map(letters).filter((n) => n.length >= 5));
  for (const i of items) {
    for (const p of [i.match?.patient, i.truth?.patient, ...(i.truth?.parts || []).map((x) => x.patient)]) if (p?.name) names.add(letters(p.name));
    if (i.extracted?.patient_name) names.add(letters(`${i.extracted.patient_name.value.first}${i.extracted.patient_name.value.last}`));
  }

  const docs = items.filter((i) => !i.parent_id);
  const units = items.filter((i) => i.shadow && i.shadow.would !== 'split');
  const parents = items.filter((i) => i.shadow?.would === 'split');
  const failed = items.filter((i) => i.status === 'failed');
  const pending = items.filter((i) => (i.status === 'received' || i.status === 'read') && !i.shadow);
  const undecided = items.filter((i) => !i.shadow && i.status !== 'failed' && i.status !== 'received' && i.status !== 'read');

  // Sender per root document; pooled under the threshold.
  const rawSender = (root: IntakeItem) => senderLabel(root.extracted?.sender?.value, names);
  const senderDocs = new Map<string, number>();
  for (const d of docs) {
    const s = rawSender(d);
    if (s) senderDocs.set(s.toLowerCase(), (senderDocs.get(s.toLowerCase()) || 0) + 1);
  }
  const senderOf = (root: IntakeItem) => {
    const s = rawSender(root);
    if (!s) return '(no sender read)';
    return (senderDocs.get(s.toLowerCase()) || 0) >= minSender ? s : `(senders with fewer than ${minSender} documents)`;
  };

  const truths = new Map<string, UnitTruth | null>(units.map((u) => [u.id, unitTruth(u, byId)]));
  const add = (t: Tally, u: IntakeItem) => {
    const tr = truths.get(u.id);
    t.units++;
    if (u.shadow!.would === 'auto_file') t.auto++;
    else t.staff++;
    if (tr) t.confirmed++;
    if (u.shadow!.would === 'auto_file' && tr && tr.kind !== 'unreadable') {
      t.auto_confirmed++;
      if (!wrongPatient(u, byId)) t.auto_right++;
    }
    if (wrongPatient(u, byId)) t.wrong++;
  };
  const group = <K extends string>(key: (u: IntakeItem) => string, field: K, order?: string[]) => {
    const m = new Map<string, Tally>();
    for (const d of docs) {
      const k = key(d);
      const t = m.get(k) || tally();
      t.docs++;
      m.set(k, t);
    }
    for (const u of units) {
      const k = key(rootOf(u));
      const t = m.get(k) || tally();
      add(t, u);
      m.set(k, t);
    }
    const rows = [...m.entries()].map(([k, t]) => ({ [field]: k, ...t }) as Tally & Record<K, string>);
    return order ? rows.sort((a, b) => order.indexOf(a[field]) - order.indexOf(b[field])) : rows.sort((a, b) => b.docs - a.docs || a[field].localeCompare(b[field]));
  };

  const all = tally();
  for (const u of units) add(all, u);

  const wrong = { total: 0, different_patient: 0, not_iki: 0, several: 0 };
  let autoUnreadable = 0;
  let patientDocs = 0;
  let patientDocsAuto = 0;
  const cat = { right: 0, of: 0, rate: null as number | null, auto_right: 0, auto_of: 0, none_predicted: 0 };
  let disagreements = 0;
  const reasons = new Map<string, { units: number; confirmed: number; candidate_right: number }>();
  for (const u of units) {
    const d = u.shadow!;
    const t = truths.get(u.id);
    const w = wrongPatient(u, byId);
    if (w) {
      wrong.total++;
      wrong[w]++;
    }
    if (d.would === 'auto_file' && t?.kind === 'unreadable') autoUnreadable++;
    if (t?.kind === 'patient') {
      patientDocs++;
      if (d.would === 'auto_file' && !w) patientDocsAuto++;
      if (t.category) {
        if (!d.category) cat.none_predicted++;
        cat.of++;
        const ok = !!d.category && d.category.trim().toLowerCase() === t.category.trim().toLowerCase();
        if (ok) cat.right++;
        if (d.would === 'auto_file') {
          cat.auto_of++;
          if (ok) cat.auto_right++;
        }
      }
    }
    if (agreement(u, byId) === 'disagrees') disagreements++;
    if (d.would === 'staff') {
      const r = reasons.get(d.code) || { units: 0, confirmed: 0, candidate_right: 0 };
      r.units++;
      if (t) r.confirmed++;
      if (t?.kind === 'patient' && d.patient_key && d.patient_key.trim().toUpperCase() === t.key.trim().toUpperCase()) r.candidate_right++;
      reasons.set(d.code, r);
    }
  }
  cat.rate = rate(cat.right, cat.of);
  for (const p of parents) if (agreement(p, byId) === 'disagrees') disagreements++;

  const failedBy: Record<string, number> = {};
  for (const f of failed) failedBy[f.error_code || 'UNKNOWN'] = (failedBy[f.error_code || 'UNKNOWN'] || 0) + 1;

  const fullyAuto = docs.filter((d) => {
    if (d.shadow?.would === 'auto_file') return true;
    if (d.shadow?.would !== 'split') return false;
    const kids = (d.split?.children || []).map(byId);
    return kids.length > 0 && kids.every((k) => k?.shadow?.would === 'auto_file');
  }).length;
  const confirmedDocs = docs.filter((d) => {
    if (d.truth) return true;
    if (d.shadow?.would === 'split') return (d.split?.children || []).every((c) => {
      const k = byId(c);
      return !!k && !!unitTruth(k, byId);
    });
    return false;
  }).length;

  const splitTruth = parents.filter((p) => p.truth?.outcome === 'several');
  const groupsExact = splitTruth.filter((p) => agreement(p, byId) === 'agrees').length;

  // Layouts: sender + label words of the root document.
  const layouts = new Map<string, { sender: string; labels: string[]; docs: IntakeItem[] }>();
  if (opts.text) {
    for (const d of docs) {
      const text = opts.text(d.id);
      if (!text.trim()) continue;
      const labels = layoutLabels(text);
      const sender = senderOf(d);
      const key = `${sender.toLowerCase()}|${labels.join(',')}`;
      const l = layouts.get(key) || { sender, labels, docs: [] };
      l.docs.push(d);
      layouts.set(key, l);
    }
  }
  const layoutRows = [...layouts.values()]
    .sort((a, b) => b.docs.length - a.docs.length)
    .slice(0, opts.topLayouts ?? 10)
    .map((l) => {
      const ids = new Set(l.docs.map((d) => d.id));
      const us = units.filter((u) => ids.has(rootOf(u).id));
      const confs = l.docs.map((d) => d.ocr).filter((o) => o && !o.used_text_layer).map((o) => o!.mean_confidence);
      const why = new Map<string, number>();
      for (const u of us) if (u.shadow!.would === 'staff') why.set(u.shadow!.code, (why.get(u.shadow!.code) || 0) + 1);
      const top = [...why.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        layout: `L-${createHash('sha256').update(`${l.sender.toLowerCase()}|${l.labels.join(',')}`).digest('hex').slice(0, 6)}`,
        sender: l.sender,
        docs: l.docs.length,
        units: us.length,
        auto: us.filter((u) => u.shadow!.would === 'auto_file').length,
        pages_median: median(l.docs.map((d) => d.page_count || d.ocr?.pages || 0).filter(Boolean)),
        ocr_mean: confs.length ? Math.round((10 * confs.reduce((a, b) => a + b, 0)) / confs.length) / 10 : null,
        top_reason: top ? REASON_LABEL[top[0]] || top[0] : '',
        labels: l.labels,
      };
    });

  const received = docs.map((d) => d.received_at).sort();
  return {
    generated_at: opts.now.toISOString(),
    period: received.length ? { first: received[0].slice(0, 10), last: received[received.length - 1].slice(0, 10) } : null,
    documents: docs.length,
    units: units.length,
    split_parents: parents.length,
    pending: pending.length,
    failed: failed.length,
    failed_by_code: failedBy,
    undecided: undecided.length,
    would_auto_file: all.auto,
    would_staff: all.staff,
    auto_file_rate: rate(all.auto, all.units),
    documents_fully_auto: fullyAuto,
    documents_decided: docs.filter((d) => d.shadow).length,
    confirmed_units: all.confirmed,
    confirmed_documents: confirmedDocs,
    precision: { right: all.auto_right, of: all.auto_confirmed, rate: rate(all.auto_right, all.auto_confirmed) },
    wrong_patient: wrong,
    auto_unreadable: autoUnreadable,
    auto_rate_on_confirmed_patient_docs: { auto: patientDocsAuto, of: patientDocs, rate: rate(patientDocsAuto, patientDocs) },
    category: cat,
    disagreements,
    staff_reasons: [...reasons.entries()]
      .sort((a, b) => b[1].units - a[1].units || a[0].localeCompare(b[0]))
      .map(([code, r]) => ({ code, label: REASON_LABEL[code] || code, units: r.units, share: rate(r.units, all.staff), confirmed: r.confirmed, candidate_right: r.candidate_right })),
    splits: { parents: parents.length, confirmed_several: splitTruth.length, groups_exact: groupsExact },
    by_sender: group(senderOf, 'sender'),
    by_quality: group((d) => qualityBand(d), 'quality', QUALITY_ORDER),
    by_origin: group(originOf, 'origin'),
    layouts: layoutRows,
  };
}

// ── Markdown ─────────────────────────────────────────────────────────────────

const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '/');

function tallyTable<K extends string>(first: string, rows: (Tally & Record<K, string>)[], key: K): string {
  if (!rows.length) return '_None yet._\n';
  return [
    `| ${first} | Documents | Units | Would auto-file | Confirmed | Precision | Wrong-patient |`,
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map((r) => `| ${cell(r[key])} | ${r.docs} | ${r.units} | ${r.auto} (${pct(r.auto, r.units)}) | ${r.confirmed} | ${pct(r.auto_right, r.auto_confirmed)} | ${r.wrong ? `**${r.wrong}**` : 0} |`),
  ].join('\n') + '\n';
}

export function shadowReportMarkdown(r: ShadowReport): string {
  const p = (x: { rate: number | null }, n: number, d: number) => (x.rate === null ? 'n/a' : `${pct(n, d)} (${n} of ${d})`);
  const reasons = r.staff_reasons.length
    ? [
        '| Reason | Units | Share of staff | Confirmed | Candidate shown was right |',
        '|---|---:|---:|---:|---:|',
        ...r.staff_reasons.map((x) => `| ${cell(x.label)} | ${x.units} | ${pct(x.units, r.would_staff)} | ${x.confirmed} | ${x.candidate_right} |`),
      ].join('\n') + '\n'
    : '_None yet._\n';
  const layouts = r.layouts.length
    ? [
        '| Layout | Sender | Documents | Units | Would auto-file | Pages (median) | OCR confidence (mean) | Top reason for staff | Labels, in order |',
        '|---|---|---:|---:|---:|---:|---:|---|---|',
        ...r.layouts.map(
          (l) => `| ${l.layout} | ${cell(l.sender)} | ${l.docs} | ${l.units} | ${l.auto} (${pct(l.auto, l.units)}) | ${l.pages_median || 'n/a'} | ${l.ocr_mean ?? 'n/a'} | ${cell(l.top_reason) || '-'} | ${cell(l.labels.join(' > ')) || '-'} |`
        ),
      ].join('\n') + '\n'
    : '_No document text available._\n';
  const failed = Object.entries(r.failed_by_code).sort((a, b) => b[1] - a[1]);
  return `# Drawbridge document intake: shadow-mode report

Generated ${r.generated_at}${r.period ? `, documents received ${r.period.first} to ${r.period.last}` : ''}.

Shadow mode: every document was read and matched against the clinic's patient list, and Drawbridge recorded what it would have done. Nothing was filed. Staff confirmed the right answer on the Confirm panel. This report holds counts and percentages only.

## Summary

| | |
|---|---:|
| Documents received | ${r.documents} |
| Units decided (whole documents and split parts) | ${r.units} |
| **Would auto-file** | **${r.would_auto_file}** (${r.auto_file_rate === null ? 'n/a' : pct(r.would_auto_file, r.units)}) |
| Would go to staff | ${r.would_staff} (${pct(r.would_staff, r.units)}) |
| Documents handled with no staff step (all parts auto-filed) | ${r.documents_fully_auto} of ${r.documents_decided} decided (${pct(r.documents_fully_auto, r.documents_decided)}) |
| Units confirmed by staff | ${r.confirmed_units} (${pct(r.confirmed_units, r.units)}) |
| **Wrong-patient auto-files** (must be 0) | **${r.wrong_patient.total}** |
| Precision: would auto-file and confirmed the same patient | ${p(r.precision, r.precision.right, r.precision.of)} |
| Auto-file rate on confirmed single-patient IKI documents | ${p(r.auto_rate_on_confirmed_patient_docs, r.auto_rate_on_confirmed_patient_docs.auto, r.auto_rate_on_confirmed_patient_docs.of)} |
| Category accuracy (confirmed, category given) | ${p(r.category, r.category.right, r.category.of)} |
| Category accuracy on the units it would auto-file | ${r.category.auto_of ? `${pct(r.category.auto_right, r.category.auto_of)} (${r.category.auto_right} of ${r.category.auto_of})` : 'n/a'} |
| Prediction and confirmation disagree | ${r.disagreements} |
| Failed (see below) | ${r.failed} |
| Waiting to be read | ${r.pending} |
| Finished before shadow mode was on (no decision) | ${r.undecided} |

## Wrong-patient auto-files

| Kind | Units |
|---|---:|
| Filed to another patient | ${r.wrong_patient.different_patient} |
| Not an IKI patient | ${r.wrong_patient.not_iki} |
| Several patients in one filed document | ${r.wrong_patient.several} |
| **Total** | **${r.wrong_patient.total}** |

Not counted as wrong: ${r.auto_unreadable} unit(s) it would auto-file that staff marked unreadable (check these by hand).

## Why documents would go to staff (ranked)

${reasons}
"Candidate shown was right": staff confirmed the patient Drawbridge showed as the candidate. A reason with many of these is where a new rule or template could move documents to auto-file.

## Batch files split by patient

| | |
|---|---:|
| Files split | ${r.splits.parents} |
| ...confirmed as several patients with pages | ${r.splits.confirmed_several} |
| ...split exactly as staff confirmed (same page groups) | ${r.splits.groups_exact} |

## By sender

${tallyTable('Sender', r.by_sender, 'sender')}
Senders with fewer than the threshold of documents are pooled; a label that could be a person's name is never shown.

## By fax quality

${tallyTable('Quality', r.by_quality, 'quality')}
## By origin

${tallyTable('Origin', r.by_origin, 'origin')}
## Top sender layouts by volume (template candidates)

${layouts}
A layout is a sender plus the label words on its first patient page, in reading order (a fixed vocabulary: no values). The busiest layouts with many documents going to staff are the candidates for sender-specific templates.

## Failures

${failed.length ? ['| Code | Items |', '|---|---:|', ...failed.map(([c, n]) => `| ${cell(c)} | ${n} |`)].join('\n') : '_None._'}

## Definitions

- **Would auto-file**: two identifiers matched one patient in the list, OCR confidence above the gate, the page check passed, a specific category, not a duplicate, the sender not set to staff review (the live auto-file rules).
- **Wrong-patient auto-file**: a unit it would auto-file whose confirmed truth is another patient, not an IKI patient, or several patients (for a split part: any of its pages confirmed to someone else).
- **Precision**: of the units it would auto-file that staff confirmed (unreadable left out), the share confirmed to the same patient.
- **Disagree**: the patient it would file to or showed as the candidate is not the confirmed one, a document it would auto-file is not one IKI patient's, the categories differ, or a split's page groups differ.
`;
}

// ── Leak check and the per-document file ─────────────────────────────────────

/** Identifiers in the store: full names, dates of birth (MM/DD/YYYY), MRNs and chart keys of 5+ characters. */
export function identifiersOf(items: IntakeItem[]): { names: string[]; tokens: string[] } {
  const names = new Set<string>();
  const tokens = new Set<string>();
  const person = (p?: { name?: string; dateOfBirth?: string; mrn?: string; key?: string; chartPatientId?: string }) => {
    if (!p) return;
    if (p.name && p.name.trim().split(/\s+/).length >= 2) names.add(p.name.trim().toLowerCase().replace(/\s+/g, ' '));
    for (const t of [p.dateOfBirth, p.mrn, p.key, p.chartPatientId]) if (t && t.trim().length >= 5) tokens.add(t.trim().toLowerCase());
  };
  for (const i of items) {
    person(i.match?.patient);
    person(i.truth?.patient);
    for (const x of i.truth?.parts || []) person(x.patient);
    const x = i.extracted;
    if (x?.patient_name) names.add(`${x.patient_name.value.first} ${x.patient_name.value.last}`.toLowerCase());
    for (const t of [x?.dob?.value, x?.mrn?.value, x?.phone?.value]) if (t && t.trim().length >= 5) tokens.add(t.trim().toLowerCase());
  }
  return { names: [...names], tokens: [...tokens] };
}

/** How many identifiers appear in `text` (names anywhere, other identifiers as whole tokens). 0 = safe to write. */
export function findLeaks(text: string, ids: { names: string[]; tokens: string[] }): number {
  const t = text.toLowerCase();
  let n = 0;
  for (const name of ids.names) if (name.length >= 5 && t.includes(name)) n++;
  for (const tok of ids.tokens) {
    const re = new RegExp(`(^|[^a-z0-9/])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9/])`);
    if (re.test(t)) n++;
  }
  return n;
}

export const PHI_CSV_WARNING = '# CONTAINS PHI (patient names, dates of birth, MRNs). For IKI/MOATiT staff only. Keep it inside the data center; never email or copy it out.';

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per unit and split parent, with identifiers: staff use only (written inside the data directory). */
export function documentCsv(items: IntakeItem[]): string {
  const byIdMap = new Map(items.map((i) => [i.id, i]));
  const byId = (id: string) => byIdMap.get(id);
  const header = [
    'item_id', 'parent_id', 'part', 'received_at', 'origin', 'file_name', 'sender', 'pages', 'quality', 'status',
    'would', 'reason', 'predicted_patient', 'predicted_dob', 'predicted_mrn', 'predicted_key', 'predicted_category',
    'truth', 'truth_patient', 'truth_dob', 'truth_mrn', 'truth_key', 'truth_category', 'confirmed_by', 'agreement', 'wrong_patient',
  ];
  const rows = items
    .filter((i) => i.shadow)
    .sort((a, b) => a.received_at.localeCompare(b.received_at))
    .map((i) => {
      const root = i.parent_id ? byId(i.parent_id) || i : i;
      const d = i.shadow!;
      const t = i.truth;
      const tp = t?.patient;
      const severalText = t?.outcome === 'several' ? (t.parts || []).map((p) => `${p.pages.join('.')}=${p.patient ? p.patient.name : 'not IKI'}`).join('; ') : '';
      return [
        i.id, i.parent_id || '', i.part ? `${i.part.index + 1}/${i.part.of}` : '', i.received_at, originOf(root), i.file?.name || '',
        root.extracted?.sender?.value || '', i.page_count || i.ocr?.pages || '', qualityBand(root), i.status,
        d.would, REASON_LABEL[d.code] || d.code, i.match?.patient?.name || '', i.match?.patient?.dateOfBirth || '', i.match?.patient?.mrn || '',
        d.patient_key || '', d.category || '', t ? t.outcome : '', tp?.name || severalText, tp?.dateOfBirth || '', tp?.mrn || '', tp?.key || '',
        t?.category || '', t?.by || '', agreement(i, byId), wrongPatient(i, byId),
      ].map(csvCell).join(',');
    });
  return [PHI_CSV_WARNING, header.join(','), ...rows].join('\n') + '\n';
}
