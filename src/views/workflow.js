// The Workflows pages. The list page answers, in order: what waits for me, what ran, and how each
// workflow works. A run's page opens with one sentence on where the run is, then what to do,
// its progress, the transcript, and the technical record last (see workflow/).
import { esc, icon, layout, pageHead, card, badge, code, kv, time, codeBlock, emptyState, none } from './ui.js';
import { transcript, decisionPanel } from './assistant.js';
import { CATALOG } from '../workflow/definitions.js';

const FINAL = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'];
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const PROTOCOL = { saml: 'SAML', oidc: 'OpenID Connect' };

// What a run is doing, from DBOS's status and the state the run published. [label, tone]
export function runLabel(run) {
  const st = run.state;
  switch (run.status) {
    case 'CANCELLED': return ['Stopped', 'bad'];
    case 'ERROR': return ['Failed', 'bad'];
    case 'MAX_RECOVERY_ATTEMPTS_EXCEEDED': return ['Failed', 'bad'];
    case 'SUCCESS': return st?.status === 'expired' ? ['Expired', 'warn'] : ['Done', 'ok'];
    case 'ENQUEUED': return ['Queued', ''];
    default: break;
  }
  return {
    waiting_approval: ['Needs your approval', 'warn'],
    waiting_input: ['Needs your answer', 'warn'],
    waiting_user: ['Waiting for the user', ''],
  }[st?.status] ?? ['Working', 'info'];
}
const statusBadge = (run) => {
  const [label, tone] = runLabel(run);
  return badge(`${tone === 'ok' ? icon('check') : `<span class="dot ${tone}"></span>`}${label}`, tone);
};

// A run's name, for people: what it is about. The id stays available, small, underneath.
export function runName(run) {
  const st = run.state;
  if (run.name === 'registration') return `${PROTOCOL[st?.protocol ?? run.attributes.protocol] ?? ''} registration`;
  const who = st?.user?.username ?? run.attributes.user;
  return who ? `Migration of ${who}` : 'User migration';
}

const PHASE_STATUS = {
  pending: ['Not started', ''],
  active: ['In progress', 'info'],
  done: ['Done', 'ok'],
  skipped: ['Skipped', ''],
  blocked: ['Needs you', 'warn'],
  failed: ['Did not happen', 'warn'],
};

const duration = (from, to) => {
  if (!from || !to) return '';
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 1) return 'under 1 s';
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};

// Where a run is, in one sentence, with what to do about it. { tone, iconName, title, text }
function headline(run, def) {
  const st = run.state;
  const n = st?.phases?.length ?? def.phases.length;
  const at = st && st.phase < n ? `step ${st.phase + 1} of ${n}, ${esc(st.phases[st.phase].title.toLowerCase())}` : '';
  const pendingTitle = st?.pending?.calls?.map((c) => c.title).join(', ');
  if (run.status === 'CANCELLED') return { tone: 'bad', iconName: 'x', title: 'Stopped', text: `Stopped at ${at || 'the start'}. <strong>Resume</strong> carries on from the last saved step; nothing done so far is repeated.` };
  if (run.status === 'ERROR' || run.status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED') return { tone: 'bad', iconName: 'bad', title: 'Failed', text: `${esc(run.error ?? 'The run hit an error.')} <strong>Resume</strong> tries again from the last saved step.` };
  if (run.status === 'SUCCESS' && st?.status === 'expired') return { tone: 'warn', iconName: 'warn', title: 'Expired', text: 'Nobody answered for 7 days, so the run stopped. Start a new conversation from the assistant to go on.' };
  if (run.status === 'SUCCESS') {
    if (def.id === 'registration') return { tone: 'ok', iconName: 'ok', title: 'Done', text: `All ${n} steps finished${run.completedAt ? ` in ${duration(run.createdAt, run.completedAt)}` : ''}. This app is registered and its settings are saved.` };
    const outcome = { migrated: 'They now sign in with Keycloak.', conflict: 'Another Keycloak account already uses their username or email: someone needs to link them in CloakTail.', not_migrated: 'They kept their old password this time and will be asked again.', rejected: 'The result failed verification, so nothing changed.', abandoned: 'They never came back, and CloakTail has no migration for them.' }[st?.outcome] ?? '';
    return { tone: st?.outcome === 'migrated' ? 'ok' : 'warn', iconName: st?.outcome === 'migrated' ? 'ok' : 'warn', title: `Outcome: ${esc((st?.outcome ?? 'done').replace(/_/g, ' '))}`, text: outcome };
  }
  if (st?.status === 'waiting_approval') return { tone: 'warn', iconName: 'warn', title: 'Waiting for your approval', text: `The assistant wants to make a change: <code>${esc(pendingTitle)}</code>. Nothing happens until you decide below.` };
  if (st?.status === 'waiting_input') return { tone: 'warn', iconName: 'warn', title: 'Waiting for your answer', text: 'The assistant asked you something; its question is the last message in the transcript. Answer below.' };
  if (st?.status === 'waiting_user') return { tone: 'info', iconName: 'users', title: 'Waiting for the user to come back from CloakTail', text: 'If they don\'t within 40 minutes, the app asks CloakTail whether the migration happened.' };
  return { tone: 'info', iconName: 'refresh', title: 'Working', text: `${at ? `On ${at}.` : 'Starting.'} This page updates by itself.` };
}

const banner = ({ tone, iconName, title, text }) => `<div class="wf-banner ${tone}" role="status">${icon(iconName)}<div><strong>${title}</strong><p>${text}</p></div></div>`;

// A definition, drawn as numbered phases: what each does in plain words, and what you approve or
// what gets checked. The agent's own instructions and tools fold away. With a run's state, each
// phase shows how far it got.
function phaseList(def, st) {
  return `<ol class="wf-phases">${def.phases.map((p, i) => {
    const ps = st?.phases?.[i];
    const [label, tone] = PHASE_STATUS[ps?.status] ?? [null, ''];
    const current = st && i === st.phase && ps?.status === 'active';
    const promises = [
      p.approval === 'changes' ? `<span class="wf-chip approve" title="${esc(CATALOG.approvals.changes)}">${icon('check')}Asks you before any change</span>` : '',
      p.approval === 'none' ? `<span class="wf-chip warn" title="${esc(CATALOG.approvals.none)}">Changes without asking</span>` : '',
      p.check ? `<span class="wf-chip check" title="${esc(CATALOG.checks[p.check])}">${icon('shield')}Checked: ${esc(CATALOG.checkLabels[p.check] ?? p.check)}</span>` : '',
      p.optional ? '<span class="wf-chip">Optional</span>' : '',
    ].filter(Boolean).join('');
    const tools = (p.tools ?? []).map((t) => `<span class="wf-chip" title="${esc(CATALOG.tools[t]?.description ?? '')}">${esc(CATALOG.tools[t]?.label ?? t)}</span>`).join('');
    const agent = p.summary && p.goal
      ? `<details class="wf-more"><summary>What the agent is told${tools ? ' and can use' : ''}</summary><p class="wf-goal">${esc(p.goal)}</p>${tools ? `<div class="wf-chips">${tools}</div>` : ''}</details>`
      : '';
    return `<li class="wf-phase ${esc(ps?.status ?? 'plan')}${current ? ' current' : ''}"${current ? ' aria-current="step"' : ''}>
      <span class="wf-num" aria-hidden="true">${ps?.status === 'done' ? icon('check') : ps?.status === 'skipped' ? '–' : i + 1}</span>
      <div class="wf-main">
        <div class="wf-title"><strong>${esc(p.title)}</strong>${label ? ` ${badge(label, tone)}` : ''}
          ${ps?.startedAt ? `<span class="small muted">${ps.endedAt ? duration(ps.startedAt, ps.endedAt) : `started ${time(iso(ps.startedAt))}`}</span>` : ''}</div>
        ${ps?.summary ? `<p class="wf-summary">${esc(ps.summary)}</p>` : ''}
        <p class="wf-goal">${esc(p.summary ?? p.goal)}</p>
        ${promises ? `<div class="wf-chips">${promises}</div>` : ''}
        ${agent}
      </div></li>`;
  }).join('')}</ol>`;
}

const progress = (st) => {
  if (!st?.phases?.length) return none('—');
  const done = st.phases.filter((p) => ['done', 'skipped'].includes(p.status)).length;
  const pct = Math.round((done / st.phases.length) * 100);
  return `<span class="wf-progress"><span class="wf-bar" role="img" aria-label="${done} of ${st.phases.length} steps done"><span style="width:${pct}%"></span></span>${done} of ${st.phases.length}</span>`;
};

function runsTable(def, runs) {
  if (!runs.length) {
    return emptyState('sliders', 'No runs yet', def.id === 'registration'
      ? 'Start one with the assistant on the <a href="/admin/saml#assistant">SAML</a> or <a href="/admin/oidc#assistant">OpenID Connect</a> page.'
      : 'A run starts each time a legacy user is sent to CloakTail to migrate, or with "Simulate result" on the <a href="/admin/migrate#test">Migration</a> page.');
  }
  const registration = def.id === 'registration';
  const rows = runs.map((r) => {
    const st = r.state;
    const extra = registration
      ? (st ? `<span class="small muted">${st.metrics.modelCalls} model calls · ${(st.metrics.inputTokens + st.metrics.outputTokens).toLocaleString('en')} tokens</span>` : none('—'))
      : (st?.outcome ? badge(esc(st.outcome.replace(/_/g, ' ')), { migrated: 'ok', conflict: 'warn', rejected: 'bad', abandoned: 'warn' }[st.outcome] ?? '') : none('—'));
    return `<tr>
      <td><a class="wf-run-name" href="/admin/workflows/${esc(r.id)}">${esc(runName(r))}</a><span class="wf-run-id">${esc(r.id)}</span></td>
      <td>${statusBadge(r)}</td>
      <td>${progress(st)}</td>
      <td>${extra}</td>
      <td>${time(iso(r.createdAt))}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Run</th><th>Status</th><th>Progress</th><th>${registration ? 'Cost' : 'Outcome'}</th><th>Started</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// The next step, described: changing the workflow by saying what to change. Not built yet.
const comingNext = () => `<div class="wf-soon">${icon('sparkle')}<div><strong>Coming next: change this workflow by describing it</strong>
  <p>Say "skip user migration" or "ask me before every request", review the new version, and approve it. Runs already started keep the version they began with.</p></div></div>`;

function engineAlert(engine) {
  const detail = engine.detail ? `<details class="wf-tech"><summary>Technical details</summary><pre>${esc(engine.detail)}</pre></details>` : '';
  return `<div class="alert ${engine.setup ? 'info' : 'warn'}" role="status">${icon(engine.setup ? 'info' : 'warn')}
    <div><strong>${engine.setup ? 'Workflows aren\'t set up' : 'Workflows are paused'}</strong><p>${esc(engine.reason)}</p>
    <p class="small muted">Until then the AI assistant is off, and user migrations work without being tracked here.</p>${detail}</div></div>`;
}

export function workflowsPage(data) {
  const { engine, definitions, runs, attention = [] } = data;
  const todo = attention.length
    ? card({
      id: 'attention',
      title: `Waiting for you ${badge(String(attention.length), 'warn')}`,
      description: 'Runs paused until you answer. They wait as long as needed, even across restarts (up to 7 days).',
      body: `<ul class="wf-todo">${attention.map((r) => {
        const [label] = runLabel(r);
        const what = r.state.status === 'waiting_approval'
          ? `Approve or decline: <code>${esc(r.state.pending?.calls?.map((c) => c.title).join(', '))}</code>`
          : 'The assistant asked you a question.';
        return `<li><div><strong>${esc(runName(r))} · ${esc(label.toLowerCase())}</strong><span>${what}</span></div>
          <a class="btn primary sm" href="/admin/workflows/${esc(r.id)}">Review${icon('arrow')}</a></li>`;
      }).join('')}</ul>`,
    })
    : '';

  const cards = definitions.map((def) => card({
    id: def.id,
    iconHtml: `<span class="proto-icon ${def.id === 'registration' ? 'oidc' : 'saml'}">${icon(def.id === 'registration' ? 'sparkle' : 'migrate')}</span>`,
    title: esc(def.title),
    description: esc(def.description),
    body: `${engine.ok ? runsTable(def, runs[def.id] ?? []) : ''}
      <details class="wf-howto"${engine.ok && (runs[def.id] ?? []).length ? '' : ' open'}>
        <summary>How it works: ${def.phases.length} steps ${badge(`v${def.version}`, 'outline')}</summary>
        ${phaseList(def)}
        ${def.id === 'registration' ? `${comingNext()}
        <details class="wf-json"><summary>Definition (JSON)</summary>${codeBlock('Workflow definition', JSON.stringify(def, null, 2))}</details>` : ''}
      </details>`,
  }));

  const about = engine.ok
    ? `<details class="wf-tech"><summary>About the engine</summary>${kv([['Engine', 'DBOS: durable workflows on Postgres'], ['Database', code(engine.database)], ['Version', `${code(engine.version)} <span class="small muted">a run resumes only on the version it started on</span>`]])}</details>`
    : '';
  return layout({
    ...data,
    title: 'Workflows',
    body: `
      ${pageHead('Workflows', 'Work that runs in the background, step by step. Every step is saved, so a run survives restarts and can wait for you.')}
      <div class="stack-lg">
        ${engine.ok ? '' : engineAlert(engine)}
        ${todo}
        ${cards.join('')}
        ${about}
      </div>`,
  });
}

const INTERNAL = ['DBOS.now', 'DBOS.setEvent', 'DBOS.sleep', 'DBOS.getEvent'];

// A saved step's name, readable: model:<phase>, tool:<name>, check:<name>, recover:..., DBOS.recv.
function stepName(name) {
  if (name === 'DBOS.recv') return '<span class="muted">Waited for an answer</span>';
  const [kind, what] = name.split(/:(.*)/);
  const label = { model: 'Model turn', tool: 'Tool', check: 'Check', recover: 'Recovery' }[kind];
  if (!label || !what) return `<code>${esc(name)}</code>`;
  const shown = kind === 'tool' ? CATALOG.tools[what]?.label ?? what : what.replace(/_/g, ' ');
  return `${label} <code>${esc(shown)}</code>`;
}

export function runPage(data) {
  const { run, definition: def } = data;
  const st = run.state;
  const registration = def.id === 'registration';
  const final = FINAL.includes(run.status);
  const actions = [
    registration && st ? `<a class="btn" href="/admin/${st.protocol === 'oidc' ? 'oidc' : 'saml'}#assistant">${icon('sparkle')}Open in the assistant</a>` : '',
    ['CANCELLED', 'ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(run.status) ? `<form class="inline" method="post" action="/admin/workflows/${esc(run.id)}/resume" data-busy="Resuming…"><button class="btn primary">${icon('play')}Resume</button></form>` : '',
    !final ? `<form class="inline" method="post" action="/admin/workflows/${esc(run.id)}/cancel" data-confirm="Stop this run? Its saved steps are kept, and Resume carries on from the last one."><button class="btn ghost">${icon('x')}Stop run</button></form>` : '',
  ].join('');

  let respond = '';
  if (!final && st?.status === 'waiting_approval' && st.pending) {
    respond = card({ id: 'respond', title: 'Your decision', body: `<div class="cc-window">${transcript([], st.pending)}${decisionPanel(st.pending, `/admin/workflows/${esc(run.id)}/decide`, { chat: false })}</div>` });
  } else if (!final && registration && st?.status === 'waiting_input') {
    const question = [...(st.log ?? [])].reverse().find((e) => e.kind === 'assistant');
    respond = card({
      id: 'respond',
      title: 'Your answer',
      body: `<div class="cc-window">${question ? transcript([question], null) : ''}<form method="post" action="/admin/workflows/${esc(run.id)}/message" class="cc-composer" data-busy="Sending…">
        <label class="sr-only" for="f-message">Your answer</label>
        <div class="cc-input"><span class="cc-mark" aria-hidden="true">›</span><textarea id="f-message" name="message" rows="2" data-enter-submits placeholder="Answer the assistant…"></textarea></div>
        <div class="cc-actions"><span class="small muted">Enter to send · Shift+Enter for a new line</span><button class="btn primary sm" data-needs-text>${icon('arrow')}Send</button></div></form></div>`,
    });
  }

  const details = kv([
    ['Status', statusBadge(run)],
    registration ? ['Protocol', PROTOCOL[st?.protocol] ?? none()] : ['User', st?.user ? `${esc(st.user.username)} <span class="small muted">id ${esc(st.user.id)}</span>` : none()],
    ['Started', time(iso(run.createdAt))],
    run.completedAt ? ['Took', duration(run.createdAt, run.completedAt)] : ['Last change', time(iso(st?.updatedAt ?? run.updatedAt))],
    registration && st ? ['Cost', `${st.metrics.modelCalls} model calls, ${(st.metrics.inputTokens + st.metrics.outputTokens).toLocaleString('en')} tokens <span class="small muted">(${st.metrics.inputTokens.toLocaleString('en')} in, ${st.metrics.outputTokens.toLocaleString('en')} out)</span>`] : null,
    registration && st ? ['Your decisions', `${st.metrics.approvals} approved, ${st.metrics.declines} declined`] : null,
    run.recoveryAttempts > 1 ? ['Restarts survived', `${run.recoveryAttempts - 1}, resumed from the last saved step each time`] : null,
    registration && st ? ['CloakTail reference', code(st.referenceUrl)] : null,
    ['Workflow', `${esc(def.title)} ${badge(`v${st?.definition?.version ?? def.version}`, 'outline')}`],
    ['Run id', code(run.id)],
  ]);

  const shown = run.steps.filter((s) => !INTERNAL.includes(s.name));
  const hidden = run.steps.length - shown.length;
  const steps = shown.length ? `<div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Step</th><th>Took</th><th></th></tr></thead>
    <tbody>${shown.map((s) => `<tr><td>${s.id}</td><td>${stepName(s.name)}</td><td>${duration(s.startedAt, s.completedAt) || none('—')}</td><td>${s.error ? `<span class="error">${esc(s.error)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>
    ${hidden ? `<p class="small muted">Plus ${hidden} bookkeeping record${hidden === 1 ? '' : 's'} (clock reads, published state, timers), saved so a replay takes the same path.</p>` : ''}`
    : none('No steps yet');

  const polling = !final && (!st || st.status === 'running');
  return layout({
    ...data,
    path: '/admin/workflows',
    title: runName(run),
    body: `
      <p class="small"><a href="/admin/workflows">${icon('back')}All workflows</a></p>
      ${pageHead(`${esc(runName(run))} ${statusBadge(run)}`, `${esc(def.title)} · started ${time(iso(run.createdAt))}`, actions)}
      <div class="stack-lg"${polling ? ' data-poll' : ''}>
        ${banner(headline(run, def))}
        ${respond}
        ${card({ title: 'Progress', description: registration ? 'Each step has its own goal; code checks the result before the next one starts.' : null, body: phaseList(def, st) })}
        ${st?.log?.length ? card({ title: registration ? 'Conversation' : 'What happened', body: `<div class="cc-window">${transcript(st.log, null)}</div>` }) : ''}
        ${card({ title: 'Details', body: `${details}
          <details class="wf-tech" style="margin-top:14px"><summary>Saved steps (${shown.length})</summary>
            <p class="small muted">What the engine saved in Postgres. After a restart these replay from the database instead of running again: no second model call, no second request to CloakTail.</p>${steps}</details>` })}
      </div>`,
  });
}
