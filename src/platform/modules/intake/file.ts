import type { IntakeItem } from './store';

/**
 * Filing a document to the patient's Veradigm® EHR chart (SaveDocumentImage).
 *
 * NOT IMPLEMENTED ON THIS BRANCH. Owner-approved exception to CLAUDE.md rule 4, under the rules in
 * docs/drawbridge/FAX_INTAKE_ADDON.md. Two switches must both be on before anything is attempted:
 *
 *   INTAKE_FILING                            off (default) | review (staff click) | auto (high-confidence)
 *   INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED    true only after the SaveDocumentImage parameter layout is
 *                                            confirmed (Kanhaiya / Veradigm reference) and one test PDF was
 *                                            filed to a sandbox test patient with the owner's OK
 *
 * Even with both on, the call itself is a TODO below, so this throws FILING_NOT_IMPLEMENTED.
 * No Veradigm write happens anywhere in this module.
 */
export type FilingMode = 'off' | 'review' | 'auto';

export function filingMode(): FilingMode {
  const v = String(process.env.INTAKE_FILING || '').trim().toLowerCase();
  return v === 'review' || v === 'auto' ? v : 'off';
}

export function saveFormatConfirmed(): boolean {
  return String(process.env.INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED || '').trim().toLowerCase() === 'true';
}

export interface FilingStatus {
  enabled: boolean;
  mode: FilingMode;
  format_confirmed: boolean;
  /** Staff-readable reason when disabled. */
  reason: string;
}

export function filingStatus(): FilingStatus {
  const mode = filingMode();
  const confirmed = saveFormatConfirmed();
  if (mode === 'off') {
    return { enabled: false, mode, format_confirmed: confirmed, reason: 'Filing to the Veradigm® EHR chart is turned off. Documents are read, matched and queued for staff only.' };
  }
  if (!confirmed) {
    return { enabled: false, mode, format_confirmed: confirmed, reason: 'Filing is waiting for the Veradigm® EHR document upload to be verified on the test system.' };
  }
  return { enabled: true, mode, format_confirmed: confirmed, reason: '' };
}

/** Structured failure, same shape the platform uses for tools ({ success:false, error_code, retryable }). */
export class IntakeFilingError extends Error {
  readonly success = false as const;
  constructor(
    readonly error_code: 'FILING_DISABLED' | 'FILING_NOT_IMPLEMENTED' | 'NOT_READY' | 'ALREADY_FILED',
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'IntakeFilingError';
  }
  toJSON() {
    return { success: false, error_code: this.error_code, retryable: this.retryable, message: this.message };
  }
}

/** Throws FILING_DISABLED unless INTAKE_FILING is review/auto AND the save format is confirmed. */
export function assertFilingEnabled(): void {
  const s = filingStatus();
  if (!s.enabled) throw new IntakeFilingError('FILING_DISABLED', s.reason);
}

/** What must hold for one item before a filing call (two-identifier match, chart ID, file, type, not filed). */
export function filingPreconditions(item: IntakeItem, target: 'chart' | 'indexing'): string[] {
  const problems: string[] = [];
  if (item.status === 'filed' || item.status === 'sent_to_indexing') problems.push('already filed');
  if (!item.file) problems.push('no original file');
  if (!item.match?.patient?.chartPatientId) problems.push('no matched patient chart');
  if (target === 'chart') {
    if (item.match?.decision !== 'auto' && !item.reviewed_by) problems.push('match not confirmed by two identifiers or by staff');
    if (!item.document_type?.id) problems.push('no document type');
  }
  return problems;
}

/**
 * File the original document to the matched patient's Veradigm® EHR chart.
 * Always throws on this branch (see header).
 */
export async function fileToChart(item: IntakeItem): Promise<never> {
  assertFilingEnabled();
  const problems = filingPreconditions(item, 'chart');
  if (problems.includes('already filed')) throw new IntakeFilingError('ALREADY_FILED', 'This document was already filed.');
  if (problems.length) throw new IntakeFilingError('NOT_READY', `Not ready to file: ${problems.join(', ')}.`);

  // TODO(SaveDocumentImage): the parameter layout is UNCONFIRMED. Before writing this call:
  //  1. Confirm the format with Kanhaiya / the Veradigm EHR reference (patient = chartPatientId,
  //     document type ID, date, description "Outside lab – <sender> – <kind> – <date>", file bytes).
  //  2. With the owner's OK, file one test PDF to a sandbox test patient; read it back with
  //     GetDocuments (UnityActions.Document.GET_DOCUMENTS) and record the returned document ID.
  //  3. Then: deps.unity.executeAction(UnityActions.Document.SAVE_DOCUMENT_IMAGE, {...}, chartPatientId, 'EHR'),
  //     idempotent per item (check item.status / GetDocuments before writing), audit the result,
  //     set status 'filed', and send the provider review task (SaveTask) per the design.
  throw new IntakeFilingError('FILING_NOT_IMPLEMENTED', 'Filing to the Veradigm® EHR chart is not available yet.');
}

/** File under "(ready for indexing)" for the matched patient. Same guard; same TODO. */
export async function sendToIndexing(item: IntakeItem): Promise<never> {
  assertFilingEnabled();
  const problems = filingPreconditions(item, 'indexing');
  if (problems.includes('already filed')) throw new IntakeFilingError('ALREADY_FILED', 'This document was already filed.');
  if (problems.length) throw new IntakeFilingError('NOT_READY', `Not ready to send to indexing: ${problems.join(', ')}.`);
  // TODO(SaveDocumentImage): same call as fileToChart with the "(ready for indexing)" document type.
  throw new IntakeFilingError('FILING_NOT_IMPLEMENTED', 'Sending to indexing in the Veradigm® EHR is not available yet.');
}
