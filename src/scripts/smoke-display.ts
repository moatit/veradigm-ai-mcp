/**
 * Offline checks for staff-screen display wording and the brand asset routes:
 *  - display.ts maps codes, identifiers, settings and tool names, and never rewrites a person's name
 *    (audit M1: providers named "Garrison" or "Unity", patients named "Google" or "Amazon" stay as written)
 *  - an intake history row naming the review-task recipient shows the name verbatim on the item screen
 *  - the font, font-license and favicon routes may be cached; every other staff response stays no-store (audit I3, L5)
 *
 *   npm run smoke:display
 */
for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-display-'));
process.env.AUDIT_DIR = TMP;
process.env.CALL_RECORDS_DIR = TMP;
process.env.INTAKE_DROP_DIR = path.join(TMP, 'inbox');
process.env.INTAKE_OCR_URL = 'off';
process.env.CLINIC_TIMEZONE = 'America/Boise';
for (const k of ['INTAKE_MODE', 'INTAKE_FILING', 'DRAWBRIDGE_USERNAME', 'DRAWBRIDGE_PASSWORD', 'DRAWBRIDGE_USERS_FILE']) delete process.env[k];

import assert from 'assert';
import type { AddressInfo } from 'net';

async function main(): Promise<void> {
  const d = await import('../platform/display');
  const { IntakeStore } = await import('../platform/modules/intake/store');
  const intake = await import('../platform/modules/intake');
  const shell = await import('../platform/shell');

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // 1. Names are never rewritten, by either mapper.
  const NAMED = [
    'review task 4411 sent to Garrison, Amy, ordering provider (high)',
    'CRITICAL review task 9 sent to Dr. Unity Brown, default',
    'Patient Google Smith not found',
    'Azure Jones, Amazon Garrison, GPT Rao, MCP Lee, unity smith',
    'Dr. Retta Unity',
  ];
  for (const s of NAMED) {
    assert.strictEqual(d.displayTokens(s), s, `displayTokens changed "${s}"`);
    assert.strictEqual(d.displayText(s), s, `displayText changed "${s}"`);
  }
  ok('names (Garrison, Unity, Google, Azure, Amazon, GPT, MCP) pass through displayTokens and displayText unchanged');

  // 2. Codes, identifiers, settings and tool names are still mapped.
  const MAPPED: Array<[string, string]> = [
    ['UNITY_ERROR', 'Veradigm connection error'],
    ['AUTH_ERROR · veradigm_unity', 'Sign-in error · Veradigm connection'],
    ['unity_signin_latched', 'Veradigm sign-in stopped'],
    ['RETELL_SIGNATURE · /webhooks/retell', 'phone assistant signature check · phone assistant call webhook'],
    ['/webhooks/retell-inbound', 'phone assistant inbound call webhook'],
    ['unity_search_patients', 'search_patients'],
    ['RETELL_FROM_NUMBER is not set', 'The outbound caller number is not set'],
    ['UnityService.svc fault', 'VeradigmService.svc fault'],
    ['filing refused (UNITY_ERROR)', 'filing refused (Veradigm connection error)'],
  ];
  for (const [raw, want] of MAPPED) assert.strictEqual(d.displayTokens(raw), want, raw);
  assert.strictEqual(d.displayText('Retell did not return a call_id'), 'voice platform did not return a call_id');
  assert.strictEqual(d.displayText('FHIR server error'), 'Veradigm EHR server error');
  assert.strictEqual(d.displayCode('API_ERROR'), 'API_ERROR');
  assert.strictEqual(d.displayTranscriptRef('retell:call_1'), 'kept on the voice platform');
  assert.strictEqual(d.displayChannel('RETELL'), 'phone assistant');
  ok('codes, identifiers, settings, tool names and vendor brand words in system text are still mapped');

  // 3. The intake item screen shows the review-task recipient exactly as stored.
  const store = new IntakeStore(path.join(TMP, 'intake'));
  const pdf = Buffer.from('%PDF-1.4\n% synthetic smoke document\n%%EOF\n');
  const { item } = store.addDocument({ source: 'upload', source_ref: 'smoke:display', name: 'synthetic.pdf', mime: 'application/pdf', data: pdf });
  store.update(item.id, {}, 'review task 4411 sent to Garrison, Amy, ordering provider (high)', 'drawbridge');
  store.update(item.id, {}, 'CRITICAL review task 9 sent to Dr. Unity Brown, default', 'drawbridge');
  store.update(item.id, {}, 'filing refused (UNITY_ERROR)', 'smoke.staff');
  const html = intake.itemPage(store.get(item.id)!);
  assert.ok(html.includes('review task 4411 sent to Garrison, Amy, ordering provider (high)'), 'Garrison shown as written');
  assert.ok(html.includes('CRITICAL review task 9 sent to Dr. Unity Brown, default'), 'Dr. Unity Brown shown as written');
  assert.ok(html.includes('filing refused (Veradigm connection error)'), 'the code in the same history is still mapped');
  assert.ok(!/outside testing firm|Veradigm Brown/.test(html));
  ok('intake history: "sent to Garrison, Amy" and "Dr. Unity Brown" shown verbatim; the code beside them still mapped');

  // 4. Brand asset routes: cacheable, with the OFL license served; every other response stays no-store.
  const express = (await import('express')).default;
  const app = express();
  app.use('/app', shell.shellRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const cache = async (p: string) => {
      const r = await fetch(url + p, { redirect: 'manual' });
      return { status: r.status, cc: r.headers.get('cache-control'), csp: r.headers.get('content-security-policy'), body: await r.text() };
    };
    const font = await cache('/app/assets/fonts/barlow-500.woff2');
    assert.ok(font.status === 200 && font.cc === 'public, max-age=31536000, immutable' && font.csp, JSON.stringify({ ...font, body: '' }));
    const lic = await cache('/app/assets/fonts/LICENSE.txt');
    assert.ok(lic.status === 200 && lic.cc === 'public, max-age=31536000, immutable');
    for (const want of ['SIL OPEN FONT LICENSE Version 1.1', 'The Poppins Project Authors', 'The Barlow Project Authors']) assert.ok(lic.body.includes(want), `license lacks "${want}"`);
    const fav = await cache('/app/assets/favicon.svg');
    assert.ok(fav.status === 200 && fav.cc === 'public, max-age=604800');
    for (const p of ['/app/assets/fonts/nope.woff2', '/app/assets/drawbridge.js', '/app/login']) {
      const r = await cache(p);
      assert.strictEqual(r.cc, 'no-store', `${p} must stay no-store`);
    }
    ok('fonts and their OFL license cached for a year, favicon for a week; 404s, script and pages stay no-store; headers kept');
  } finally {
    server.close();
  }

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error('FAIL', e?.message || e);
  process.exit(1);
});
