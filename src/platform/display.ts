/**
 * Display-time wording for staff screens: no vendor or subprocessor names and no internal system names
 * (MCP, FHIR, Unity) on screen. Only what is shown changes: stored values, audit and log fields, API payloads,
 * error codes, tool names and settings keep their raw form.
 *
 * Two levels, so a person's name is never rewritten (audit M1, Oct 18):
 *  - displayTokens: exact system tokens only (codes, identifiers, settings, tool names, the "UnityService" endpoint).
 *    Safe on text that can carry names: intake history, Veradigm log lines, security-event objects.
 *  - displayText: displayTokens plus unambiguous vendor brand words (Retell, ElevenLabs, OpenAI, ChatGPT, AWS,
 *    Cloudflare, Twilio, SentinelOne, FHIR) for system-generated text only (error details, outreach reasons).
 * Words that are also people's names (Garrison, Google, Amazon, Azure, Unity, GPT, MCP) are never mapped as words.
 * Neither is ever applied to what a patient or staff member wrote.
 */

/** Codes that name an internal system or vendor, or that staff asked to read in plain words. Others show as they are. */
const CODE_LABEL: Record<string, string> = {
  UNITY_ERROR: 'Veradigm connection error',
  FHIR_ERROR: 'Veradigm EHR connection error',
  AUTH_ERROR: 'Sign-in error',
  RETELL_SIGNATURE: 'phone assistant signature check',
  RETELL_INBOUND: 'phone assistant inbound call check',
};

/** Identifiers that reach the screen (security event names, objects, routes) and their plain names. */
const NAME_LABEL: Record<string, string> = {
  unity_signin_latched: 'Veradigm sign-in stopped',
  unity_signin_retry: 'Veradigm sign-in retried',
  veradigm_unity: 'Veradigm connection',
  veradigm_fhir: 'Veradigm EHR connection',
  'unity-auth-latch.json': 'Veradigm sign-in stop file',
  '/webhooks/retell-inbound': 'phone assistant inbound call webhook',
  '/webhooks/retell': 'phone assistant call webhook',
  '/api/retell': 'phone assistant tools',
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const CODE_RE = new RegExp(`\\b(${Object.keys(CODE_LABEL).join('|')})\\b`, 'g');
// Longest first, so "/webhooks/retell-inbound" wins over "/webhooks/retell".
const NAME_RE = new RegExp(
  Object.keys(NAME_LABEL)
    .sort((a, b) => b.length - a.length)
    .map((k) => (/^\w/.test(k) ? `\\b${escapeRe(k)}\\b` : `${escapeRe(k)}(?![\\w-])`))
    .join('|'),
  'g'
);

/** Exact system tokens: settings, tool names and the Veradigm endpoint name. No dictionary words. */
const TOKENS: Array<[RegExp, string]> = [
  [/\bRETELL_FROM_NUMBER is not set\b/g, 'The outbound caller number is not set'],
  [/\bRETELL_[A-Z0-9_]+\b/g, 'phone assistant setting'],
  [/\b(?:unity|fhir)_([a-z0-9]+(?:_[a-z0-9]+)*)\b/g, '$1'], // tool names: unity_search_patients → search_patients
  [/\bUnity(?=Service\b)/g, 'Veradigm'], // Veradigm's own endpoint name in its log lines (UnityService.svc)
];

/** Vendor brand words that are not people's names, for system-generated text only. */
const BRANDS: Array<[RegExp, string]> = [
  [/\bRetell(?:\s?AI)?\b/g, 'voice platform'],
  [/\bElevenLabs\b/g, 'voice platform'],
  [/\b(?:OpenAI|ChatGPT)\b/g, 'language model'],
  [/\bAWS\b/g, 'US cloud hosting'],
  [/\bCloudflare\b/g, 'network provider'],
  [/\bTwilio\b/g, 'phone carrier'],
  [/\bSentinelOne\b/g, 'endpoint protection'],
  [/\bFHIR\b/g, 'Veradigm EHR'],
];

/** Codes, identifiers, settings and tool names only. Safe on text that may contain a person's name. */
export function displayTokens(text: unknown): string {
  let s = String(text ?? '');
  if (!s) return s;
  s = s.replace(CODE_RE, (c) => CODE_LABEL[c]).replace(NAME_RE, (n) => NAME_LABEL[n]);
  for (const [re, to] of TOKENS) s = s.replace(re, to);
  return s;
}

/** System-generated free text (error details, outreach reasons): tokens plus vendor brand words. */
export function displayText(text: unknown): string {
  let s = displayTokens(text);
  for (const [re, to] of BRANDS) s = s.replace(re, to);
  return s;
}

/** An error code as staff should read it: a plain label for the codes above, the code itself otherwise. */
export function displayCode(code: unknown): string {
  const c = String(code ?? '');
  return CODE_LABEL[c] || displayTokens(c);
}

/** A call's transcript reference ("retell:<call id>") without the vendor name. */
export function displayTranscriptRef(ref: unknown): string {
  const r = String(ref ?? '');
  return /^retell:/i.test(r) ? 'kept on the voice platform' : displayTokens(r);
}

/** The audit channel of a request ("retell", "RETELL", module names, ...) as staff should read it. */
export function displayChannel(channel: unknown): string {
  const c = String(channel ?? '');
  return /^(retell|mcp)$/i.test(c) ? 'phone assistant' : displayTokens(c);
}
