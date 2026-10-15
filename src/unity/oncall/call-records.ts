import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Call record store for the Drawbridge on-call notebook (spec §6).
 *
 * File-backed JSON (one file) so the demo needs no database. Records hold patient identity and
 * chart context, so the file must live on the MOATiT-controlled host only (CALL_RECORDS_DIR),
 * never in the repo, logs or a shared drive. Replace with the production database once
 * open question Q5/Q6 (where call records live) is decided.
 */
export type CallMode = 'business_hours' | 'after_hours';
export type Urgency = 'urgent' | 'routine';

export interface CallRecord {
  call_id: string;
  started_at: string;
  updated_at: string;
  mode: CallMode;
  caller_phone: string;
  verified: boolean;
  patient_ref: { system: 'veradigm_pm' | 'veradigm_ehr' | ''; id: string };
  patient_name: string;
  dob: string;
  reason_verbatim: string;
  urgency: Urgency;
  chart_snapshot: {
    medications: string[];
    allergies: string[];
    problems: string[];
    latest_observations: string[];
    next_appointment: string;
  };
  actions_taken: Array<{ at: string; tool: string; result: 'success' | 'error'; detail?: string }>;
  staff_task_id: string;
  alert: { sent: boolean; at?: string; to?: string; note?: string };
  transcript_ref: string;
  /** From Retell call events (activity module). Never the transcript itself. */
  call_meta?: { ended_at?: string; duration_ms?: number; disconnection_reason?: string; summary?: string };
}

const DIR = process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DIR, 'call-records.json');

let cache: Map<string, CallRecord> | null = null;

function load(): Map<string, CallRecord> {
  if (cache) return cache;
  cache = new Map();
  try {
    const rows: CallRecord[] = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const r of rows) cache.set(r.call_id, r);
  } catch {
    // No file yet: start empty.
  }
  return cache;
}

function persist(): void {
  const rows = [...load().values()];
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function blank(callId: string, mode: CallMode): CallRecord {
  const now = new Date().toISOString();
  return {
    call_id: callId,
    started_at: now,
    updated_at: now,
    mode,
    caller_phone: '',
    verified: false,
    patient_ref: { system: '', id: '' },
    patient_name: '',
    dob: '',
    reason_verbatim: '',
    urgency: 'routine',
    chart_snapshot: { medications: [], allergies: [], problems: [], latest_observations: [], next_appointment: '' },
    actions_taken: [],
    staff_task_id: '',
    alert: { sent: false },
    transcript_ref: '',
  };
}

export const callRecords = {
  list(): CallRecord[] {
    // Urgent first, then newest first (spec §6 screen 1).
    return [...load().values()].sort((a, b) => {
      if (a.urgency !== b.urgency) return a.urgency === 'urgent' ? -1 : 1;
      return b.started_at.localeCompare(a.started_at);
    });
  },

  get(callId: string): CallRecord | undefined {
    return load().get(callId);
  },

  /** Create or merge fields into a record. Arrays in the patch replace, except actions_taken. */
  upsert(callId: string | undefined, mode: CallMode, patch: Partial<CallRecord>): CallRecord {
    const id = callId || `manual-${randomUUID()}`;
    const store = load();
    const current = store.get(id) || blank(id, mode);
    const next: CallRecord = {
      ...current,
      ...patch,
      call_id: id,
      chart_snapshot: { ...current.chart_snapshot, ...(patch.chart_snapshot || {}) },
      patient_ref: { ...current.patient_ref, ...(patch.patient_ref || {}) },
      alert: { ...current.alert, ...(patch.alert || {}) },
      actions_taken: current.actions_taken,
      updated_at: new Date().toISOString(),
    };
    store.set(id, next);
    persist();
    return next;
  },

  /** Append a tool call to the record for this call (no chart contents, outcome only). */
  recordAction(callId: string | undefined, mode: CallMode, tool: string, ok: boolean, detail?: string): void {
    if (!callId) return;
    const store = load();
    const rec = store.get(callId) || blank(callId, mode);
    rec.actions_taken.push({ at: new Date().toISOString(), tool, result: ok ? 'success' : 'error', detail });
    rec.updated_at = new Date().toISOString();
    store.set(callId, rec);
    persist();
  },
};
