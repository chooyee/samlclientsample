// The registration assistant as a durable workflow: it runs a definition (definitions.js) phase by
// phase. In each phase the agent gets the phase's goal and tools, works, and calls finish_phase;
// code checks the phase's postcondition before the next one starts.
//
// Every model turn and every tool call is a DBOS step, saved in Postgres with its result. After a
// restart DBOS replays the saved results instead of calling the model or CloakTail again, and the
// run carries on from where it stopped: half-way through a phase, or waiting for an approval.
// Waiting costs nothing: the run sleeps in DBOS.recv until the admin answers (up to 7 days).
//
// Rules for this function: anything that talks to the outside or reads the clock is a step (or
// DBOS.now / DBOS.recv), so a replay takes the same path.
import crypto from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import * as assistant from '../assistant.js';
import { REGISTRATION, CATALOG, validate } from './definitions.js';
import { STATE, INPUT, seal, unseal } from './engine.js';

export const WORKFLOW_NAME = 'registration';
const MAX_MODEL_CALLS = 15; // per phase, before the run asks the admin whether to go on
const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000; // an unanswered question or approval ends the run

// What the steps need from the app: its values, saving settings, the migration check, phase checks.
// Set by server.js (and tests) before DBOS launches. host: { local, save, checkMigration, check }
let host = null;
export const setHost = (h) => { host = h; };

function phaseBrief(def, i) {
  const p = def.phases[i];
  return [
    `Phase ${i + 1} of ${def.phases.length}: ${p.title}.`,
    `Goal: ${p.goal}`,
    `Tools in this phase: ${[...p.tools, 'finish_phase'].join(', ')}.`,
    p.approval === 'changes' ? 'Changes wait for the admin\'s approval.' : 'Changes run without asking the admin.',
    p.optional ? 'This phase is optional: skip it (finish_phase with outcome "skipped") only if the admin asked.' : '',
    p.check ? `When you say it is done, the app checks: ${CATALOG.checks[p.check]}` : '',
  ].filter(Boolean).join('\n');
}

async function registrationWorkflow({ protocol, referenceUrl, origin, message, definition: def }) {
  const conn = { referenceUrl, origin, secrets: {} };
  const contents = [];
  let callNo = 0;
  // Published after every change as the DBOS event "state": what the pages show.
  const st = {
    v: 0,
    status: 'running',
    protocol,
    referenceUrl,
    definition: { id: def.id, version: def.version, title: def.title },
    phase: 0,
    phases: def.phases.map((p) => ({ id: p.id, title: p.title, optional: Boolean(p.optional), check: p.check ?? null, status: 'pending', summary: null, startedAt: null, endedAt: null })),
    log: [],
    pending: null,
    facts: {},
    metrics: { modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, approvals: 0, declines: 0 },
    startedAt: await DBOS.now(),
    updatedAt: null,
  };

  const publish = async (status) => {
    st.status = status;
    st.v += 1;
    st.updatedAt = await DBOS.now();
    await DBOS.setEvent(STATE, st);
  };
  const log = (entry) => st.log.push({ ...entry, phase: st.phase });
  const pushUser = (text) => {
    const last = contents.at(-1);
    if (last?.role === 'user') last.parts.push({ text });
    else contents.push({ role: 'user', parts: [{ text }] });
  };

  // Waits for the admin. Returns the message, or null after MAX_WAIT_MS (the run then ends).
  // types: which messages count; others (say, a stale approval click) are dropped.
  const waitFor = async (status, types) => {
    await publish(status);
    const deadlineEpochMS = (await DBOS.now()) + MAX_WAIT_MS;
    for (;;) {
      const msg = await DBOS.recv(INPUT, { deadlineEpochMS });
      if (!msg) return null;
      if (types.includes(msg.type)) return msg;
    }
  };
  const expired = async () => {
    log({ kind: 'error', text: 'No answer for 7 days: the run stopped. Start a new conversation to go on.' });
    await publish('expired');
    return { status: 'expired' };
  };
  const takeMessage = (msg) => {
    log({ kind: 'user', text: msg.text });
    pushUser(msg.text);
  };

  // One tool call as a step. The step returns the secrets map sealed, so a replay restores it.
  const tool = async (call) => {
    callNo += 1;
    const key = `${DBOS.workflowID}:${callNo}`;
    const out = await DBOS.runStep(async () => {
      const c = { ...conn, secrets: { ...conn.secrets } };
      const r = await assistant.runTool(call, { conn: c, protocol, host, idempotencyKey: key });
      return { ...r, secrets: seal(c.secrets) };
    }, { name: `tool:${call.name}` });
    conn.secrets = unseal(out.secrets);
    st.metrics.toolCalls += 1;
    log(out.entry);
    if (call.name === 'check_user_migration') st.facts.migrationCheckOk = out.response?.ok === true;
    return out.response;
  };

  // One model turn as a step, retried on failure. Returns null (and logs why) if there is no answer.
  const think = async (tools, name) => {
    let turn;
    try {
      turn = await DBOS.runStep(() => assistant.callModel({ protocol, conn: { referenceUrl }, contents, tools }), { name, retriesAllowed: true, maxAttempts: 3, intervalSeconds: 2 });
    } catch (err) {
      log({ kind: 'error', text: `Model: ${err.message}` });
      return null;
    }
    st.metrics.modelCalls += 1;
    st.metrics.inputTokens += turn.usage.input;
    st.metrics.outputTokens += turn.usage.output;
    if (!turn.content?.parts?.length) {
      log({ kind: 'error', text: `The model returned no answer (${turn.finishReason || 'unknown reason'}).` });
      return null;
    }
    contents.push(turn.content);
    for (const e of assistant.textEntries(turn.content)) log(e);
    return turn.content;
  };

  log({ kind: 'user', text: message });
  pushUser(message);

  for (let i = 0; i < def.phases.length; i += 1) {
    const phase = def.phases[i];
    const ps = st.phases[i];
    st.phase = i;
    ps.status = 'active';
    ps.startedAt = await DBOS.now();
    pushUser(phaseBrief(def, i));
    await publish('running');

    let calls = 0;
    for (;;) {
      if (calls >= MAX_MODEL_CALLS) {
        log({ kind: 'error', text: `Stopped after ${MAX_MODEL_CALLS} model calls in this phase. Send a message to go on.` });
        const msg = await waitFor('waiting_input', ['message']);
        if (!msg) return expired();
        takeMessage(msg);
        calls = 0;
        continue;
      }
      calls += 1;
      const content = await think(phase.tools, `model:${phase.id}`);
      if (!content) {
        // The last content is still the user's: a message adds to it and the model tries again.
        const msg = await waitFor('waiting_input', ['message']);
        if (!msg) return expired();
        takeMessage(msg);
        continue;
      }

      const fcalls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      if (!fcalls.length) {
        // A question or a report: wait for the admin's answer.
        const msg = await waitFor('waiting_input', ['message']);
        if (!msg) return expired();
        takeMessage(msg);
        continue;
      }

      const responses = [];
      const waiting = [];
      let finish = null;
      for (const call of fcalls) {
        if (call.name === 'finish_phase') finish = call;
        else if (!phase.tools.includes(call.name)) responses.push({ call, response: { error: `${call.name} is not available in this phase. Tools now: ${phase.tools.join(', ')}.` } });
        else if (phase.approval === 'changes' && assistant.isChange(call)) waiting.push(call);
        else responses.push({ call, response: await tool(call) });
      }

      let declined = false;
      if (waiting.length) {
        st.pending = { phase: i, calls: waiting.map((c) => ({ name: c.name, args: c.args, ...assistant.describeCall(c) })) };
        const msg = await waitFor('waiting_approval', ['decision', 'message']);
        if (!msg) return expired();
        st.pending = null;
        const approved = msg.type === 'decision' && msg.approve === true;
        const instead = String((msg.type === 'message' ? msg.text : msg.note) ?? '').trim();
        for (const call of waiting) {
          const { title } = assistant.describeCall(call);
          if (approved) {
            st.metrics.approvals += 1;
            log({ kind: 'approval', text: `Approved: ${title}` });
            responses.push({ call, response: await tool(call) });
          } else {
            st.metrics.declines += 1;
            log({ kind: 'approval', text: `Declined: ${title}`, bad: true });
            responses.push({ call, response: { error: 'The admin declined this step.', ...(instead ? { admin_instead: instead } : {}) } });
          }
        }
        declined = !approved;
        if (instead && !approved) log({ kind: 'user', text: instead });
      }

      let next = false;
      let blocked = false;
      if (finish) {
        const { outcome, summary = '' } = finish.args ?? {};
        let response;
        if (declined) {
          response = { error: 'Not finished: the admin declined a change in this turn. Handle that first.' };
        } else if (outcome === 'done') {
          const verdict = phase.check
            ? await DBOS.runStep(() => host.check(phase.check, { protocol, facts: { ...st.facts } }), { name: `check:${phase.check}` })
            : { ok: true };
          if (verdict.ok) {
            ps.status = 'done';
            next = true;
            response = { ok: true, note: i + 1 < def.phases.length ? 'Phase done. The next phase starts now.' : 'Last phase done.' };
          } else {
            response = { error: `Not done yet: ${verdict.reason}` };
            log({ kind: 'error', text: `Check "${phase.check}" failed: ${verdict.reason}` });
          }
        } else if (outcome === 'skipped' && phase.optional) {
          ps.status = 'skipped';
          next = true;
          response = { ok: true, note: 'Phase skipped.' };
        } else if (outcome === 'skipped') {
          response = { error: 'This phase is not optional and can\'t be skipped.' };
        } else {
          ps.status = 'blocked';
          blocked = true;
          response = { ok: true, note: 'The workflow now waits for the admin.' };
        }
        if (response.ok) {
          ps.summary = summary;
          log({ kind: 'phase', text: `${phase.title}: ${ps.status}${summary ? `. ${summary}` : ''}`, bad: ps.status === 'blocked' });
        }
        responses.push({ call: finish, response });
      }
      contents.push(assistant.functionResponses(responses));

      if (next) {
        ps.endedAt = await DBOS.now();
        break;
      }
      if (blocked) {
        const msg = await waitFor('waiting_input', ['message']);
        if (!msg) return expired();
        ps.status = 'active';
        takeMessage(msg);
      }
    }
  }

  st.phase = def.phases.length;
  pushUser('All phases are finished. Give the admin the final summary.');
  await think([], 'model:summary');
  await publish('done');
  return { status: 'done', phases: st.phases.map(({ id, status }) => ({ id, status })) };
}

const workflow = DBOS.registerWorkflow(registrationWorkflow, { name: WORKFLOW_NAME });

// Starts a run. The definition is copied into the run, so changing it later doesn't affect it.
export async function start({ protocol, referenceUrl, origin, message, definition = REGISTRATION }) {
  const problems = validate(definition);
  if (problems.length) throw new Error(`Invalid workflow definition: ${problems.join(' ')}`);
  const id = `reg-${protocol}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  await DBOS.startWorkflow(workflow, { workflowID: id, workflowAttributes: { kind: 'registration', protocol } })({ protocol, referenceUrl, origin, message, definition });
  return id;
}
