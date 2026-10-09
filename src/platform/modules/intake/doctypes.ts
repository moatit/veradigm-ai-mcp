import type { UnityService } from '../../../unity/services/unity.service';
import { UnityActions } from '../../../unity/config/unity-endpoints';
import { UnityErrorHandler, UnityMCPError } from '../../../unity/utils/error-handler';
import { pick, unityRows } from '../../../unity/utils/unity-rows';
import type { DocumentKind } from './extract';

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
  /** keyword: matched the document kind; fallback: "(ready for indexing)". */
  reason: 'keyword' | 'fallback';
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

/** Pick the document type for a kind; "(ready for indexing)" when nothing fits. Null when neither exists. */
export function mapKindToType(kind: DocumentKind, types: DocType[]): DocTypeSuggestion | null {
  const live = types.filter((t) => !t.archived);
  const lower = (s: string) => s.toLowerCase();
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

  async suggest(kind: DocumentKind): Promise<DocTypeSuggestion | null> {
    return mapKindToType(kind, await this.list());
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
