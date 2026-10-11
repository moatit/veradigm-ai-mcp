import type { UnityService } from '../../../unity/services/unity.service';
import { UnityActions } from '../../../unity/config/unity-endpoints';
import { UnityErrorHandler, UnityMCPError } from '../../../unity/utils/error-handler';
import { pick, unityRows } from '../../../unity/utils/unity-rows';
import type { DocumentKind, DocumentSubtype } from './extract';

/**
 * Veradigm® EHR document types (GetDocumentType) and the kind → type mapping.
 *
 * Sandbox Oct 9: 128 rows with DisplayName, EntryCode, ID, DocumentFormat, Archived, including
 * "(ready for indexing)" (EntryCode -1000999), "Labs/Procedures", "Consultant Letter".
 * Loaded once and cached for an hour. A failed load throws (never an empty list).
 */
export interface DocType {
  id: string;
  name: string;
  entryCode: string;
  format: string;
  archived: boolean;
}

export interface DocTypeSuggestion {
  id: string;
  name: string;
  /**
   * configured: the clinic's INTAKE_CATEGORY_MAP; keyword: matched the document kind or subtype;
   * staff: picked on the item screen; fallback: "(ready for indexing)".
   */
  reason: 'configured' | 'keyword' | 'staff' | 'fallback';
}

export const READY_FOR_INDEXING_CODE = '-1000999';
const CACHE_MS = 60 * 60_000;

/** DisplayName keywords per kind, best first. Exact (case-insensitive) names win over "contains". */
export const KIND_TYPE_KEYWORDS: Record<DocumentKind, string[]> = {
  lab_result: ['Labs/Procedures', 'Lab Results', 'Laboratory', 'Lab'],
  imaging: ['Radiology Report', 'Radiology', 'Imaging', 'Diagnostic Imaging', 'X-Ray'],
  consult: ['Consultant Letter', 'Consult Note', 'Consultation', 'Consult'],
  referral: ['Referral', 'Referral Letter'],
  other: [],
};

/** Category names per subtype, best first (sandbox SCAN_DOCUMENTTYPE names, Oct 11). */
export const SUBTYPE_TYPE_KEYWORDS: Record<DocumentSubtype, string[]> = {
  ct: ['CT Scan', 'Radiology Report', 'Diagnostic Imaging Report'],
  mri: ['MRI', 'Radiology Report', 'Diagnostic Imaging Report'],
  chest_xray: ['CXR', 'Radiology Report', 'Diagnostic Imaging Report'],
  xray: ['Radiology Report', 'Diagnostic Imaging Report'],
  mammogram: ['Mammography Results', 'Radiology Report'],
  ultrasound: ['Radiology Report', 'Diagnostic Imaging Report'],
  nuclear: ['Radiology Report', 'Diagnostic Imaging Report'],
  pathology: ['Pathology Report'],
  ekg: ['EKG'],
  stress_test: ['Stress Test'],
  colonoscopy: ['Colonoscopy Report'],
  discharge_summary: ['Hospital Discharge Summary', 'Discharge Summary Report', 'Discharge Summary'],
  history_physical: ['History and Physical Report', 'History and Physical'],
  op_note: ['Procedure/Op Note', 'Operative Note'],
  progress_note: ['Progress Note'],
  referral_letter: ['Referral Letter', 'Referral'],
  insurance_card: ['Insurance Card'],
};

/**
 * Clinic overrides, INTAKE_CATEGORY_MAP: JSON object from "kind" or "kind.subtype" (or "subtype")
 * to the clinic's own category name, e.g. {"lab_result":"Lab Results","imaging.ultrasound":"Diagnostic Imaging Report"}.
 * Most specific key wins. Bad JSON is ignored (logged once).
 */
let mapWarned = false;
export function categoryOverrides(raw = process.env.INTAKE_CATEGORY_MAP || ''): Record<string, string> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'string' && n.trim()).map(([k, n]) => [k.toLowerCase(), String(n).trim()]));
    }
  } catch {
    /* fall through */
  }
  if (!mapWarned) console.error('[Intake] INTAKE_CATEGORY_MAP is not a JSON object; ignored');
  mapWarned = true;
  return {};
}

const truthy = (v: string) => /^(1|y|yes|true)$/i.test(v.trim());

export function parseDocumentTypes(data: unknown): DocType[] {
  return unityRows(data)
    .map((r) => ({
      id: pick(r, 'ID', 'DocumentTypeID', 'DocTypeID'),
      name: pick(r, 'DisplayName', 'Name', 'Description'),
      entryCode: pick(r, 'EntryCode', 'Code'),
      format: pick(r, 'DocumentFormat', 'Format'),
      archived: truthy(pick(r, 'Archived', 'IsArchived', 'Inactive')),
    }))
    .filter((t) => t.id && t.name);
}

export function readyForIndexing(types: DocType[]): DocType | undefined {
  const live = types.filter((t) => !t.archived);
  return live.find((t) => t.entryCode === READY_FOR_INDEXING_CODE) || live.find((t) => /ready for indexing/i.test(t.name));
}

/**
 * Pick the document type: for the subtype (clinic map, then our categories), then for the kind (clinic map, then ours);
 * "(ready for indexing)" when nothing fits. Null when neither exists.
 */
export function mapKindToType(
  kind: DocumentKind,
  types: DocType[],
  subtype?: DocumentSubtype,
  overrides: Record<string, string> = categoryOverrides()
): DocTypeSuggestion | null {
  const live = types.filter((t) => !t.archived);
  const lower = (s: string) => s.toLowerCase();
  const configured = (key: string): DocTypeSuggestion | null => {
    const name = overrides[key.toLowerCase()];
    const t = name ? live.find((x) => lower(x.name) === lower(name)) : undefined;
    return t ? { id: t.id, name: t.name, reason: 'configured' } : null;
  };
  // Most specific first: clinic map for the subtype, our subtype categories, then the kind.
  if (subtype) {
    const hit = configured(`${kind}.${subtype}`) || configured(subtype);
    if (hit) return hit;
    for (const kw of SUBTYPE_TYPE_KEYWORDS[subtype] || []) {
      const exact = live.find((t) => lower(t.name) === lower(kw));
      if (exact) return { id: exact.id, name: exact.name, reason: 'keyword' };
    }
  }
  const forKind = configured(kind);
  if (forKind) return forKind;
  for (const kw of KIND_TYPE_KEYWORDS[kind] || []) {
    const exact = live.find((t) => lower(t.name) === lower(kw));
    if (exact) return { id: exact.id, name: exact.name, reason: 'keyword' };
  }
  for (const kw of KIND_TYPE_KEYWORDS[kind] || []) {
    const contains = live.find((t) => lower(t.name).includes(lower(kw)) && !/ready for indexing/i.test(t.name));
    if (contains) return { id: contains.id, name: contains.name, reason: 'keyword' };
  }
  const fallback = readyForIndexing(types);
  return fallback ? { id: fallback.id, name: fallback.name, reason: 'fallback' } : null;
}

type UnityLike = Pick<UnityService, 'executeAction'>;

/** GetDocumentType (Veradigm® EHR) with a one-hour cache. */
export class DocTypeCache {
  private types: DocType[] | null = null;
  private loadedAt = 0;
  private inflight: Promise<DocType[]> | null = null;

  constructor(
    private unity: UnityLike,
    private now: () => number = Date.now
  ) {}

  async list(): Promise<DocType[]> {
    if (this.types && this.now() - this.loadedAt < CACHE_MS) return this.types;
    if (!this.inflight) {
      this.inflight = this.load().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  async suggest(kind: DocumentKind, subtype?: DocumentSubtype): Promise<DocTypeSuggestion | null> {
    return mapKindToType(kind, await this.list(), subtype);
  }

  private async load(): Promise<DocType[]> {
    const action = UnityActions.Document.GET_DOCUMENT_TYPES;
    try {
      // Parameters blank: lists every document type the EHR user can see.
      const res = await this.unity.executeAction<any>(action, {}, '', 'EHR');
      if (!res || !res.success) throw UnityErrorHandler.createAPIError(res?.error || 'GetDocumentType failed', action);
      const types = parseDocumentTypes(res.data);
      if (!types.length) throw UnityErrorHandler.createAPIError('GetDocumentType returned no document types', action);
      this.types = types;
      this.loadedAt = this.now();
      return types;
    } catch (e) {
      if (e instanceof UnityMCPError) throw e;
      throw UnityErrorHandler.handleUnknownError(e, action);
    }
  }
}
