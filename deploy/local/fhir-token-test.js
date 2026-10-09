// Veradigm FHIR R4 system-app token test (SMART backend services / private_key_jwt).
// Reads VERADIGM_FHIR_CLIENT_ID from .env and signs with secrets/fhir-jwt-private.pem.
// Prints only the outcome, never the token.
//   node deploy/local/fhir-token-test.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = __dirname;
const env = Object.fromEntries(
  fs.readFileSync(path.join(dir, '.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);
const BASE = 'https://fhir.fhirpoint.open.allscripts.com/fhirroute';
const TOKEN = `${BASE}/authorizationV2/CP00101/connect/token`;
const FHIR = `${BASE}/fhir/CP00101`;
const clientId = env.VERADIGM_FHIR_CLIENT_ID;
const key = fs.readFileSync(path.join(dir, 'secrets', 'fhir-jwt-private.pem'));
const jwks = JSON.parse(fs.readFileSync(path.join(dir, 'public', 'jwks.json'), 'utf8'));

const b64u = (b) => Buffer.from(b).toString('base64url');
function assertion(alg, kid) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg, typ: 'JWT', kid };
  const body = { iss: clientId, sub: clientId, aud: TOKEN, jti: crypto.randomUUID(), iat: now, nbf: now, exp: now + 240 };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(body))}`;
  const sig = crypto.sign(alg === 'RS384' ? 'sha384' : 'sha256', Buffer.from(input), key);
  return `${input}.${b64u(sig)}`;
}

(async () => {
  for (const k of jwks.keys) {
    for (const scope of ['system/*.read', 'system/Patient.read']) {
      const form = new URLSearchParams({
        grant_type: 'client_credentials',
        scope,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion(k.alg, k.kid),
      });
      const r = await fetch(TOKEN, { method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const j = await r.json().catch(() => ({}));
      console.log(`${k.alg} kid=${k.kid} scope=${scope} -> ${r.status} ${j.access_token ? 'TOKEN OK (expires_in ' + j.expires_in + ')' : JSON.stringify(j)}`);
      if (j.access_token) {
        const p = await fetch(`${FHIR}/Patient?family=Smith&given=Ed&birthdate=1952-12-06`, { headers: { Authorization: `Bearer ${j.access_token}`, Accept: 'application/fhir+json' } });
        const pj = await p.json().catch(() => ({}));
        console.log(`  Patient search Ed Smith 1952-12-06 -> ${p.status} total=${pj.total ?? (pj.entry || []).length}`);
        return;
      }
    }
  }
})();
