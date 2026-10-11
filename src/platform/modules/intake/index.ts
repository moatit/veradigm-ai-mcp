import express, { Request, Response, Router } from 'express';
import { PlatformModule } from '../../registry';
import { APP_BASE, esc, fmtTime, page } from '../../shell';
import { CsvDocTypes, DocTypeCache, FallbackDocTypes, type DocType, type DocTypeSource } from './doctypes';
import type { Confidence, DocumentKind, Extracted } from './extract';
import { fileToChart, filingStatus, IntakeFilingError, sendToIndexing, setFilingDeps, type FilingResult } from './file';
import { startFolderWatcher, startWatchFolders } from './folder';
import { MoatitFaxClient, setFaxRecordedHandler } from './moatit-fax';
import { observeEnabled, StaffFilingObserver } from './observe';
import { OcrClient } from './ocr';
import { IntakePipeline } from './pipeline';
import { rosterPath } from './roster';
import { readOnlyRunTool, readOnlyUnity, shadowMode } from './shadow';
import {
  byIdOf,
  confirmFilter,
  filterByConfirmation,
  mountConfirmRoutes,
  SHADOW_MESSAGES,
  shadowCell,
  shadowPanel,
  shadowQueueHeader,
  type ConfirmFilter,
  type ShadowPanelContext,
} from './shadow-ui';
import { ALLOWED_MIME, INTAKE_STATUSES, IntakeItem, IntakeStatus, intakeStore, sniffMime } from './store';

export { mountFaxWebhook } from './moatit-fax';

/**
 * Drawbridge module: fax and document intake (staff-side; the phone agent never files documents).
 *  - POST /webhooks/moatit-fax (signed MOATiT Fax deliveries) via mountFaxWebhook(app), before express.json()
 *  - Drop-folder watcher (INTAKE_DROP_DIR) and staff uploads
 *  - Staff screens: /app/intake (queue), /app/intake/item/:id (fields, match, document type, actions)
 * Design and safety rules: docs/drawbridge/FAX_INTAKE_ADDON.md. Filing to the chart (file.ts) is off
 * unless INTAKE_FILING and INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED allow it.
 * Shadow mode (INTAKE_MODE=shadow, shadow.ts): no filing and read-only Veradigm® (patient search and
 * categories only; optional local roster and category list), a Confirm panel for ground truth (shadow-ui.ts).
 */
const LIST_MAX = 300;
/**
 * Upload body: JSON { name, mime, data_base64, text? } sent with its own media type, because the
 * server-wide express.json() (100 KB limit) would otherwise parse and reject it first.
 */
export const UPLOAD_TYPE = 'application/vnd.drawbridge.intake-upload+json';

export const intakePipeline = new IntakePipeline({ store: intakeStore, fax: () => MoatitFaxClient.fromEnv() });

export const STATUS_LABEL: Record<IntakeStatus, string> = {
  received: 'Received',
  read: 'Read',
  matched: 'Matched',
  needs_review: 'Needs review',
  filed: 'Filed',
  sent_to_indexing: 'Sent to indexing',
  split: 'Split by patient',
  failed: 'Failed',
};
const STATUS_PILL: Record<IntakeStatus, string> = {
  received: '',
  read: '',
  matched: 'ok',
  needs_review: 'warn',
  filed: 'ok',
  sent_to_indexing: 'ok',
  split: 'ok',
  failed: 'urgent',
};
/** "pages 1-3" / "page 4" / "pages 1, 3". */
const pageList = (ps: number[]) =>
  ps.length === 1
    ? `page ${ps[0]}`
    : ps[ps.length - 1] - ps[0] === ps.length - 1
      ? `pages ${ps[0]}-${ps[ps.length - 1]}`
      : `pages ${ps.join(', ')}`;
export const KIND_LABEL: Record<DocumentKind, string> = {
  lab_result: 'Lab result',
  imaging: 'Imaging report',
  consult: 'Consult letter',
  referral: 'Referral',
  other: 'Other',
};
const SOURCE_LABEL = { moatit_fax: 'MOATiT Fax', folder: 'Drop folder', upload: 'Staff upload' } as const;
const DECISION_LABEL = { auto: 'Two identifiers match', review: 'Check the patient', none: 'No match', ambiguous: 'More than one patient', error: 'Search failed' } as const;
const DECISION_PILL = { auto: 'ok', review: 'warn', none: 'warn', ambiguous: 'urgent', error: 'urgent' } as const;
const MESSAGES: Record<string, string> = {
  reviewed: 'Marked as reviewed.',
  retry: 'Queued to read again.',
  FILING_DISABLED: 'Filing is turned off.',
  NOT_READY: 'This document is not ready to file yet.',
  ALREADY_FILED: 'This document was already filed.',
  FILING_REJECTED: 'Veradigm® EHR did not accept the document. It was not filed.',
  FILING_UNCERTAIN: 'Veradigm® EHR did not answer. Check the patient chart before trying again.',
  filed: 'Filed to the patient chart in Veradigm® EHR.',
  category: 'Category changed.',
  category_unknown: 'That category is not available in Veradigm® EHR.',
  filed_task_failed: 'Filed to the patient chart, but the review task could not be sent. Tell the provider.',
  ...SHADOW_MESSAGES,
};

const pill = (cls: string, text: string) => `<span class="pill ${cls}">${esc(text)}</span>`;
const confPill = (c: Confidence) => pill(c === 'high' ? 'ok' : c === 'medium' ? 'warn' : '', c);
const field = <T,>(f: Extracted<T> | undefined, show: (v: T) => string = (v) => String(v)) =>
  f ? `${esc(show(f.value))} ${confPill(f.confidence)}` : '<span class="muted">not found</span>';
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function patientCell(i: IntakeItem): string {
  if (i.status === 'split' && i.split) return `<span class="muted">${esc(i.split.children.length)} patients, one document each</span>`;
  if (i.match?.patient) return `${esc(i.match.patient.name)}<div class="muted" style="font-size:12px">DOB ${esc(i.match.patient.dateOfBirth)}</div>`;
  if (i.extracted?.patient_name) return `<span class="muted">${esc(i.extracted.patient_name.value.full)} (from document)</span>`;
  return '<span class="muted">—</span>';
}

export function queuePage(
  items: IntakeItem[],
  counts: Record<IntakeStatus, number>,
  status: IntakeStatus | '',
  shadow?: { all: IntakeItem[]; filter: ConfirmFilter | '' }
): string {
  const filing = filingStatus();
  const byId = shadow ? byIdOf(shadow.all) : null;
  const tabs = `<form class="card row" method="get" action="${APP_BASE}/intake" style="align-items:flex-end">
<label style="min-width:200px">Status<select name="status"><option value="">All (${esc(Object.values(counts).reduce((a, b) => a + b, 0))})</option>${INTAKE_STATUSES.map(
    (s) => `<option value="${s}"${s === status ? ' selected' : ''}>${esc(STATUS_LABEL[s])} (${esc(counts[s] || 0)})</option>`
  ).join('')}</select></label><button>Show</button>${status ? `<a href="${APP_BASE}/intake">Clear</a>` : ''}</form>`;

  const summary = `<div class="grid">
<div class="card"><div class="muted">Needs review</div><div class="stat"${counts.needs_review ? ' style="color:var(--warn)"' : ''}>${esc(counts.needs_review)}</div></div>
<div class="card"><div class="muted">Matched</div><div class="stat">${esc(counts.matched)}</div></div>
<div class="card"><div class="muted">Failed</div><div class="stat"${counts.failed ? ' style="color:var(--urgent)"' : ''}>${esc(counts.failed)}</div></div></div>`;

  const list = items.length
    ? `<div class="card scroll"><table><thead><tr><th>Received</th><th>Source</th><th>Document</th><th>Patient</th><th>Status</th>${byId ? '<th>Shadow</th>' : ''}</tr></thead><tbody>${items
        .slice(0, LIST_MAX)
        .map((i) => {
          const kind = i.extracted ? KIND_LABEL[i.extracted.kind.value] : '';
          const flags = i.extracted?.abnormal.critical ? pill('urgent', 'critical') : i.extracted?.abnormal.flagged ? pill('warn', 'abnormal') : '';
          return `<tr><td><a href="${APP_BASE}/intake/item/${encodeURIComponent(i.id)}">${esc(fmtTime(i.received_at))}</a></td><td>${esc(SOURCE_LABEL[i.source])}</td>
<td>${esc(kind) || '<span class="muted">—</span>'} ${flags}${i.extracted?.sender ? `<div class="muted" style="font-size:12px">${esc(i.extracted.sender.value)}</div>` : ''}${
            i.part ? `<div class="muted" style="font-size:12px">Part ${esc(i.part.index + 1)} of ${esc(i.part.of)} (${esc(pageList(i.part.pages))})</div>` : ''
          }</td>
<td>${patientCell(i)}</td><td>${pill(STATUS_PILL[i.status], STATUS_LABEL[i.status])}</td>${byId ? `<td>${shadowCell(i, byId)}</td>` : ''}</tr>`;
        })
        .join('')}</tbody></table>${items.length > LIST_MAX ? `<p class="muted" style="font-size:13px">Showing the latest ${LIST_MAX} of ${esc(items.length)}.</p>` : ''}</div>`
    : '<div class="card empty muted">No documents here.</div>';

  const upload = `<details class="card"><summary><strong>Upload a document</strong> <span class="muted" style="font-size:13px">PDF, TIFF, PNG or JPEG</span></summary>
<form id="intake-upload" style="margin-top:10px"><p><label>File<input type="file" name="file" accept=".pdf,.tif,.tiff,.png,.jpg,.jpeg" required></label></p>
<p><label>Document text (optional, helps matching when the file has no text layer)<textarea name="text" rows="4"></textarea></label></p>
<button>Upload</button> <span id="intake-upload-msg" class="muted" style="font-size:13px"></span></form></details>
<script>
document.getElementById('intake-upload').addEventListener('submit', function (ev) {
  ev.preventDefault();
  var f = ev.target.file.files[0], msg = document.getElementById('intake-upload-msg');
  if (!f) return;
  msg.textContent = 'Uploading…';
  var r = new FileReader();
  r.onload = function () {
    var b64 = String(r.result).split(',')[1] || '';
    fetch('${APP_BASE}/intake/upload', { method: 'POST', headers: { 'Content-Type': '${UPLOAD_TYPE}' }, credentials: 'same-origin',
      body: JSON.stringify({ name: f.name, mime: f.type, data_base64: b64, text: ev.target.text.value }) })
      .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
      .then(function (o) { if (o.ok && o.j.id) location.href = '${APP_BASE}/intake/item/' + encodeURIComponent(o.j.id); else msg.textContent = o.j.error || 'Upload failed.'; })
      .catch(function () { msg.textContent = 'Upload failed.'; });
  };
  r.readAsDataURL(f);
});
</script>`;

  return `<div class="row" style="margin:4px 0 8px"><h2 style="margin:0">Document intake</h2><span style="flex:1"></span>${
    filing.enabled ? pill('ok', `Filing: ${filing.mode}`) : pill('', 'Filing off')
  }</div>
${shadow ? shadowQueueHeader(shadow.all, shadow.filter, status) : ''}${summary}${tabs}${list}${upload}
<p class="muted" style="font-size:13px">Faxes from MOATiT Fax, files from the drop folder and uploads are read, matched to a patient by name and date of birth plus a second identifier, and queued here. ${esc(
    filing.enabled ? '' : filing.reason
  )}</p>`;
}

function actionButton(id: string, path: string, label: string, enabled: boolean, why: string, secondary = false): string {
  return `<form method="post" action="${APP_BASE}/intake/item/${encodeURIComponent(id)}/${path}" style="margin:0">
<button${secondary ? ' class="secondary"' : ''}${enabled ? '' : ' disabled title="' + esc(why) + '" style="opacity:.5;cursor:not-allowed"'}>${esc(label)}</button></form>`;
}

const TYPE_REASON: Record<string, string> = {
  fallback: 'no specific category fits; staff index it',
  keyword: 'from what the document is',
  configured: "from the clinic's category settings",
  staff: 'picked by staff',
};

/** A split file's parts, or a part's parent (store look-ups done by the route). */
export interface ItemFamily {
  parent?: IntakeItem;
  children?: IntakeItem[];
}

function familyCard(i: IntakeItem, fam: ItemFamily): string {
  const link = (c: IntakeItem, label: string) => `<a href="${APP_BASE}/intake/item/${encodeURIComponent(c.id)}">${esc(label)}</a>`;
  if (i.split) {
    const kids = (fam.children || []).filter((c) => c.parent_id === i.id);
    const rows = i.split.children
      .map((id, k) => {
        const c = kids.find((x) => x.id === id);
        const pages = i.split!.pages[k] || [];
        if (!c) return `<tr><td>Part ${k + 1}</td><td>${esc(pageList(pages))}</td><td colspan="2" class="muted">not found</td></tr>`;
        return `<tr><td>${link(c, `Part ${k + 1}`)}</td><td>${esc(pageList(pages))}</td><td>${patientCell(c)}</td><td>${pill(STATUS_PILL[c.status], STATUS_LABEL[c.status])}</td></tr>`;
      })
      .join('');
    return `<h2>Split by patient</h2><div class="card scroll"><p style="margin-top:0">This file showed ${esc(i.split.children.length)} patients. Each part holds only that patient's pages and is matched and filed on its own.${
      i.split.cover_pages.length ? ` The cover sheet (${esc(pageList(i.split.cover_pages))}) stays with this original.` : ''
    }</p><table><thead><tr><th>Part</th><th>Pages of this file</th><th>Patient</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  if (i.parent_id && i.part) {
    const p = fam.parent;
    return `<h2>Split from</h2><div class="card">Part ${esc(i.part.index + 1)} of ${esc(i.part.of)}: ${esc(pageList(i.part.pages))} of ${
      p ? link(p, p.file?.name || 'the original') : esc('the original')
    }. The other pages name other patients and are in the other parts.</div>`;
  }
  return '';
}

export function itemPage(
  i: IntakeItem,
  message = '',
  typeOptions: { id: string; name: string }[] = [],
  family: ItemFamily = {},
  shadowCtx?: ShadowPanelContext
): string {
  const filing = filingStatus();
  const x = i.extracted;
  const m = i.match;
  const split = i.status === 'split';
  const done = i.status === 'filed' || i.status === 'sent_to_indexing' || split;
  const canFile = filing.enabled && !done && !!m?.patient?.chartPatientId && (m.decision === 'auto' || !!i.reviewed_by);
  const canIndex = filing.enabled && !done && !!m?.patient?.chartPatientId;
  const doneWhy = split ? 'Split by patient: file each part.' : 'Already filed.';
  const fileWhy = !filing.enabled ? filing.reason : done ? doneWhy : 'Needs a patient matched by two identifiers, or marked reviewed.';
  const indexWhy = !filing.enabled ? filing.reason : done ? doneWhy : 'Needs a matched patient.';

  const flash = message ? `<div class="card" style="border-color:var(--accent)">${esc(MESSAGES[message] || '')}</div>` : '';

  const doc = `<div class="card"><dl>
<dt>Status</dt><dd>${pill(STATUS_PILL[i.status], STATUS_LABEL[i.status])}${i.error_code ? ` <span class="muted" style="font-size:12px">${esc(i.error_code)}</span>` : ''}</dd>
<dt>Received</dt><dd>${esc(fmtTime(i.received_at))} · ${esc(SOURCE_LABEL[i.source])}${i.sender_fax ? ` · from fax ${esc(i.sender_fax)}` : ''}</dd>
<dt>File</dt><dd>${i.file ? `<a href="${APP_BASE}/intake/item/${encodeURIComponent(i.id)}/original" target="_blank" rel="noopener">${esc(i.file.name)}</a> <span class="muted" style="font-size:12px">${esc(kb(i.file.size))}</span>` : '<span class="muted">not downloaded yet</span>'}</dd>
${i.ocr ? `<dt>Text</dt><dd>${i.ocr.used_text_layer ? 'From the PDF text layer' : `Read by Drawbridge OCR · ${esc(i.ocr.pages)} page(s) · confidence ${esc(Math.round(i.ocr.mean_confidence))}`}</dd>` : ''}
${i.duplicate_of ? `<dt>Duplicate</dt><dd>Same file as <a href="${APP_BASE}/intake/item/${encodeURIComponent(i.duplicate_of)}">an earlier document</a></dd>` : ''}
${i.note ? `<dt>Note</dt><dd>${esc(i.note)}</dd>` : ''}
${i.filed ? `<dt>In the chart</dt><dd>Document ${esc(i.filed.document_id)} · ${esc(i.filed.document_type)} · ${esc(i.filed.doc_status === '4' ? 'approved' : i.filed.doc_status === '1' ? 'ready for indexing' : 'waiting for approval in Veradigm® EHR')}${i.filed.task_id ? ` · review task ${esc(i.filed.task_id)}` : ''} · ${esc(fmtTime(i.filed.at))} by ${esc(i.filed.by)}</dd>` : ''}
${i.reviewed_by ? `<dt>Reviewed</dt><dd>${esc(i.reviewed_by)} · ${esc(fmtTime(i.reviewed_at || ''))}</dd>` : ''}
</dl></div>`;

  const fields = x
    ? `<div class="card"><dl>
<dt>Document</dt><dd>${esc(KIND_LABEL[x.kind.value])} ${confPill(x.kind.confidence)}</dd>
<dt>Patient name</dt><dd>${field(x.patient_name, (v) => v.full)}</dd>
<dt>Date of birth</dt><dd>${field(x.dob)}</dd>
<dt>MRN</dt><dd>${field(x.mrn)}</dd>
<dt>Patient phone</dt><dd>${field(x.phone, (v) => v.replace(/^(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3'))}</dd>
<dt>Sender</dt><dd>${field(x.sender)}</dd>
<dt>Collected / service date</dt><dd>${field(x.collection_date)}</dd>
<dt>Abnormal flags</dt><dd>${
        x.abnormal.flagged
          ? `${x.abnormal.critical ? pill('urgent', 'critical') : pill('warn', 'abnormal')} <span class="muted" style="font-size:13px">${esc(x.abnormal.markers.join(', '))}${x.abnormal.flagged_lines ? ` · ${esc(x.abnormal.flagged_lines)} flagged result line(s)` : ''}</span>`
          : '<span class="muted">none found</span>'
      }</dd></dl>
<p class="muted" style="font-size:13px;margin-bottom:0">Read automatically from the document text. Check against the original before filing.</p></div>`
    : '<div class="card muted">Not read yet.</div>';

  const match = m
    ? `<div class="card"><dl>
<dt>Result</dt><dd>${pill(DECISION_PILL[m.decision], DECISION_LABEL[m.decision])} ${esc(m.reason)}</dd>
${m.patient ? `<dt>Patient</dt><dd>${esc(m.patient.name)} · DOB ${esc(m.patient.dateOfBirth)}${m.patient.mrn ? ` · MRN ${esc(m.patient.mrn)}` : ''}</dd>
<dt>Veradigm® EHR chart</dt><dd>${m.patient.chartPatientId ? esc(m.patient.chartPatientId) : '<span class="muted">none</span>'}</dd>` : ''}
${m.second_identifier ? `<dt>Second identifier</dt><dd>${esc(m.second_identifier === 'mrn' ? 'MRN' : 'Phone')}</dd>` : ''}
<dt>Checked</dt><dd>${esc(fmtTime(m.checked_at))}</dd></dl></div>`
    : '<div class="card muted">Not matched yet.</div>';

  const type = `<div class="card">${
    i.document_type
      ? `<strong>${esc(i.document_type.name)}</strong> <span class="muted" style="font-size:13px">${esc(TYPE_REASON[i.document_type.reason] || '')}</span>`
      : '<span class="muted">No suggestion yet.</span>'
  }${
    typeOptions.length && !done && !shadowCtx
      ? `<form method="post" action="${APP_BASE}/intake/item/${encodeURIComponent(i.id)}/category" class="row" style="margin-top:10px">
<select name="type_id" aria-label="Chart category">${typeOptions
          .map((t) => `<option value="${esc(t.id)}"${t.id === i.document_type?.id ? ' selected' : ''}>${esc(t.name)}</option>`)
          .join('')}</select> <button class="secondary">Change category</button></form>`
      : ''
  }</div>`;

  const actions = `<div class="card"><div class="row">
${actionButton(i.id, 'file-to-chart', 'File to chart', canFile, fileWhy)}
${actionButton(i.id, 'send-to-indexing', 'Send to indexing', canIndex, indexWhy, true)}
${actionButton(i.id, 'reviewed', i.reviewed_by ? 'Reviewed ✓' : 'Mark reviewed', !i.reviewed_by && !done, i.reviewed_by ? 'Already reviewed.' : doneWhy, true)}
${i.status === 'failed' ? actionButton(i.id, 'retry', 'Try again', true, '', true) : ''}
</div>${filing.enabled ? '' : `<p class="muted" style="font-size:13px;margin-bottom:0">${esc(filing.reason)}</p>`}
<p class="muted" style="font-size:13px;margin-bottom:0">Mark reviewed records that you checked the original and the patient. Nothing is written to the Veradigm® EHR chart from this screen until filing is turned on.</p></div>`;

  const history = `<div class="card scroll"><table><thead><tr><th>When</th><th>What</th><th>Who</th></tr></thead><tbody>${[...i.history]
    .reverse()
    .map((h) => `<tr><td>${esc(fmtTime(h.ts))}</td><td>${esc(h.action)}</td><td>${esc(h.by)}</td></tr>`)
    .join('')}</tbody></table></div>`;

  return `<p><a href="${APP_BASE}/intake">← Document intake</a></p>${flash}
<h2 style="margin-top:4px">Document</h2>${doc}${familyCard(i, family)}<h2>Read from the document</h2>${fields}<h2>Patient match</h2>${match}
<h2>Chart category</h2>${type}${shadowCtx ? shadowPanel(i, shadowCtx) : ''}<h2>Actions</h2>${actions}<h2>History</h2>${history}`;
}

let stopWatcher: (() => void) | null = null;
let stopWatchDirs: (() => void) | null = null;
let stopObserver: (() => void) | null = null;
let docTypeCache: DocTypeSource | null = null;
/** Shadow mode: the read-only patient search for the Confirm panel. */
let shadowRunTool: ((name: string, args: any) => Promise<any>) | null = null;

export const intakeModule: PlatformModule = {
  name: 'intake',
  nav: { path: '/intake', label: 'Document intake', order: 35 },

  appRouter() {
    const router = Router();
    const user = (req: any) => String(req.drawbridgeUser || 'staff');
    const show = (req: Request, res: Response, title: string, body: string, code = 200) =>
      res.status(code).send(page(`${title} · Drawbridge`, body, { user: user(req), active: '/intake' }));
    const back = (res: Response, id: string, m: string) => res.redirect(`${APP_BASE}/intake/item/${encodeURIComponent(id)}?m=${encodeURIComponent(m)}`);

    router.get('/', (req, res) => {
      try {
        const status = INTAKE_STATUSES.includes(req.query.status as IntakeStatus) ? (req.query.status as IntakeStatus) : '';
        const store = intakeStore();
        if (shadowMode()) {
          const all = store.list();
          const filter = confirmFilter(req.query.confirm);
          const items = filterByConfirmation(status ? all.filter((i) => i.status === status) : all, filter, byIdOf(all));
          show(req, res, 'Document intake', queuePage(items, store.counts(), status, { all, filter }));
          return;
        }
        show(req, res, 'Document intake', queuePage(store.list(status || undefined), store.counts(), status));
      } catch {
        show(req, res, 'Document intake', '<div class="card">Document intake is unavailable right now.</div>', 500);
      }
    });

    const renderItem = (req: Request, res: Response, item: IntakeItem, m: string, search?: ShadowPanelContext['search']) => {
      const options = async () => {
        try {
          return docTypeCache ? (await docTypeCache.list()).filter((t) => !t.archived).sort((a, b) => a.name.localeCompare(b.name)) : [];
        } catch {
          return []; // the page still works; only the picker is missing
        }
      };
      const store = intakeStore();
      const family: ItemFamily = {
        parent: item.parent_id ? store.get(item.parent_id) : undefined,
        children: item.split ? item.split.children.map((c) => store.get(c)).filter((c): c is IntakeItem => !!c) : undefined,
      };
      options().then((types) => {
        const ctx: ShadowPanelContext | undefined = shadowMode() ? { byId: (id) => store.get(id), categories: types.map((t) => t.name), search } : undefined;
        show(req, res, 'Document', itemPage(item, m, types, family, ctx));
      });
    };

    router.get('/item/:id', (req, res) => {
      const item = intakeStore().get(req.params.id);
      if (!item) {
        show(req, res, 'Document intake', '<div class="card">Document not found.</div>', 404);
        return;
      }
      renderItem(req, res, item, typeof req.query.m === 'string' && MESSAGES[req.query.m] ? req.query.m : '');
    });

    mountConfirmRoutes(router, { store: intakeStore, categories: () => docTypeCache, runTool: () => shadowRunTool, render: (req, res, item, search) => renderItem(req, res, item, '', search) });

    router.post('/item/:id/category', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
      const store = intakeStore();
      const item = store.get(req.params.id);
      if (!item) {
        res.status(404).send('Not found');
        return;
      }
      if (item.status === 'filed' || item.status === 'sent_to_indexing' || item.status === 'split') {
        back(res, item.id, item.status === 'split' ? 'NOT_READY' : 'ALREADY_FILED');
        return;
      }
      if (shadowMode()) {
        back(res, item.id, 'category_shadow'); // the suggestion is what is measured; staff answer in the Confirm panel
        return;
      }
      let types: DocType[] = [];
      try {
        types = docTypeCache ? await docTypeCache.list() : [];
      } catch {
        /* handled below */
      }
      const t = types.find((x) => x.id === String(req.body?.type_id || '') && !x.archived);
      if (!t) {
        back(res, item.id, 'category_unknown');
        return;
      }
      store.update(item.id, { document_type: { id: t.id, name: t.name, reason: 'staff' } }, `category set to ${t.name}`, user(req));
      back(res, item.id, 'category');
    });

    router.get('/item/:id/original', (req, res) => {
      const store = intakeStore();
      const item = store.get(req.params.id);
      const p = item ? store.filePath(item) : '';
      if (!item || !p || !item.file) {
        res.status(404).send('Not found');
        return;
      }
      res.setHeader('Content-Type', ALLOWED_MIME.has(item.file.mime) ? item.file.mime : 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${item.file.name.replace(/["\\]/g, '_')}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(p);
    });

    const filingAction = (fn: (i: IntakeItem, by: string) => Promise<FilingResult>) => async (req: Request, res: Response) => {
      const item = intakeStore().get(req.params.id);
      if (!item) {
        res.status(404).send('Not found');
        return;
      }
      let r: FilingResult;
      try {
        r = await fn(item, user(req));
      } catch (e) {
        const code = e instanceof IntakeFilingError ? e.error_code : 'FILING_UNCERTAIN';
        if (!(e instanceof IntakeFilingError) || ['FILING_DISABLED', 'NOT_READY', 'ALREADY_FILED'].includes(code)) {
          intakeStore().update(item.id, {}, `filing refused (${code})`, user(req));
        }
        back(res, item.id, code);
        return;
      }
      back(res, item.id, r.task_error ? 'filed_task_failed' : 'filed');
    };
    router.post('/item/:id/file-to-chart', filingAction(fileToChart));
    router.post('/item/:id/send-to-indexing', filingAction(sendToIndexing));

    router.post('/item/:id/reviewed', (req, res) => {
      const store = intakeStore();
      const item = store.get(req.params.id);
      if (!item) {
        res.status(404).send('Not found');
        return;
      }
      if (!item.reviewed_by) store.update(item.id, { reviewed_by: user(req), reviewed_at: new Date().toISOString() }, 'marked reviewed', user(req));
      back(res, item.id, 'reviewed');
    });

    router.post('/item/:id/retry', (req, res) => {
      const store = intakeStore();
      const item = store.get(req.params.id);
      if (!item) {
        res.status(404).send('Not found');
        return;
      }
      if (item.status === 'failed') {
        store.update(item.id, { status: 'received', error_code: undefined, ocr_waits: 0 }, 'retry requested', user(req));
        intakePipeline.enqueue(item.id);
      }
      back(res, item.id, 'retry');
    });

    const maxB64 = Math.ceil(((Number(process.env.INTAKE_MAX_FILE_MB) || 25) * 1024 * 1024 * 4) / 3) + 300_000;
    router.post('/upload', express.json({ type: UPLOAD_TYPE, limit: maxB64 }), (req, res) => {
      try {
        const b = req.body || {};
        const b64 = typeof b.data_base64 === 'string' ? b.data_base64 : '';
        const data = Buffer.from(b64, 'base64');
        const mime = sniffMime(data);
        if (!data.length || !mime) {
          res.status(400).json({ error: 'Upload a PDF, TIFF, PNG or JPEG file.' });
          return;
        }
        const text = typeof b.text === 'string' ? b.text.slice(0, 200_000) : '';
        const r = intakeStore().addDocument({ source: 'upload', source_ref: '', name: String(b.name || 'document'), mime, data, text, by: user(req) });
        if (!r.duplicate) intakePipeline.enqueue(r.item.id);
        res.json({ id: r.item.id, duplicate: r.duplicate });
      } catch (e: any) {
        console.error(`[Intake] upload failed: ${e?.code || e?.name || 'error'}`);
        res.status(500).json({ error: 'Upload failed.' });
      }
    });

    return router;
  },

  start(deps) {
    if (shadowMode()) {
      // Read-only Veradigm: the patient search and GetDocumentType only (INTAKE_CATEGORIES_CSV as the
      // fallback, INTAKE_ROSTER_CSV instead of the search when set). No filing deps: nothing can be filed.
      const csv = CsvDocTypes.fromEnv();
      docTypeCache = new FallbackDocTypes(new DocTypeCache(readOnlyUnity(deps.unity) as any), csv);
      shadowRunTool = readOnlyRunTool(deps.runTool);
      intakePipeline.setDeps({ runTool: shadowRunTool }, docTypeCache);
      setFilingDeps(null);
      // Ground truth from staff's own filing in Veradigm EHR, read back later (observe.ts).
      stopObserver?.();
      stopObserver = observeEnabled() ? new StaffFilingObserver({ store: intakeStore, unity: deps.unity, runTool: deps.runTool, ocr: () => OcrClient.fromEnv() }).start() : null;
      console.log(`[Intake] shadow mode: nothing is filed; patients from ${rosterPath() ? 'the local patient list' : 'the Veradigm search (read-only)'}; staff filing observer ${stopObserver ? 'on' : 'off'}`);
    } else {
      docTypeCache = new DocTypeCache(deps.unity);
      intakePipeline.setDeps(deps, docTypeCache);
      setFilingDeps({ unity: deps.unity, store: intakeStore });
    }
    setFaxRecordedHandler((id) => intakePipeline.enqueue(id));
    stopWatcher?.();
    stopWatcher = startFolderWatcher(intakeStore, (id) => intakePipeline.enqueue(id));
    stopWatchDirs?.();
    stopWatchDirs = startWatchFolders(intakeStore, (id) => intakePipeline.enqueue(id));
    const resumed = intakePipeline.resumePending();
    if (resumed) console.log(`[Intake] resumed ${resumed} unfinished document(s)`);
    const days = Number(process.env.INTAKE_RETENTION_DAYS);
    try {
      const removed = intakeStore().pruneFiled(Number.isFinite(days) && days >= 1 ? days : 30);
      if (removed) console.log(`[Intake] retention: removed ${removed} filed original(s)`);
    } catch (e: any) {
      console.error(`[Intake] retention failed: ${e?.code || 'error'}`);
    }
  },
};
