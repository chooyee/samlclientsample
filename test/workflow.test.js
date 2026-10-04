// Durable workflow tests (workflow/): the registration assistant's run and user migration runs,
// on a real Postgres through DBOS, against a fake CloakTail and a scripted model (no Gemini).
// Needs Postgres: set TEST_DBOS_DATABASE_URL (e.g. postgresql://postgres:postgres@localhost:5432/testsp_test_dbos).
// The database is created if missing; the tests remove their runs' state by using fresh run ids.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB = process.env.TEST_DBOS_DATABASE_URL;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testsp-wf-'));
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.API_CREDENTIALS_FILE = path.join(tmp, 'api-credentials.json');
process.env.DBOS_APP_VERSION = 'test';

const skip = DB ? false : 'set TEST_DBOS_DATABASE_URL to a Postgres database';
const { DBOS } = await import('@dbos-inc/dbos-sdk');
const engine = await import('../src/workflow/engine.js');
const registration = await import('../src/workflow/registration.js');
const userMigration = await import('../src/workflow/userMigration.js');
const { REGISTRATION, validate } = await import('../src/workflow/definitions.js');
const assistant = await import('../src/assistant.js');
const credentials = await import('../src/apiCredentials.js');

// ---------- fake CloakTail ----------

const MIGRATION_SECRET = 'mig-secret-0123456789';
const CLIENT_SECRET = 'client-secret-abcdef';
const requests = [];
const cloaktail = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const json = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.url === '/api/v1/agent.md') return res.writeHead(200, { 'content-type': 'text/markdown' }).end('# Agent guide\nPOST /api/v1/apps creates an app.');
    if (req.url === '/api/v1/oauth/token') return json(200, { access_token: 'tok', expires_in: 300, scope: 'apps' });
    if (req.url === '/api/v1/apps' && req.method === 'GET') return json(200, { apps: [] });
    if (req.url === '/api/v1/apps' && req.method === 'POST') return json(201, { id: 7, issuer: 'http://kc/realms/ep-dev', client_secret: CLIENT_SECRET });
    if (req.url === '/api/v1/apps/7/migration' && req.method === 'PUT') return json(200, { endpoints: { request_aud_and_result_iss: 'http://ct/migrate' }, migration_secret: MIGRATION_SECRET });
    json(404, { error: 'not found' });
  });
});

// ---------- scripted model ----------
// Answers by phase: the latest "Phase N of" brief in the conversation picks the script.

let modelCalls = 0;
const call = (name, args = {}) => ({ functionCall: { name, args } });
const text = (t) => ({ text: t });
const SCRIPT = {
  1: [[text('Reading the reference.'), call('fetch_reference', { url: '/api/v1/agent.md' }), call('get_this_app'), call('get_access_token')],
    [call('http_request', { method: 'GET', url: '/api/v1/apps' })],
    [call('finish_phase', { outcome: 'done', summary: 'No existing app.' })]],
  2: [[text('I will create the app.'), call('http_request', { method: 'POST', url: '/api/v1/apps', json_body: '{"name":"Test SP"}' })],
    [call('finish_phase', { outcome: 'done', summary: 'Created app 7.' })]],
  3: [[call('update_this_app_settings', { oidcIssuer: 'http://kc/realms/ep-dev', oidcClientId: 'testsp', oidcClientSecret: '[secret:1]' })],
    [call('finish_phase', { outcome: 'done', summary: 'Saved.' })]],
  4: [[call('http_request', { method: 'PUT', url: '/api/v1/apps/7/migration', json_body: '{"return_url":"http://sp/migrate/return"}' })],
    [call('finish_phase', { outcome: 'done', summary: 'Migration set up.' })]],
  5: [[call('update_this_app_settings', { migrationUrl: 'http://ct/migrate', migrationSecret: '[secret:2]', migrationProtocol: 'oidc' })],
    [call('finish_phase', { outcome: 'done', summary: 'Saved.' })]],
  6: [[call('check_user_migration')],
    [call('finish_phase', { outcome: 'done', summary: 'Accepted.' })]],
};
function fakeModel(request) {
  modelCalls += 1;
  const texts = request.contents.flatMap((c) => c.parts.map((p) => p.text ?? ''));
  const phase = Number([...texts].reverse().map((t) => t.match(/^Phase (\d+) of/)?.[1]).find(Boolean) ?? 0);
  if (!request.config.tools) return { candidates: [{ content: { role: 'model', parts: [text('All done.')] } }] };
  // Turns this phase already had: model contents after the phase's brief.
  const briefAt = request.contents.findLastIndex((c) => c.parts.some((p) => p.text?.startsWith(`Phase ${phase} of`)));
  const turns = request.contents.slice(briefAt).filter((c) => c.role === 'model').length;
  const parts = SCRIPT[phase][Math.min(turns, SCRIPT[phase].length - 1)];
  return { candidates: [{ content: { role: 'model', parts } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } };
}

// ---------- fake app ----------

const saved = [];
const settings = {};
const host = {
  local: (protocol) => ({ protocol, client_id: 'testsp' }),
  save: async (section, values) => {
    saved.push({ section, values });
    Object.assign(settings, values);
    return { saved: Object.keys(values), configured: true, notes: [] };
  },
  checkMigration: async () => ({ ok: true, user: 'alice' }),
  check: async (name, { facts }) => {
    if (name === 'signin_configured') return settings.oidcClientId ? { ok: true } : { ok: false, reason: 'not saved' };
    if (name === 'migration_configured') return settings.migrationSecret ? { ok: true } : { ok: false, reason: 'no secret' };
    if (name === 'migration_check_passed') return facts.migrationCheckOk ? { ok: true } : { ok: false, reason: 'no check' };
    return { ok: false, reason: 'unknown' };
  },
};

let base;
before(async () => {
  if (skip) return;
  await new Promise((r) => cloaktail.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${cloaktail.address().port}`;
  credentials.saveCredentials({ cloaktailUrl: base, clientId: 'cli', clientSecret: 'sec' });
  assistant.setModel(fakeModel);
  registration.setHost(host);
  assert.equal(await engine.launch({ databaseUrl: DB }), true, 'DBOS launched');
});

after(async () => {
  if (skip) return;
  await engine.shutdown();
  cloaktail.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function approveUntilDone(id) {
  let state = await engine.waitForIdle(id, { timeoutMs: 20_000 });
  for (let i = 0; i < 20 && state.status === 'waiting_approval'; i += 1) {
    await engine.send(id, { type: 'decision', approve: true });
    state = await engine.waitForIdle(id, { after: state.v, timeoutMs: 20_000 });
  }
  return state;
}

test('the definition is valid, and validate() catches bad ones', () => {
  assert.deepEqual(validate(REGISTRATION), []);
  const bad = { phases: [{ id: 'x', title: 'X', goal: 'g', tools: ['rm_rf'], approval: 'sometimes', check: 'vibes' }, { id: 'x', title: '', goal: '', tools: [], approval: 'none' }] };
  const problems = validate(bad).join('\n');
  for (const word of ['unknown tool rm_rf', 'approval must be', 'unknown check vibes', 'used twice', 'title', 'goal', 'at least one tool']) assert.match(problems, new RegExp(word));
});

test('a registration run goes through every phase, waits for each change, and never shows a secret', { skip }, async () => {
  const id = await registration.start({ protocol: 'oidc', referenceUrl: `${base}/api/v1/agent.md`, origin: base, message: 'Register this app.' });

  const first = await engine.waitForIdle(id, { timeoutMs: 20_000 });
  assert.equal(first.status, 'waiting_approval', 'stops before the POST');
  assert.equal(first.phases[0].status, 'done');
  assert.equal(first.pending.calls[0].title, 'POST /api/v1/apps');
  assert.ok(!requests.some((r) => r.method === 'POST' && r.url === '/api/v1/apps'), 'nothing sent before approval');

  const state = await approveUntilDone(id);
  assert.equal(state.status, 'done');
  assert.deepEqual(state.phases.map((p) => p.status), ['done', 'done', 'done', 'done', 'done', 'done']);
  assert.equal(state.metrics.approvals, 4);
  assert.equal((await DBOS.getWorkflowStatus(id)).status, 'SUCCESS');

  // The real secrets reached the settings and CloakTail, behind handles the model saw.
  assert.equal(saved.find((s) => s.values.oidcClientSecret).values.oidcClientSecret, CLIENT_SECRET);
  assert.equal(saved.find((s) => s.values.migrationSecret).values.migrationSecret, MIGRATION_SECRET);
  const post = requests.find((r) => r.method === 'POST' && r.url === '/api/v1/apps');
  assert.match(post.headers['idempotency-key'], new RegExp(`^${id}:\\d+$`));
  assert.equal(post.headers.authorization, 'Bearer tok');

  // Neither the published state nor the saved step outputs hold a secret in the clear.
  const run = await engine.getRun(id);
  const outputs = (await DBOS.listWorkflowSteps(id)).map((s) => s.output);
  for (const [what, stored] of [['state', JSON.stringify(run.state)], ['step outputs', JSON.stringify(outputs)]]) {
    for (const secret of [CLIENT_SECRET, MIGRATION_SECRET]) assert.ok(!stored.includes(secret), `${secret} is not in the ${what}`);
  }
  assert.ok(JSON.stringify(outputs).includes('[secret:1]'), 'the model saw a handle');
  assert.ok(run.steps.some((s) => s.name === 'tool:http_request'));
  assert.ok(run.steps.some((s) => s.name === 'check:migration_check_passed'));
});

test('a run survives a restart while waiting for approval, without calling the model again', { skip }, async () => {
  const id = await registration.start({ protocol: 'oidc', referenceUrl: `${base}/api/v1/agent.md`, origin: base, message: 'Register this app.' });
  const waiting = await engine.waitForIdle(id, { timeoutMs: 20_000 });
  assert.equal(waiting.status, 'waiting_approval');
  const callsBefore = modelCalls;
  const postsBefore = requests.filter((r) => r.method === 'POST').length;

  // The process "restarts": DBOS stops and starts again, and recovers the pending run.
  await engine.shutdown();
  assert.equal(await engine.launch({ databaseUrl: DB }), true);
  const recovered = await engine.waitForIdle(id, { timeoutMs: 20_000 });
  assert.equal(recovered.status, 'waiting_approval', 'still waiting after the restart');
  assert.equal(recovered.pending.calls[0].title, 'POST /api/v1/apps');
  assert.equal(modelCalls, callsBefore, 'saved model turns were replayed, not called again');
  assert.equal(requests.filter((r) => r.method === 'POST').length, postsBefore, 'nothing was sent again');

  const state = await approveUntilDone(id);
  assert.equal(state.status, 'done');
});

test('declining a change sends the admin\'s instead back to the agent', { skip }, async () => {
  const id = await registration.start({ protocol: 'oidc', referenceUrl: `${base}/api/v1/agent.md`, origin: base, message: 'Register this app.' });
  const waiting = await engine.waitForIdle(id, { timeoutMs: 20_000 });
  await engine.send(id, { type: 'message', text: 'Call it "Acme Bank (test)"' });
  const next = await engine.waitForIdle(id, { after: waiting.v, timeoutMs: 20_000 });
  assert.ok(next.log.some((e) => e.kind === 'approval' && e.bad && /Declined: POST/.test(e.text)));
  assert.ok(next.log.some((e) => e.kind === 'user' && /Acme Bank/.test(e.text)));
  assert.equal(next.metrics.declines, 1);
  await engine.cancel(id);
});

test('a user migration run records the result the return URL reports', { skip }, async () => {
  userMigration.setHost({ recover: async () => assert.fail('no recovery when the user came back') });
  const id = await userMigration.start({ userId: 'u1', username: 'alice', jti: `j-${Date.now()}` });
  const waiting = await engine.waitForIdle(id, { timeoutMs: 10_000 });
  assert.equal(waiting.status, 'waiting_user');
  await userMigration.report(id, 'created');
  const done = await engine.waitForIdle(id, { after: waiting.v, timeoutMs: 10_000 });
  assert.equal(done.status, 'done');
  assert.equal(done.outcome, 'migrated');
  assert.deepEqual(done.phases.map((p) => p.status), ['done', 'done', 'done', 'skipped']);
});

test('a user who never comes back is recovered through the status check', { skip }, async () => {
  userMigration.setHost({ recover: async (userId) => ({ migrated: userId === 'u2', detail: 'confirmed by CloakTail /migrate/status' }) });
  const id = await userMigration.start({ userId: 'u2', username: 'bob', jti: `j-${Date.now()}`, waitSeconds: 1 });
  const done = await engine.waitForIdle(id, { after: 1, timeoutMs: 15_000 });
  assert.equal(done.status, 'done');
  assert.equal(done.outcome, 'migrated');
  assert.deepEqual(done.phases.map((p) => p.status), ['done', 'failed', 'skipped', 'done']);
});
