// Acceptance tests for user migration (<migration URL>/spec.md, "Acceptance tests").
// Runs a throwaway copy of the app with its own data files and drives it like a browser, using
// CloakTail's /migrate/check and /migrate/simulate, which create no users.
// Needs CloakTail running and the app's registered JWKS URL (BASE_URL/migrate/jwks.json) reachable:
// if the dev server isn't up, the test copy runs on BASE_URL's port and serves it itself.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, envDefaults, appUrls } from '../src/config.js';
import * as migration from '../src/migration.js';
import { getSettings } from '../src/settings.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'Legacy#2024';
// Users of this run only, with fresh ids: CloakTail remembers every sub it migrated, so the demo
// users (1001-1003) may already be known there from manual testing and would be recovered.
const RUN = crypto.randomBytes(4).toString('hex');
const ALICE = { id: `t${RUN}a`, username: `alice-${RUN}`, email: `alice-${RUN}@example.com`, firstName: 'Alice', lastName: 'Test' };
// Only a signed-in page has a sign-out form (the help text mentions "Sign out" on every page).
const SIGNED_IN = 'action="/logout';
const BOB = { id: `t${RUN}b`, username: `bob-${RUN}`, email: `bob-${RUN}@example.com`, firstName: 'Bob', lastName: 'Test' };

const reachable = (url) => fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);

let skip = false;
if (!migration.hasUrl()) skip = 'no CloakTail migration URL in the settings (Migration page)';
else if (!migration.hasSecret()) skip = 'no migration secret in the settings (Migration page)';
else if (!(await reachable(`${migration.CLOAKTAIL.audience}/spec.md`))) skip = `CloakTail is not reachable at ${migration.CLOAKTAIL.audience}`;

const port = (await reachable(appUrls(envDefaults.baseUrl).jwksUrl)) ? Number(process.env.TEST_PORT || 4100) : config.port;
const base = `http://localhost:${port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testsp-'));
const legacyFile = path.join(tmp, 'legacy-users.json');

// Same record shape and scrypt hash format as legacyUsers.js.
function seedUser(u) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(PASSWORD, salt, 32);
  return {
    ...u,
    passwordHash: ['scrypt', salt.toString('base64url'), hash.toString('base64url')].join('$'),
    createdAt: new Date().toISOString(),
    lastLegacySignInAt: null,
    migrationStartedAt: null,
    migratedAt: null,
    keycloakId: null,
    keycloakUsername: null,
    firstKeycloakSignInAt: null,
    conflict: null,
  };
}
// The test copy has its own settings file: give it this app's CloakTail migration URL and secret.
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ migrationUrl: getSettings().migrationUrl, migrationSecret: getSettings().migrationSecret }));
fs.writeFileSync(legacyFile, JSON.stringify({ [ALICE.id]: seedUser(ALICE), [BOB.id]: seedUser(BOB) }, null, 2));

let server;
if (!skip) {
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      MIGRATION_ACCEPT_SIMULATED: 'true',
      LEGACY_USERS_FILE: legacyFile,
      USERS_FILE: path.join(tmp, 'users.json'),
      SETTINGS_FILE: path.join(tmp, 'settings.json'),
    },
  });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += d; });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('Test SP on') && resolve());
    server.on('exit', (code) => reject(new Error(`test server exited (${code}): ${stderr}`)));
  });
  migration.loadSigningKey();
}

after(() => {
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- helpers ----------

// A browser: keeps the session cookie, never follows redirects.
async function send(jar, method, url, form) {
  const res = await fetch(url.startsWith('http') ? url : base + url, {
    method,
    redirect: 'manual',
    headers: {
      ...(jar.cookie ? { cookie: jar.cookie } : {}),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('testsp.sid='));
  if (cookie) jar.cookie = cookie.split(';')[0];
  return res;
}

const legacyUser = (id) => JSON.parse(fs.readFileSync(legacyFile, 'utf8'))[id];
const resetUser = (id) => send({}, 'POST', `/migrate/users/${id}/reset`);

// Signs in with the old password; returns the browser and the request the app hands to CloakTail.
async function login(username = ALICE.username) {
  const jar = {};
  const res = await send(jar, 'POST', '/legacy/login', { username, password: PASSWORD });
  assert.equal(res.status, 200, `expected the hand-off page, got ${res.status} -> ${res.headers.get('location')}`);
  const token = (await res.text()).match(/name="request" value="([^"]+)"/)?.[1];
  assert.ok(token, 'hand-off page has no request');
  return { jar, token, ...migration.peek(token) };
}

// CloakTail's signed result for the request, as a URL on the test server.
async function simulate(token, status) {
  const { httpStatus, body } = await migration.simulate(token, status);
  assert.equal(httpStatus, 200, JSON.stringify(body.error));
  const url = new URL(body.redirect_url);
  return `${base}${url.pathname}${url.search}`;
}

function signResult(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}`;
  return `${input}.${crypto.createHmac('sha256', getSettings().migrationSecret).update(input).digest('base64url')}`;
}

// The result in url with its claims changed and signed again with the migration secret.
function reSigned(url, changes) {
  const u = new URL(url);
  const { claims } = migration.peek(u.searchParams.get('result'));
  u.searchParams.set('result', signResult({ ...claims, ...changes }));
  return u.toString();
}

const sentToKeycloak = (res) => {
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  const idp = process.env.IDP_SSO_URL;
  assert.ok(idp ? location.startsWith(idp) : !location.startsWith('/'), `expected Keycloak, got ${location}`);
  assert.ok(!location.startsWith(migration.CLOAKTAIL.audience), 'sent to CloakTail');
};

// Spec: a rejected result gets no session and leaves the user unchanged.
async function assertRejected(jar, url, ...ids) {
  const before = ids.map(legacyUser);
  const res = await send(jar, 'GET', url);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/legacy');
  assert.deepEqual(ids.map(legacyUser), before, 'user changed by a rejected result');
  const home = await send(jar, 'GET', '/');
  assert.ok(!(await home.text()).includes(SIGNED_IN), 'a rejected result started a session');
}

// ---------- requests ----------

test('a request built by the app passes /migrate/check', { skip }, async () => {
  await resetUser(ALICE.id);
  const { token } = await login();
  const { httpStatus, body } = await migration.check(token);
  assert.equal(httpStatus, 200, JSON.stringify(body.error));
  assert.equal(body.ok, true);
});

test('two requests never share a jti', { skip }, async () => {
  await resetUser(ALICE.id);
  const a = await login();
  const b = await login();
  assert.notEqual(a.claims.jti, b.claims.jti);
  assert.notEqual(a.claims.state, b.claims.state);
});

test('a wrong old password never reaches CloakTail', { skip }, async () => {
  await resetUser(ALICE.id);
  const res = await send({}, 'POST', '/legacy/login', { username: ALICE.username, password: 'wrong' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/legacy');
});

// ---------- results, by status ----------

// created: signed in at once (the old password was just checked); already_migrated: Keycloak.
for (const status of ['created', 'already_migrated']) {
  test(`${status}: marks the user migrated, then ${status === 'created' ? 'signs them in at once' : 'signs in with Keycloak'}`, { skip }, async () => {
    await resetUser(ALICE.id);
    const { jar, token } = await login();
    const res = await send(jar, 'GET', await simulate(token, status));
    if (status === 'created') {
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/');
      assert.ok((await (await send(jar, 'GET', '/')).text()).includes(SIGNED_IN), 'no session');
    } else {
      sentToKeycloak(res);
    }
    const user = legacyUser(ALICE.id);
    assert.ok(user.migratedAt);
    assert.ok(user.keycloakId);

    // From now on: straight to Keycloak, old password not asked, never CloakTail.
    sentToKeycloak(await send({}, 'POST', '/legacy/identify', { username: ALICE.username }));
    sentToKeycloak(await send({}, 'POST', '/legacy/login', { username: ALICE.username, password: PASSWORD }));
  });
}

test('conflict: not migrated, flagged for support, signed in the old way', { skip }, async () => {
  await resetUser(ALICE.id);
  const { jar, token } = await login();
  const res = await send(jar, 'GET', await simulate(token, 'conflict'));
  assert.equal(res.headers.get('location'), '/');
  const user = legacyUser(ALICE.id);
  assert.equal(user.migratedAt, null);
  assert.ok(user.conflict);

  // Not sent to CloakTail again until someone sorts it out.
  const again = await send({}, 'POST', '/legacy/login', { username: ALICE.username, password: PASSWORD });
  assert.equal(again.status, 302);
  assert.equal(again.headers.get('location'), '/');
});

for (const status of ['cancelled', 'expired', 'error']) {
  test(`${status}: signed in the old way, asked again next time`, { skip }, async () => {
    await resetUser(ALICE.id);
    const { jar, token } = await login();
    const before = legacyUser(ALICE.id).lastLegacySignInAt;
    const res = await send(jar, 'GET', await simulate(token, status));
    assert.equal(res.headers.get('location'), '/');
    const user = legacyUser(ALICE.id);
    assert.equal(user.migratedAt, null);
    assert.equal(user.conflict, null);
    assert.notEqual(user.lastLegacySignInAt, before);
    assert.ok((await (await send(jar, 'GET', '/')).text()).includes(SIGNED_IN), 'no session');
    await login(); // asked again
  });
}

// ---------- results that must be rejected ----------

test('control: a result re-signed with the migration secret is accepted', { skip }, async () => {
  await resetUser(ALICE.id);
  const { jar, token } = await login();
  const res = await send(jar, 'GET', reSigned(await simulate(token, 'cancelled'), {}));
  assert.equal(res.headers.get('location'), '/');
});

test('rejects a result with a wrong signature', { skip }, async () => {
  await resetUser(ALICE.id);
  const { jar, token } = await login();
  const url = new URL(await simulate(token, 'created'));
  const [h, p, s] = url.searchParams.get('result').split('.');
  url.searchParams.set('result', `${h}.${p}.${s[0] === 'A' ? 'B' : 'A'}${s.slice(1)}`);
  await assertRejected(jar, url.toString(), ALICE.id);
});

test('rejects a result for another aud', { skip }, async () => {
  await resetUser(ALICE.id);
  const { jar, token } = await login();
  await assertRejected(jar, reSigned(await simulate(token, 'created'), { aud: 'some-other-app' }), ALICE.id);
});

test('rejects an expired result', { skip }, async () => {
  await resetUser(ALICE.id);
  const { jar, token } = await login();
  const exp = Math.floor(Date.now() / 1000) - 120;
  await assertRejected(jar, reSigned(await simulate(token, 'created'), { exp }), ALICE.id);
});

test('rejects a result in a browser without the pre-login session', { skip }, async () => {
  await resetUser(ALICE.id);
  const { token } = await login();
  await assertRejected({}, await simulate(token, 'created'), ALICE.id);
});

test('rejects a result whose state belongs to another pre-login session', { skip }, async () => {
  await resetUser(ALICE.id);
  const first = await login();
  const second = await login();
  await assertRejected(second.jar, await simulate(first.token, 'created'), ALICE.id);
});

test('rejects a result used twice', { skip }, async () => {
  await resetUser(ALICE.id);
  const { jar, token } = await login();
  const url = await simulate(token, 'cancelled');
  const firstJar = { ...jar };
  await send(jar, 'GET', url);
  await assertRejected(firstJar, url, ALICE.id);
});

// ---------- recovering a lost result (POST /migrate/status) ----------

test('a user sent before but not migrated is checked, then sent to CloakTail again', { skip }, async () => {
  await resetUser(ALICE.id);
  await login(); // never comes back
  assert.ok(legacyUser(ALICE.id).migrationStartedAt);
  await login(); // status answers migrated: false, so a new request
  assert.equal(legacyUser(ALICE.id).migratedAt, null);
});

// Needs the CloakTail API credential (setup only, never the app's runtime): in .env.cloaktail or
// the environment. Links alice's sub to a sandbox test user, as a developer resolving a lost
// result or a conflict would, then removes the link and any test user it created.
const api = async (method, url, body) => {
  if (!api.token) {
    const basic = Buffer.from(`${process.env.CLOAKTAIL_CLIENT_ID}:${process.env.CLOAKTAIL_CLIENT_SECRET}`).toString('base64');
    const res = await fetch(`${API}/oauth/token`, { method: 'POST', headers: { authorization: `Basic ${basic}` }, body: new URLSearchParams({ grant_type: 'client_credentials' }) });
    api.token = (await res.json()).access_token;
    assert.ok(api.token, 'no CloakTail API token');
  }
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { authorization: `Bearer ${api.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const API = `${migration.CLOAKTAIL.audience.replace(/\/migrate$/, '')}/api/v1`;
for (const file of ['.env.cloaktail']) {
  const p = path.join(ROOT, file);
  if (fs.existsSync(p)) for (const [, k, v] of fs.readFileSync(p, 'utf8').matchAll(/^(CLOAKTAIL_CLIENT_(?:ID|SECRET))=(.*)$/gm)) process.env[k] ??= v.trim();
}
const noCredential = !process.env.CLOAKTAIL_CLIENT_ID || !process.env.CLOAKTAIL_CLIENT_SECRET;

test('a lost result is recovered: a user CloakTail knows goes to Keycloak at the next sign-in',
  { skip: skip || (noCredential && 'no CloakTail API credential (.env.cloaktail)') }, async () => {
    await resetUser(ALICE.id);
    const { claims } = await login(); // sent to CloakTail, never comes back
    const app = (await api('GET', '/apps')).body.apps.find((a) => a.client_id === claims.iss);
    assert.ok(app, `no CloakTail app with client ID ${claims.iss}`);

    const username = 'migration-recovery-test';
    let created = null;
    const existing = (await api('GET', '/test-users')).body.test_users?.find((u) => u.username === username);
    if (!existing) {
      const r = await api('POST', '/test-users', {
        username, email: `${username}@example.com`, first_name: 'Recovery', last_name: 'Test', password: crypto.randomBytes(12).toString('base64url'),
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      created = r.body;
    }
    try {
      // By email: the sandbox realm uses the email as the Keycloak username.
      const link = await api('PUT', `/apps/${app.id}/migration/users/${ALICE.id}`, { username: `${username}@example.com` });
      assert.ok([200, 201].includes(link.status), JSON.stringify(link.body));

      sentToKeycloak(await send({}, 'POST', '/legacy/login', { username: ALICE.username, password: PASSWORD }));
      const user = legacyUser(ALICE.id);
      assert.ok(user.migratedAt);
      assert.ok(user.keycloakId);
    } finally {
      await api('DELETE', `/apps/${app.id}/migration/users/${ALICE.id}`);
      if (created?.id) await api('DELETE', `/test-users/${created.id}`);
      await resetUser(ALICE.id);
    }
  });

test('rejects a result whose sub is not the user who signed in', { skip }, async () => {
  await resetUser(ALICE.id);
  await resetUser(BOB.id);
  const alice = await login();
  const m = {
    clientId: alice.claims.iss,
    returnUrl: alice.claims.return_url,
    requestSigning: alice.header.alg === 'HS256' ? 'secret' : 'jwks',
  };
  const forBob = migration.buildRequest(m, BOB, alice.claims.state).token;
  await assertRejected(alice.jar, await simulate(forBob, 'created'), ALICE.id, BOB.id);
});
