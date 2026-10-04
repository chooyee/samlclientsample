// One durable run per legacy user sent to CloakTail to migrate (see USER_MIGRATION in
// definitions.js). The browser path stays as it was: /migrate/return verifies the result, marks the
// user and signs them in. This run follows the user's migration from the outside:
// - it records what happened, so the Workflows page shows every user's migration;
// - if the user never comes back (closed the tab, lost the redirect), it asks CloakTail whether
//   the migration happened once the 40 minutes are up, and marks the user if so. The same check
//   would otherwise only run at the user's next sign-in.
import { DBOS } from '@dbos-inc/dbos-sdk';
import { USER_MIGRATION } from './definitions.js';
import { STATE, INPUT } from './engine.js';

export const WORKFLOW_NAME = 'user-migration';
const RESULT_WAIT_SECONDS = 40 * 60; // CloakTail gives the user 30 minutes, plus slack

// host: { recover(userId) -> { migrated, detail } }. Set by server.js before DBOS launches.
let host = null;
export const setHost = (h) => { host = h; };

const OUTCOME = {
  created: 'migrated',
  already_migrated: 'migrated',
  conflict: 'conflict',
  cancelled: 'not_migrated',
  expired: 'not_migrated',
  error: 'not_migrated',
  rejected: 'rejected',
};

async function userMigrationWorkflow({ userId, username, jti, waitSeconds = RESULT_WAIT_SECONDS }) {
  const st = {
    v: 0,
    status: 'running',
    user: { id: userId, username },
    jti,
    definition: { id: USER_MIGRATION.id, version: USER_MIGRATION.version, title: USER_MIGRATION.title },
    phases: USER_MIGRATION.phases.map((p) => ({ id: p.id, title: p.title, optional: Boolean(p.optional), status: 'pending', summary: null, startedAt: null, endedAt: null })),
    outcome: null,
    log: [],
    startedAt: await DBOS.now(),
  };
  const [sent, atCloakTail, result, recovery] = st.phases;
  const publish = async (status) => {
    st.status = status;
    st.v += 1;
    st.updatedAt = await DBOS.now();
    await DBOS.setEvent(STATE, st);
  };
  const end = async (phase, status, summary) => {
    phase.status = status;
    phase.summary = summary;
    phase.endedAt = await DBOS.now();
    st.log.push({ kind: status === 'done' ? 'phase' : 'error', text: `${phase.title}: ${summary}`, bad: status !== 'done' });
  };

  sent.startedAt = st.startedAt;
  await end(sent, 'done', `request ${jti}`);
  atCloakTail.status = 'active';
  atCloakTail.startedAt = await DBOS.now();
  await publish('waiting_user');

  const msg = await DBOS.recv(INPUT, { timeoutSeconds: waitSeconds });
  if (msg?.type === 'result') {
    await end(atCloakTail, 'done', 'came back to the return URL');
    result.startedAt = atCloakTail.endedAt;
    st.outcome = OUTCOME[msg.status] ?? 'not_migrated';
    await end(result, msg.status === 'rejected' ? 'failed' : 'done', [msg.status, msg.detail].filter(Boolean).join(': '));
    recovery.status = 'skipped';
  } else {
    await end(atCloakTail, 'failed', 'did not come back within 40 minutes');
    result.status = 'skipped';
    recovery.status = 'active';
    recovery.startedAt = await DBOS.now();
    await publish('running');
    const found = await DBOS.runStep(() => host.recover(userId), { name: 'recover:status', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 5 });
    st.outcome = found.migrated ? 'migrated' : 'abandoned';
    await end(recovery, 'done', found.migrated ? `CloakTail migrated them: marked migrated (${found.detail})` : `not migrated (${found.detail})`);
  }
  await publish('done');
  return { outcome: st.outcome };
}

const workflow = DBOS.registerWorkflow(userMigrationWorkflow, { name: WORKFLOW_NAME });

export const runId = (jti) => `mig-${jti}`;

// Starts the run for a request that was just sent. The request's jti makes it unique.
// waitSeconds: how long to wait for the user to come back (shorter only in tests).
export async function start({ userId, username, jti, waitSeconds }) {
  const id = runId(jti);
  await DBOS.startWorkflow(workflow, { workflowID: id, workflowAttributes: { kind: 'user-migration', user: userId } })({ userId, username, jti, waitSeconds });
  return id;
}

// Tells the run what /migrate/return made of the result. status: a result status, or "rejected".
export const report = (id, status, detail = null) => DBOS.send(id, { type: 'result', status, detail }, INPUT);
