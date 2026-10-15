import express, { Request, Response, Router } from 'express';
import { APP_BASE, esc, fmtTime } from '../../shell';
import type { DocTypeSource } from './doctypes';
import { normDob, toCandidates } from './match';
import { loadRoster, normKey, rosterPath, RosterError, rosterDob, type RosterPatient } from './roster';
import { agreement, observedTruth, parsePageList, REASON_LABEL, shadowMode, unitTruth, type Agreement, type GroundTruth, type StaffObservation, type TruthPatient } from './shadow';
import { IntakeItem, IntakeStore } from './store';

/**
 * Shadow mode on the staff screens (shadow.ts): the prediction, the Confirm panel that records
 * ground truth, and the queue's confirmation filters. Patient search on the panel uses the same
 * search as matching (the read-only Veradigm® search, or the local roster when INTAKE_ROSTER_CSV is
 * set), by POST: names never travel in a URL, so they never reach an access log.
 */
export const CONFIRM_FILTERS = { needs: 'Needs confirmation', confirmed: 'Confirmed', disagrees: 'Disagrees' } as const;
export type ConfirmFilter = keyof typeof CONFIRM_FILTERS;
/** Rows for "several patients". */
export const SEVERAL_ROWS = 8;

export const SHADOW_MESSAGES: Record<string, string> = {
  confirmed: 'Saved as confirmed.',
  truth_cleared: 'Confirmation removed.',
  truth_not_shadow: 'Confirming is only available in shadow mode.',
  truth_no_prediction: 'There is no predicted patient to accept. Pick the patient instead.',
  truth_patient_unknown: 'That patient is not in the patient list (or the ID matches more than one). Search again.',
  truth_pages_bad: 'Check the pages: each row needs pages within the document (e.g. 1-3) and a patient, and no page twice.',
  truth_category_unknown: 'That category is not in the category list.',
  roster_unavailable: 'The patient search is not available right now. Try again, or tell the administrator.',
  category_shadow: 'In shadow mode the suggested category stays as it was. Give the right category in the Confirm panel.',
};

const pill = (cls: string, text: string) => `<span class="pill ${cls}">${esc(text)}</span>`;
const AGREE_PILL: Record<Agreement, string> = {
  undecided: '',
  unconfirmed: pill('warn', 'Needs confirmation'),
  agrees: pill('ok', 'Confirmed'),
  disagrees: pill('urgent', 'Disagrees'),
};

export function confirmFilter(v: unknown): ConfirmFilter | '' {
  return typeof v === 'string' && v in CONFIRM_FILTERS ? (v as ConfirmFilter) : '';
}

export function byIdOf(items: IntakeItem[]): (id: string) => IntakeItem | undefined {
  const m = new Map(items.map((i) => [i.id, i]));
  return (id) => m.get(id);
}

/** Items in a confirmation bucket. */
export function filterByConfirmation(items: IntakeItem[], f: ConfirmFilter | '', byId: (id: string) => IntakeItem | undefined): IntakeItem[] {
  if (!f) return items;
  return items.filter((i) => {
    const a = agreement(i, byId);
    return f === 'needs' ? a === 'unconfirmed' : f === 'disagrees' ? a === 'disagrees' : a === 'agrees' || a === 'disagrees';
  });
}

export function shadowCounts(items: IntakeItem[], byId: (id: string) => IntakeItem | undefined) {
  const c = { auto_file: 0, staff: 0, needs: 0, disagrees: 0 };
  for (const i of items) {
    if (i.shadow?.would === 'auto_file') c.auto_file++;
    if (i.shadow?.would === 'staff') c.staff++;
    const a = agreement(i, byId);
    if (a === 'unconfirmed') c.needs++;
    if (a === 'disagrees') c.disagrees++;
  }
  return c;
}

/** The queue's shadow cards and filter (above the list). */
export function shadowQueueHeader(all: IntakeItem[], f: ConfirmFilter | '', status: string): string {
  const byId = byIdOf(all);
  const c = shadowCounts(all, byId);
  const link = (k: ConfirmFilter, n: number, label: string, color = '') =>
    `<a class="card" href="${APP_BASE}/intake?confirm=${k}" style="text-decoration:none;color:inherit"><div class="muted">${esc(label)}</div><div class="stat"${color && n ? ` style="color:var(--${color})"` : ''}>${esc(n)}</div></a>`;
  return `<div class="card" style="border-color:var(--accent)"><strong>Shadow mode.</strong> Documents are read and matched against the clinic's patient list, and Drawbridge records what it would have done. Nothing is filed to Veradigm® EHR. Confirm each document so the results can be measured.</div>
<div class="grid">
<div class="card"><div class="muted">Would auto-file</div><div class="stat">${esc(c.auto_file)}</div></div>
<div class="card"><div class="muted">Would go to staff</div><div class="stat">${esc(c.staff)}</div></div>
${link('needs', c.needs, 'Needs confirmation', 'warn')}${link('disagrees', c.disagrees, 'Disagrees', 'urgent')}</div>
<form class="card row" method="get" action="${APP_BASE}/intake" style="align-items:flex-end">${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ''}
<label style="min-width:200px">Confirmation<select name="confirm"><option value="">All</option>${(Object.keys(CONFIRM_FILTERS) as ConfirmFilter[])
    .map((k) => `<option value="${k}"${k === f ? ' selected' : ''}>${esc(CONFIRM_FILTERS[k])}</option>`)
    .join('')}</select></label><button>Show</button>${f ? `<a href="${APP_BASE}/intake${status ? `?status=${encodeURIComponent(status)}` : ''}">Clear</a>` : ''}</form>`;
}

/** The queue's per-row shadow cell. */
export function shadowCell(i: IntakeItem, byId: (id: string) => IntakeItem | undefined): string {
  const d = i.shadow;
  if (!d) return '<span class="muted">—</span>';
  const would = d.would === 'auto_file' ? pill('ok', 'Would auto-file') : d.would === 'split' ? pill('ok', 'Split') : pill('', 'Would go to staff');
  return `${would} ${AGREE_PILL[agreement(i, byId)]}`;
}

const patientText = (p?: { name: string; dateOfBirth: string; mrn?: string }) =>
  p ? `${esc(p.name)} · DOB ${esc(p.dateOfBirth)}${p.mrn ? ` · MRN ${esc(p.mrn)}` : ''}` : '';

function truthText(t: GroundTruth): string {
  const who = `<span class="muted" style="font-size:13px"> · ${esc(t.by)} · ${esc(fmtTime(t.at))}${t.accepted ? ' · accepted as predicted' : ''}</span>`;
  if (t.outcome === 'patient') return `${patientText(t.patient)}${t.category ? ` · ${esc(t.category)}` : ''}${who}`;
  if (t.outcome === 'not_iki') return `Not a clinic patient${who}`;
  if (t.outcome === 'unreadable') return `Unreadable${who}`;
  const parts = (t.parts || [])
    .map((p) => `<li>${esc(pageText(p.pages))}: ${p.patient ? patientText(p.patient) : 'not a clinic patient'}${p.category ? ` · ${esc(p.category)}` : ''}</li>`)
    .join('');
  return `Several patients${who}${parts ? `<ul>${parts}</ul>` : ''}`;
}

/** What the staff filing observer saw (observe.ts). */
function observedText(o?: StaffObservation): string {
  if (!o) return '<span class="muted">Not looked for yet (Drawbridge looks in the charts about a day after a document arrives).</span>';
  const when = `<span class="muted" style="font-size:13px"> · checked ${esc(fmtTime(o.at))}, ${esc(o.looked_in)} chart(s)</span>`;
  if (o.status === 'found') {
    const used = observedTruth(o) ? '' : ' <span class="muted">(low confidence: not used)</span>';
    return `Filed by staff to ${patientText(o.patient)}${o.category ? ` under <strong>${esc(o.category)}</strong>` : ''} · document ${esc(o.document_id)} ${pill(o.confidence === 'high' ? 'ok' : 'warn', `${o.confidence} confidence`)}${used}${o.signals?.length ? `<div class="muted" style="font-size:13px">${esc(o.signals.join(' · '))}</div>` : ''}${when}`;
  }
  if (o.status === 'ambiguous') return `Two documents in different charts fit equally well: confirm by hand.${when}`;
  if (o.status === 'not_observed') return `Not found in the charts looked at${o.error_code ? ` (${esc(o.error_code)})` : ''}: confirm by hand.${when}`;
  if (o.status === 'error') return `The check failed (${esc(o.error_code || 'error')}); it will be tried again.${when}`;
  return `Not found yet; Drawbridge will look again.${when}`;
}

const pageText = (ps: number[]) => (ps.length === 1 ? `page ${ps[0]}` : ps[ps.length - 1] - ps[0] === ps.length - 1 ? `pages ${ps[0]}-${ps[ps.length - 1]}` : `pages ${ps.join(', ')}`);

export interface ShadowPanelContext {
  /** Every item (for parents and parts). */
  byId: (id: string) => IntakeItem | undefined;
  /** Category names from the list. */
  categories: string[];
  /** A roster search just run on this page. */
  search?: { q: string; results: RosterPatient[]; error?: string };
}

/** Prediction + Confirm panel for the item page. */
export function shadowPanel(i: IntakeItem, ctx: ShadowPanelContext): string {
  const d = i.shadow;
  const action = `${APP_BASE}/intake/item/${encodeURIComponent(i.id)}`;
  const catSelect = (name: string, selected = '', blank = 'Category (optional)') =>
    `<select name="${name}" aria-label="Chart category"><option value="">${esc(blank)}</option>${ctx.categories
      .map((c) => `<option value="${esc(c)}"${c.toLowerCase() === selected.toLowerCase() ? ' selected' : ''}>${esc(c)}</option>`)
      .join('')}</select>`;
  const button = (act: string, label: string, secondary = false, extra = '') =>
    `<form method="post" action="${action}/confirm" style="margin:0"><input type="hidden" name="action" value="${act}">${extra}<button${secondary ? ' class="secondary"' : ''}>${esc(label)}</button></form>`;

  const predicted = i.match?.patient;
  let would = '<span class="muted">Not decided yet (still being read, or failed).</span>';
  if (d?.would === 'auto_file') would = `${pill('ok', 'Auto-file')} to ${patientText(predicted)}${d.category ? ` under <strong>${esc(d.category)}</strong>` : ''}`;
  else if (d?.would === 'split') would = `${pill('ok', 'Split')} ${esc(d.reason)}`;
  else if (d) would = `${pill('', 'Send to staff')} ${esc(REASON_LABEL[d.code] || d.code)}: ${esc(d.reason)}${predicted ? `<div class="muted" style="font-size:13px">Candidate shown to staff: ${patientText(predicted)}</div>` : ''}${d.category ? `<div class="muted" style="font-size:13px">Suggested category: ${esc(d.category)}</div>` : ''}`;
  const t = i.truth;
  const derived = !t ? unitTruth(i, ctx.byId) : null;
  const fromParent = derived?.source === 'parent';
  const agree = agreement(i, ctx.byId);
  const state = t
    ? truthText(t)
    : derived?.source === 'observed'
      ? '<span class="muted">From staff filing in Veradigm® EHR (above).</span>'
      : fromParent && derived
        ? `<span class="muted">From the confirmation of the whole file (${esc(derived.kind === 'patient' ? 'patient confirmed' : derived.kind.replace('_', ' '))}).</span>`
        : '<span class="muted">Not confirmed yet.</span>';

  const staffFiling = d && d.would !== 'split' ? `<dt>Staff filed it</dt><dd>${observedText(i.observed)}</dd>` : '';
  const summary = `<div class="card"><dl><dt>Drawbridge would</dt><dd>${would}</dd>${staffFiling}<dt>Confirmed</dt><dd>${state} ${agree === 'agrees' || agree === 'disagrees' ? AGREE_PILL[agree] : ''}</dd></dl>
<p class="muted" style="font-size:13px;margin-bottom:0">Shadow mode: nothing is filed. Where staff filed the document in Veradigm® EHR is read back and used as the answer. When it isn't found, check the original and confirm the right answer below.</p></div>`;

  if (!d) return `<h2>Shadow mode</h2>${summary}`;

  const isSplit = d.would === 'split';
  const accept = isSplit
    ? button('accept', 'The split is right', false)
    : predicted
      ? button('accept', `Correct: ${predicted.name}${d.category ? `, ${d.category}` : ''}`)
      : '';

  const s = ctx.search;
  const results = s
    ? s.error
      ? `<p style="color:var(--urgent)">${esc(s.error)}</p>`
      : s.results.length
        ? `<form method="post" action="${action}/confirm"><input type="hidden" name="action" value="patient"><input type="hidden" name="q" value="${esc(s.q)}"><div class="scroll"><table><thead><tr><th></th><th>Patient</th><th>DOB</th><th>MRN</th><th>Chart</th></tr></thead><tbody>${s.results
            .map(
              (p, k) =>
                `<tr><td><input type="radio" name="patient_key" value="${esc(p.key)}" id="pk${k}"${k === 0 && s.results.length === 1 ? ' checked' : ''} required style="width:auto"></td><td><label for="pk${k}">${esc(`${p.last}, ${p.first}${p.middle ? ` ${p.middle}` : ''}`)}</label></td><td>${esc(p.dob)}</td><td>${esc(p.mrns.join(' / '))}</td><td>${esc(p.key)}</td></tr>`
            )
            .join('')}</tbody></table></div><div class="row" style="margin-top:8px">${catSelect('category', d.category || '')}<button>Save: this patient</button></div></form>`
        : '<p class="muted">No patient in the list matches.</p>'
    : '';

  const severalRows = Array.from({ length: SEVERAL_ROWS }, (_, k) => {
    const pre = isSplit && i.split?.pages[k] ? pageText(i.split.pages[k]).replace(/^pages? /, '') : '';
    return `<tr><td><input name="pages_${k}" value="${esc(pre)}" placeholder="e.g. 1-2" aria-label="Pages, row ${k + 1}"></td><td><input name="patient_${k}" placeholder="MRN, or none" aria-label="Patient, row ${k + 1}"></td><td>${catSelect(`category_${k}`)}</td></tr>`;
  }).join('');

  const confirm = `<div class="card">
${accept ? `<div class="row">${accept}<span class="muted" style="font-size:13px">when the prediction is right</span></div><hr style="border:0;border-top:1px solid var(--line);margin:12px 0">` : ''}
<form method="post" action="${action}/find" class="row" style="align-items:flex-end"><label style="flex:1;min-width:220px">Find the right patient<input name="q" value="${esc(s?.q || '')}" maxlength="80" placeholder="Last name, first name, DOB or MRN" autocomplete="off"></label><button class="secondary">Search the patient list</button></form>
${results}
<hr style="border:0;border-top:1px solid var(--line);margin:12px 0">
<div class="row">${button('not_iki', 'Not a clinic patient', true)}${button('unreadable', 'Unreadable', true)}${t ? button('clear', 'Remove confirmation', true) : ''}</div>
<details style="margin-top:12px"${isSplit ? ' open' : ''}><summary><strong>Several patients</strong> <span class="muted" style="font-size:13px">which pages belong to whom${i.page_count ? ` (${esc(i.page_count)} page(s))` : ''}</span></summary>
<form method="post" action="${action}/confirm" style="margin-top:8px"><input type="hidden" name="action" value="several"><div class="scroll"><table><thead><tr><th>Pages</th><th>Patient (MRN${rosterPath() ? ' or chart ID' : ''}; "none" = not a clinic patient)</th><th>Category</th></tr></thead><tbody>${severalRows}</tbody></table></div>
<button>Save: several patients</button></form></details></div>`;

  return `<h2>Shadow mode</h2>${summary}<h2>Confirm</h2>${confirm}`;
}

// ── Patient search for the panel ─────────────────────────────────────────────

type RunTool = (name: string, args: any) => Promise<any>;

export class DirectoryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Find and resolve patients for ground truth: the roster when set, else the read-only Veradigm® search. */
export interface PatientDirectory {
  source: 'roster' | 'veradigm';
  /** Staff search text: "Last, First", a DOB, an MRN (live search needs a last name or an MRN). */
  find(q: string): Promise<RosterPatient[]>;
  /** One patient by MRN (or roster key); null when none or several. */
  resolve(id: string): Promise<RosterPatient | null>;
}

const fromCandidates = (r: any): RosterPatient[] =>
  toCandidates(r)
    .filter((c) => c.chartPatientId)
    .map((c) => ({ key: c.chartPatientId, patientId: c.patientId, first: c.firstName, middle: '', last: c.lastName, dob: normDob(c.dateOfBirth) || c.dateOfBirth, mrns: c.mrns || [c.mrn], phones: c.phones, ssnLast4: '', addresses: [] }));

export function patientDirectory(runTool: RunTool | null): PatientDirectory {
  if (rosterPath()) {
    return {
      source: 'roster',
      find: async (q) => loadRoster().find(q),
      resolve: async (id) => loadRoster().resolve(id),
    };
  }
  const search = async (args: Record<string, string>) => {
    if (!runTool) throw new DirectoryError('SEARCH_NOT_CONFIGURED');
    let r: any;
    try {
      r = await runTool('unity_search_patients', args);
    } catch {
      throw new DirectoryError('SEARCH_FAILED');
    }
    if (!r || r.success === false || !Array.isArray(r.patients)) throw new DirectoryError(String(r?.error_code || 'SEARCH_FAILED'));
    return fromCandidates(r);
  };
  return {
    source: 'veradigm',
    async find(q) {
      const words: string[] = [];
      const args: Record<string, string> = {};
      for (const t of String(q ?? '').split(/[\s,]+/).filter(Boolean).slice(0, 6)) {
        if (/^\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}$|^\d{8}$/.test(t)) args.dateOfBirth = rosterDob(t);
        else if (/\d/.test(t)) args.mrn = t;
        else words.push(t);
      }
      if (words[0]) args.lastName = words[0];
      if (words[1]) args.firstName = words[1];
      if (!args.lastName && !args.mrn) throw new DirectoryError('SEARCH_NEEDS_NAME');
      const rows = await search(args);
      return args.mrn ? rows.filter((p) => p.mrns.some((m) => normKey(m) === normKey(args.mrn))) : rows;
    },
    async resolve(id) {
      if (!normKey(id)) return null;
      const rows = (await search({ mrn: id })).filter((p) => p.mrns.some((m) => normKey(m) === normKey(id)) || normKey(p.key) === normKey(id));
      return rows.length === 1 ? rows[0] : null;
    },
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

const snapshot = (p: RosterPatient): TruthPatient => ({
  key: p.key,
  name: [p.first, p.middle, p.last].filter(Boolean).join(' '),
  dateOfBirth: p.dob,
  mrn: p.mrns[0] || '',
});

export interface ConfirmDeps {
  store: () => IntakeStore;
  categories: () => DocTypeSource | null;
  /** The read-only patient search (shadow mode's runTool); unused when the roster is set. */
  runTool: () => RunTool | null;
  /** Render the item page with a roster search on it. */
  render: (req: Request, res: Response, item: IntakeItem, search: ShadowPanelContext['search']) => void;
}

/** POST /item/:id/find and /item/:id/confirm (shadow mode only). */
export function mountConfirmRoutes(router: Router, deps: ConfirmDeps): void {
  const user = (req: any) => String(req.drawbridgeUser || 'staff');
  const back = (res: Response, id: string, m: string) => res.redirect(`${APP_BASE}/intake/item/${encodeURIComponent(id)}?m=${encodeURIComponent(m)}`);
  const body = express.urlencoded({ extended: false, limit: '16kb' });

  router.post('/item/:id/find', body, async (req, res) => {
    const item = deps.store().get(req.params.id);
    if (!item) {
      res.status(404).send('Not found');
      return;
    }
    if (!shadowMode()) {
      back(res, item.id, 'truth_not_shadow');
      return;
    }
    const q = String(req.body?.q || '').slice(0, 80);
    try {
      deps.render(req, res, item, { q, results: await patientDirectory(deps.runTool()).find(q) });
    } catch (e) {
      const code = e instanceof RosterError || e instanceof DirectoryError ? e.code : 'SEARCH_FAILED';
      const msg = code === 'SEARCH_NEEDS_NAME' ? 'Type a last name (then a first name), or an MRN.' : `${SHADOW_MESSAGES.roster_unavailable} (${code})`;
      deps.render(req, res, item, { q, results: [], error: msg });
    }
  });

  router.post('/item/:id/confirm', body, async (req, res) => {
    const store = deps.store();
    const item = store.get(req.params.id);
    if (!item) {
      res.status(404).send('Not found');
      return;
    }
    if (!shadowMode()) {
      back(res, item.id, 'truth_not_shadow');
      return;
    }
    const b = req.body || {};
    const act = String(b.action || '');
    const by = user(req);
    const at = new Date().toISOString();
    let categories: string[] | null = null;
    const category = async (raw: unknown): Promise<string | undefined | false> => {
      const v = String(raw || '').trim();
      if (!v) return undefined;
      if (!categories) {
        try {
          const src = deps.categories();
          categories = src ? (await src.list()).map((t) => t.name) : [];
        } catch {
          categories = [];
        }
      }
      return categories.find((c) => c.toLowerCase() === v.toLowerCase()) || false;
    };
    const save = (truth: GroundTruth | undefined, what: string) => {
      store.update(item.id, { truth }, what, by);
      back(res, item.id, truth ? 'confirmed' : 'truth_cleared');
    };

    if (act === 'clear') return save(undefined, 'confirmation removed');
    if (act === 'not_iki') return save({ at, by, outcome: 'not_iki' }, 'confirmed: not a clinic patient');
    if (act === 'unreadable') return save({ at, by, outcome: 'unreadable' }, 'confirmed: unreadable');
    if (act === 'accept') {
      if (item.shadow?.would === 'split' && item.split) {
        return save({ at, by, outcome: 'several', accepted: true, parts: item.split.pages.map((pages) => ({ pages })) }, 'confirmed: the split is right');
      }
      const p = item.match?.patient;
      if (!item.shadow || !p?.chartPatientId) return back(res, item.id, 'truth_no_prediction');
      return save(
        { at, by, outcome: 'patient', accepted: true, patient: { key: p.chartPatientId, name: p.name, dateOfBirth: p.dateOfBirth, mrn: p.mrn }, ...(item.shadow.category ? { category: item.shadow.category } : {}) },
        'confirmed: prediction accepted'
      );
    }
    const dir = patientDirectory(deps.runTool());
    if (act === 'patient') {
      // The pick is checked against the same search again (hidden q), so the saved patient is a real one.
      let p: RosterPatient[];
      try {
        p = (await dir.find(String(b.q || '').slice(0, 80))).filter((x) => normKey(x.key) === normKey(b.patient_key));
      } catch {
        return back(res, item.id, 'roster_unavailable');
      }
      if (p.length !== 1) return back(res, item.id, 'truth_patient_unknown');
      const c = await category(b.category);
      if (c === false) return back(res, item.id, 'truth_category_unknown');
      return save({ at, by, outcome: 'patient', patient: snapshot(p[0]), ...(c ? { category: c } : {}) }, 'confirmed: patient picked by staff');
    }
    if (act === 'several') {
      const parts: NonNullable<GroundTruth['parts']> = [];
      const used = new Set<number>();
      const max = item.page_count || item.ocr?.pages || undefined;
      for (let k = 0; k < SEVERAL_ROWS; k++) {
        const rawPages = String(b[`pages_${k}`] || '').trim();
        const rawWho = String(b[`patient_${k}`] || '').trim();
        if (!rawPages && !rawWho) continue;
        const pages = parsePageList(rawPages, max);
        if (!pages || !rawWho || pages.some((p) => used.has(p))) return back(res, item.id, 'truth_pages_bad');
        pages.forEach((p) => used.add(p));
        const c = await category(b[`category_${k}`]);
        if (c === false) return back(res, item.id, 'truth_category_unknown');
        if (/^(none|no|not iki|n\/a)$/i.test(rawWho)) {
          parts.push({ pages, not_iki: true });
          continue;
        }
        let p: RosterPatient | null;
        try {
          p = await dir.resolve(rawWho);
        } catch {
          return back(res, item.id, 'roster_unavailable');
        }
        if (!p) return back(res, item.id, 'truth_patient_unknown');
        parts.push({ pages, patient: snapshot(p), ...(c ? { category: c } : {}) });
      }
      if (!parts.length) return back(res, item.id, 'truth_pages_bad');
      parts.sort((x, y) => x.pages[0] - y.pages[0]);
      return save({ at, by, outcome: 'several', parts }, `confirmed: several patients (${parts.length})`);
    }
    back(res, item.id, 'truth_pages_bad');
  });
}
