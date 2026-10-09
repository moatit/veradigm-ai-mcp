import { createHash } from 'crypto';

/**
 * Idempotency for write tools (spec §4 rule 3).
 *
 * Key = call ID + tool + patient + arguments. A retried request with the same key inside the TTL
 * gets the first result back instead of writing twice (no double-booking). Concurrent duplicates
 * share the in-flight promise. Failures are not cached, so a real retry still runs.
 *
 * In-memory: fine for one container; move to the call-record store if Unity runs on more than one.
 */
const TTL_MS = 15 * 60 * 1000;
const entries = new Map<string, { at: number; result: Promise<any> }>();

function keyFor(callId: string, tool: string, args: any): string {
  const stable = JSON.stringify(args ?? {}, Object.keys(args ?? {}).sort());
  return createHash('sha256').update(`${callId}|${tool}|${args?.patientId ?? ''}|${stable}`).digest('hex');
}

export async function withIdempotency<T>(
  callId: string | undefined,
  tool: string,
  args: any,
  run: () => Promise<T>
): Promise<T> {
  // No call ID (e.g. a manual test): nothing to de-duplicate against.
  if (!callId) return run();

  const now = Date.now();
  for (const [k, v] of entries) {
    if (now - v.at > TTL_MS) entries.delete(k);
  }

  const key = keyFor(callId, tool, args);
  const existing = entries.get(key);
  if (existing) {
    console.error(`[Idempotency] Duplicate ${tool} in call ${callId}; returning first result`);
    return existing.result;
  }

  const result = run();
  entries.set(key, { at: now, result });
  try {
    return await result;
  } catch (error) {
    entries.delete(key);
    throw error;
  }
}
