import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile('/fixture.json', 'utf8'));
assert.equal(fixture.version, 'ihrms-tomei-v1');
assert.ok(fixture.check, 'Fixture needs a dedicated readiness account and expected appraisal.');
const core = process.env.CORE_URL || 'http://core:8080';
const api = process.env.API_URL || 'http://api:8080';
const gateway = process.env.GATEWAY_URL || 'http://gateway';
async function request(base, path, token, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : {'Content-Type':'application/json'}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}
async function ready() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(api + '/health/ready', {signal: AbortSignal.timeout(3000)});
      if (response.ok) return;
    } catch { /* startup is still in flight */ }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error('Performance API did not become ready.');
}
await ready();
const check = fixture.check;
// Readiness uses its own identity, so repeating it cannot sign the person out.
const login = await request(core, '/api/v1/auth/credentials-login', null, {username: check.login, password: fixture.password});
assert.equal(login.status, 200, 'Normal credentials login failed.');
const identity = login.data?.data;
assert.ok(identity?.accessToken && identity?.sessionId && identity.mfaAuthenticated, 'Login did not issue a usable session.');
console.log('Normal credentials login passed.');
const switched = await request(core, '/api/v1/auth/profile-switch', identity.accessToken, {userId: check.userId, companyId: check.companyId});
assert.equal(switched.status, 200, 'Allowed profile/company selection failed.');
assert.ok(switched.data?.data?.sessionId, 'Profile selection did not return a session.');
const session = await request(core, `/api/v2/auth/session/${identity.sessionId}?profileId=${check.userId}`);
assert.equal(session.status, 200);
const selected = session.data?.data;
assert.equal(selected?.selectedProfileId, check.userId, 'Wrong profile selected.');
assert.equal(selected?.companyId, check.companyId, 'Wrong company selected.');
assert.ok(selected.token, 'No normal application token was issued.');
assert.equal((await request(core, '/api/v1/i18n/en', selected.token)).status, 200, 'English locale configuration is missing.');
const path = `/api/v1/appraisals/${check.appraisalId}`;
assert.equal((await request(api, path)).status, 401, 'Anonymous appraisal access was not denied.');
const appraisal = await request(api, path, selected.token);
assert.equal(appraisal.status, 200, 'Authenticated appraisal read failed.');
assert.ok(appraisal.data?.data, 'The expected appraisal was absent.');
console.log('Expected actor/company and authenticated appraisal read passed.');
const denied = await request(core, '/api/v1/auth/profile-switch', identity.accessToken, {userId: check.deniedUserId, companyId: check.companyId});
assert.ok(denied.status >= 400 && denied.status < 500, 'Another identity’s profile was not denied.');
for (const page of ['/performanceV2/', '/sso/auth/signin']) {
  const response = await fetch(gateway + page, {signal: AbortSignal.timeout(30_000)});
  assert.ok(response.ok, `Browser page unavailable: ${page}`);
}
console.log('Normal login, selected actor/company, authenticated appraisal, denied access, frontend and SSO checks passed.');
