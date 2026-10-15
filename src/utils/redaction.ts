/**
 * Redacted FHIR data (spec §4 rule 6).
 *
 * Veradigm can return entries whose content is withheld (security label REDACT/REDACTED,
 * data-absent-reason "masked", or text saying it is redacted). If any part of a result is
 * withheld, the agent must not say "none on file": it says the information can't be shared
 * by phone and offers a transfer.
 */

const REDACTION_MARKERS = [
  /"code"\s*:\s*"(REDACT|REDACTED)"/i,
  /"code"\s*:\s*"masked"/i, // data-absent-reason
  /redacted/i,
];

export function containsRedaction(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return false;
  }
  return REDACTION_MARKERS.some((re) => re.test(text));
}

/** Adds `redacted: true` to an object result that contains withheld data. */
export function markRedacted<T>(result: T): T {
  if (result && typeof result === 'object' && !Array.isArray(result) && containsRedaction(result)) {
    return { ...(result as any), redacted: true };
  }
  return result;
}
