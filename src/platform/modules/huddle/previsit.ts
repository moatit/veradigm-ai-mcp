import { UnityErrorCode, UnityErrorHandler, UnityMCPError } from '../../../unity/utils/error-handler';
import { isToolFailure } from '../../../unity/utils/tool-result';
import type { PlatformDeps } from '../../registry';
import { runChecked } from './brief';
import { clinicDateKey, clinicMinutesNow, clockLabel, dateLabel, money, parseClock, parseDateKey } from './dates';

/**
 * Pre-visit check (deck slide 9): what a verified patient needs for their next appointment.
 * Read only. The phone agent must have verified the caller's identity before calling this.
 *
 *   PREVISIT_INSTRUCTIONS   replaces the "arrive 15 minutes early" line (clinic-specific text)
 */
export interface ChecklistItem {
  item: 'appointment' | 'insurance' | 'balance' | 'bring' | 'arrive';
  /** ok = nothing to do; action = the patient should do something; unknown = Drawbridge couldn't check. */
  status: 'ok' | 'action' | 'unknown';
  text: string;
}

export interface PrevisitResult {
  success: true;
  hasUpcomingVisit: boolean;
  nextVisit?: { appointmentId: string; date: string; time: string; provider: string; location: string; visitType: string };
  checklist: ChecklistItem[];
  message: string;
}

const CANCELLED = /cancel|no[\s-]?show|deleted|bumped|rescheduled|checked\s*out|completed/i;
const KNOWN_CODES: UnityErrorCode[] = [
  'VALIDATION_ERROR', 'AUTH_ERROR', 'API_ERROR', 'NOT_FOUND', 'FORBIDDEN',
  'SERVER_ERROR', 'NETWORK_ERROR', 'TIMEOUT_ERROR', 'UNKNOWN_ERROR',
];

export const DEFAULT_ARRIVE = 'Please arrive 15 minutes early to check in.';

export async function previsitCheck(
  deps: PlatformDeps,
  patientId: unknown,
  opts: { now?: () => number; budgetMs?: number } = {}
): Promise<PrevisitResult> {
  const now = opts.now || Date.now;
  const id = String(patientId ?? '').trim();
  if (!id) throw UnityErrorHandler.createValidationError('patientId is required (verify the caller first)');

  // Same call the phone agent makes. No date range is passed: the existing tool's range format
  // (Parameter1 "start|end") is unverified, so we take every appointment and filter here.
  const tool = 'unity_get_patient_appointments';
  let r: any;
  try {
    r = await deps.runTool(tool, { patientId: id });
  } catch (e) {
    throw UnityErrorHandler.handleUnknownError(e, tool);
  }
  if (isToolFailure(r)) {
    const code = KNOWN_CODES.includes(r.error_code as UnityErrorCode) ? (r.error_code as UnityErrorCode) : 'API_ERROR';
    throw new UnityMCPError('Appointment lookup failed', code, undefined, tool);
  }
  if (!r || !Array.isArray(r.appointments)) {
    throw UnityErrorHandler.createAPIError('Appointment lookup returned no readable list', tool);
  }

  const today = clinicDateKey(new Date(now()));
  const nowMin = clinicMinutesNow(new Date(now()));
  const upcoming = (r.appointments as any[])
    .map((a) => {
      const date = parseDateKey(a?.date);
      const minutes = parseClock(a?.time) ?? parseClock(a?.date);
      return { a, date, minutes };
    })
    .filter(({ a, date, minutes }) => {
      if (!date) return false;
      if (a?.status && CANCELLED.test(String(a.status))) return false;
      if (date > today) return true;
      return date === today && (minutes === null || minutes >= nowMin);
    })
    .sort((x, y) => (x.date! < y.date! ? -1 : x.date! > y.date! ? 1 : (x.minutes ?? 0) - (y.minutes ?? 0)));

  if (upcoming.length === 0) {
    return {
      success: true,
      hasUpcomingVisit: false,
      checklist: [],
      message: "I don't see an upcoming appointment on file.",
    };
  }

  const next = upcoming[0];
  const visit = {
    appointmentId: String(next.a.id || ''),
    date: next.date!,
    time: next.minutes !== null ? clockLabel(next.minutes) : '',
    provider: String(next.a.providerName || ''),
    location: String(next.a.locationName || ''),
    visitType: String(next.a.appointmentType || ''),
  };

  const deadline = now() + (opts.budgetMs ?? 15_000);
  const [ins, bal] = await Promise.all([
    runChecked(deps, 'unity_get_insurance_policy', { patientId: id }, deadline, now),
    runChecked(deps, 'unity_get_account_balance', { patientId: id }, deadline, now),
  ]);

  const checklist: ChecklistItem[] = [];

  const when = `${dateLabel(visit.date, false)}${visit.time ? ` at ${visit.time}` : ''}`;
  checklist.push({
    item: 'appointment',
    status: 'ok',
    text: `Your next appointment is ${when}${visit.provider ? ` with ${visit.provider}` : ''}${visit.location ? ` at ${visit.location}` : ''}.`,
  });

  // Insurance: carrier and last 4 of the member ID only.
  if (ins.ok && Array.isArray(ins.result.policies)) {
    const policies = ins.result.policies as Array<{ order?: string; carrier?: string; plan?: string; memberIdLast4?: string }>;
    const primary = policies.find((p) => /^(1|p|primary)/i.test(String(p.order || ''))) || policies[0];
    if (!primary) {
      checklist.push({ item: 'insurance', status: 'action', text: "We don't have insurance on file, so please bring your insurance card." });
    } else {
      const carrier = primary.carrier || primary.plan || 'your insurance';
      const last4 = String(primary.memberIdLast4 || '').replace(/\D/g, '').slice(-4);
      checklist.push({
        item: 'insurance',
        status: 'ok',
        text: `We have ${carrier} on file${last4 ? `, member ID ending in ${last4.split('').join(' ')}` : ''}. Please bring your card in case anything changed.`,
      });
    }
  } else {
    checklist.push({ item: 'insurance', status: 'unknown', text: "I couldn't check your insurance right now, so please bring your insurance card." });
  }

  if (bal.ok && typeof bal.result.balance === 'number') {
    const b = bal.result.balance as number;
    checklist.push(
      b > 0
        ? { item: 'balance', status: 'action', text: `There's a balance of ${money(b)} on your account; you can take care of it at check-in.` }
        : { item: 'balance', status: 'ok', text: 'There is no balance due on your account.' }
    );
  } else {
    checklist.push({ item: 'balance', status: 'unknown', text: "I couldn't check your account balance right now; the front desk can help at check-in." });
  }

  checklist.push({ item: 'bring', status: 'action', text: 'Please bring a list of your current medications and a photo ID.' });
  checklist.push({ item: 'arrive', status: 'action', text: (process.env.PREVISIT_INSTRUCTIONS || '').trim() || DEFAULT_ARRIVE });

  console.error(`[Huddle] previsit check: ${checklist.map((c) => `${c.item}=${c.status}`).join(' ')}`);

  return {
    success: true,
    hasUpcomingVisit: true,
    nextVisit: visit,
    checklist,
    message: checklist.map((c) => c.text).join(' '),
  };
}
