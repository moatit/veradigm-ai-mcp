/**
 * Deterministic emergency backstop on the caller's transcript. If it fires and the emergency line was not played
 * in this turn, the orchestrator plays EMERGENCY_911 itself (exact clip), then lets the model offer a transfer.
 * A false positive costs one unneeded sentence; a miss is not acceptable, so the list leans wide.
 */
const PATTERNS: RegExp[] = [
  /\bchest (pain|pains|pressure|tightness|hurts?)\b/,
  /\b(can'?t|cannot|can not|hard to|trouble|difficulty|struggling to) (breathe|breathing|catch my breath)\b/,
  /\bshort(ness)? of breath\b/,
  /\b(not|isn'?t|stopped) breathing\b/,
  /\bstroke\b/,
  /\b(face|mouth) (is )?(drooping|droopy)\b/,
  /\bslurred speech\b|\bslurring\b/,
  /\b(can'?t|cannot) (move|feel) (my|his|her) (arm|leg|face|side)\b/,
  /\b(bleeding|blood) (a lot|heavily|badly|won'?t stop|everywhere)\b/,
  /\b(heavy|severe|uncontrolled) bleeding\b/,
  /\b(passed out|fainted|fainting|unconscious|unresponsive|collapsed|blacked out)\b/,
  /\b(seizure|seizing|convulsing)\b/,
  /\b(overdose|overdosed|took too many)\b/,
  /\b(heart attack|anaphyla\w*|throat (is )?(closing|swelling))\b/,
  /\b(kill myself|end my life|suicid\w*|hurt myself|self[- ]harm|don'?t want to (live|be alive))\b/,
  /\b(emergency|nine one one|911)\b/,
];

export function emergencyDetected(transcript: string): boolean {
  const t = ` ${String(transcript || '').toLowerCase().replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ')} `;
  return PATTERNS.some((p) => p.test(t));
}
