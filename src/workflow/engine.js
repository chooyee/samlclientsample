// Durable workflows with DBOS (https://docs.dbos.dev): a library that saves each workflow step in
// Postgres, so a run survives restarts and can wait days for an admin. No server besides Postgres;
// DBOS creates its own database and tables (DBOS_SYSTEM_DATABASE_URL) on first launch.
//
// Workflows register at import (registration.js, userMigration.js), before launch(). Each publishes
// its state as the DBOS event "state", which the pages read; input reaches a waiting run as a DBOS
// message on the topic "input".
import crypto from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { config } from '../config.js';

export const APP_NAME = 'testsp';
export const STATE = 'state';
export const INPUT = 'input';

let ready = false;
let launchError = null;
let retryTimer = null;
const RETRY_MS = 15_000;

export const isConfigured = () => Boolean(config.workflows.databaseUrl);
export const isReady = () => ready;

// What the pages say about the engine. reason: for people; detail: the technical cause.
export function engineStatus() {
  if (!isConfigured()) {
    return { ok: false, setup: true, reason: 'Workflows need a Postgres database. Set DBOS_SYSTEM_DATABASE_URL in .env and restart.' };
  }
  if (launchError) {
    return { ok: false, retrying: Boolean(retryTimer), reason: 'The workflow database can\'t be reached. Retrying every 15 seconds; nothing is lost meanwhile.', detail: launchError };
  }
  if (!ready) return { ok: false, reason: 'Starting the workflow engine…' };
  return { ok: true, database: redactUrl(config.workflows.databaseUrl), version: config.workflows.version };
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.href;
  } catch {
    return 'set';
  }
}

// Starts DBOS and resumes the runs a previous process left unfinished. Never throws: without a
// database the app still works, minus the workflows. retry: keep trying in the background if the
// database can't be reached (it may still be starting).
export async function launch({ databaseUrl = config.workflows.databaseUrl, name = APP_NAME, retry = false } = {}) {
  if (!databaseUrl) return false;
  clearTimeout(retryTimer);
  retryTimer = null;
  try {
    DBOS.setConfig({ name, systemDatabaseUrl: databaseUrl, applicationVersion: config.workflows.version, logLevel: process.env.DBOS_LOG_LEVEL || 'warn' });
    await DBOS.launch();
    if (launchError) console.log('Workflows are on: connected to the database.');
    ready = true;
    launchError = null;
  } catch (err) {
    if (launchError !== err.message) console.error(`Workflows are off: ${err.message}${retry ? ' (retrying every 15 s)' : ''}`);
    launchError = err.message;
    if (retry) {
      retryTimer = setTimeout(() => launch({ databaseUrl, name, retry }), RETRY_MS);
      retryTimer.unref();
    }
  }
  return ready;
}

export async function shutdown() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (!ready) return;
  ready = false;
  await DBOS.shutdown();
}

// ---------- secrets in step outputs ----------
// Step outputs are stored in Postgres. Secrets a step must hand to later steps (the values behind
// [secret:N] handles) are stored sealed with a key derived from SESSION_SECRET, never in the clear.

const key = () => crypto.hkdfSync('sha256', config.sessionSecret, 'testsp', 'workflow-secrets', 32);

export function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key()), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function unseal(sealed) {
  if (!sealed) return {};
  try {
    const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key()), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
  } catch {
    return {}; // SESSION_SECRET changed: the handles stay unresolved
  }
}

// ---------- runs, for the pages ----------

// A run's published state, or null if it has none yet.
export async function readState(workflowId) {
  try {
    return await DBOS.getEvent(workflowId, STATE, { timeoutSeconds: 0 });
  } catch {
    return null;
  }
}

const FINAL = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'];
export const isFinal = (status) => FINAL.includes(status);

// Waits until the run has moved past state version `after` and stopped working (waiting for the
// admin, or finished), or timeoutMs passes. Returns the latest state.
export async function waitForIdle(workflowId, { after = 0, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await readState(workflowId);
    if (state && state.v > after && state.status !== 'running') return state;
    const run = await DBOS.getWorkflowStatus(workflowId);
    if (run && isFinal(run.status)) return (await readState(workflowId)) ?? state;
    await new Promise((r) => setTimeout(r, 250));
  }
  return state;
}

// Runs of one workflow, newest first, with their published state.
export async function listRuns(workflowName, { attributes, limit = 20 } = {}) {
  if (!ready) return [];
  const runs = await DBOS.listWorkflows({ workflowName, attributes, limit, sortDesc: true, loadInput: false, loadOutput: false });
  return Promise.all(runs.map(async (r) => ({ ...summary(r), state: await readState(r.workflowID) })));
}

const summary = (r) => ({
  id: r.workflowID,
  name: r.workflowName,
  status: r.status,
  attributes: r.attributes ?? {},
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  completedAt: r.completedAt,
  error: r.error ? String(r.error.message ?? r.error) : null,
  recoveryAttempts: r.recoveryAttempts,
  version: r.applicationVersion,
});

// One run: DBOS's record of it, its saved steps and its published state.
export async function getRun(workflowId) {
  if (!ready) return null;
  const run = await DBOS.getWorkflowStatus(workflowId);
  if (!run) return null;
  const steps = (await DBOS.listWorkflowSteps(workflowId)) ?? [];
  return {
    ...summary(run),
    state: await readState(workflowId),
    steps: steps.map((s) => ({
      id: s.functionID,
      name: s.name,
      error: s.error ? String(s.error.message ?? s.error) : null,
      startedAt: s.startedAtEpochMs ?? null,
      completedAt: s.completedAtEpochMs ?? null,
    })),
  };
}

// Runs waiting for the admin (an approval or an answer), newest first. Cached briefly: every
// admin page asks, for the nav.
let attention = { at: 0, runs: [] };
export async function waitingForAdmin() {
  if (!ready) return [];
  if (Date.now() - attention.at < 3000) return attention.runs;
  try {
    const pending = await DBOS.listWorkflows({ status: 'PENDING', limit: 50, sortDesc: true, loadInput: false, loadOutput: false });
    const runs = (await Promise.all(pending.map(async (r) => ({ ...summary(r), state: await readState(r.workflowID) }))))
      .filter((r) => ['waiting_approval', 'waiting_input'].includes(r.state?.status));
    attention = { at: Date.now(), runs };
  } catch {
    attention = { at: Date.now(), runs: [] };
  }
  return attention.runs;
}
export const forgetWaiting = () => { attention.at = 0; };

export const send = (workflowId, message) => {
  forgetWaiting();
  return DBOS.send(workflowId, message, INPUT);
};
export const cancel = (workflowId) => {
  forgetWaiting();
  return DBOS.cancelWorkflow(workflowId);
};
export const resume = (workflowId) => DBOS.resumeWorkflow(workflowId);
