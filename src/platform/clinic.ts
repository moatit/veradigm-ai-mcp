/**
 * Per-client settings that used to be hard-coded (Veradigm: no client-specific values in code).
 *
 *   CLINIC_NAME   the practice's name, shown in the staff app header, said by the outbound
 *                 outreach agent (clinic_name) and used by intake as the receiving practice (never
 *                 taken as a document's sender; INTAKE_PRACTICE_NAME overrides it there).
 *                 No default: unset shows "Drawbridge" and intake excludes no name.
 */
export function clinicName(): string {
  return String(process.env.CLINIC_NAME || '').trim();
}

/** CLINIC_NAME, or "Drawbridge" when unset. */
export function clinicLabel(): string {
  return clinicName() || 'Drawbridge';
}

/** Whole seconds from an env var, at least `min`, else the default. */
export function envSeconds(name: string, fallback: number, min: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}
