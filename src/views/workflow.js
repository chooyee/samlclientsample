// The Workflows pages: each workflow's definition drawn as its phases, its runs, and one run's
// progress, transcript and saved DBOS steps (see workflow/).
import { esc, icon, layout, alert, pageHead, card, badge, code, kv, time, codeBlock, emptyState, none } from './ui.js';
import { transcript, decisionPanel } from './assistant.js';
import { CATALOG } from '../workflow/definitions.js';

const FINAL = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'];
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

// What a run is doing, from DBOS's status and the state the run published. [label, tone]
export function runLabel(run) {
  const st = run.state;
  switch (run.status) {
    case 'CANCELLED': return ['Stopped', 'bad'];
    case 'ERROR': return ['Failed', 'bad'];
    case 'MAX_RECOVERY_ATTEMPTS_EXCEEDED': return ['Failed to recover', 'bad'];
    case 'SUCCESS': return st?.status === 'expired' ? ['Expired', 'warn'] : ['Done', 'ok'];
    case 'ENQUEUED': return ['Queued', ''];
    default: break;
  }
  return {
    waiting_approval: ['Waiting for approval', 'warn'],
    waiting_input: ['Waiting for you', 'warn'],
    waiting_user: ['Waiting for the user', ''],
  }[st?.status] ?? ['Working', ''];
}
const statusBadge = (run) => {
  const [label, tone] = runLabel(run);
  return badge(`${tone === 'ok' ? '' : '<span class="dot ' + (tone || '') + '"></span>'}${label}`, tone);
};

const PHASE_STATUS = {
  pending: ['Not started', ''],
  active: ['In progress', 'info'],
  done: ['Done', 'ok'],
  skipped: ['Skipped', ''],
  blocked: ['Needs you', 'warn'],
  failed: ['Did not happen', 'bad'],
};

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

const duration = (from, to) => {
  if (!from || !to) return '';
  const s = Math.max(0, Math.round((to - from) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};

// A definition, drawn as numbered phases. With a run's state, each phase shows how far it got.
function phaseList(def, st) {
  return `<ol class="wf-phases">${def.phases.map((p, i) => {
    const ps = st?.phases?.[i];
    const [label, tone] = PHASE_STATUS[ps?.status] ?? [null, ''];
    const current = st && i === st.phase && ps?.status === 'active';
    const chips = [
      ...(p.tools ?? []).map((t) => `<span class="wf-chip" title="${esc(CATALOG.tools[t]?.description ?? '')}">${esc(CATALOG.tools[t]?.label ?? t)}</span>`),
      p.approval === 'changes' ? `<span class="wf-chip approve" title="${esc(CATALOG.approvals.changes)}">${icon('check')}You approve changes</span>` : '',
      p.approval === 'none' ? `<span class="wf-chip warn" title="${esc(CATALOG.approvals.none)}">Changes without asking</span>` : '',
      p.check ? `<span class="wf-chip check" title="${esc(CATALOG.checks[p.check])}">${icon('shield')}Check: ${esc(p.check.replace(/_/g, ' '))}</span>` : '',
      p.optional ? '<span class="wf-chip">Optional</span>' : '',
    ].filter(Boolean).join('');
    return `<li class="wf-phase ${esc(ps?.status ?? 'plan')}${current ? ' current' : ''}">
      <span class="wf-num" aria-hidden="true">${ps?.status === 'done' ? icon('check') : ps?.status === 'skipped' ? '–' : i + 1}</span>
      <div class="wf-main">
        <div class="wf-title"><strong>${esc(p.title)}</strong>${label ? ` ${badge(label, tone)}` : ''}
          ${ps?.startedAt ? `<span class="small muted">${ps.endedAt ? duration(ps.startedAt, ps.endedAt) : `started ${time(iso(ps.startedAt))}`}</span>` : ''}</div>
        ${ps?.summary ? `<p class="wf-summary">${esc(ps.summary)}</p>` : ''}
        <p class="wf-goal">${esc(p.goal)}</p>
        ${chips ? `<div class="wf-chips">${chips}</div>` : ''}
      </div></li>`;
  }).join('')}</ol>`;
}

function runsTable(def, runs) {
  if (!runs.length) {
    return emptyState('sliders', 'No runs yet', def.id === 'registration'
      ? 'Start one from the assistant on the <a href="/admin/saml#assistant">SAML</a> or <a href="/admin/oidc#assistant">OpenID Connect</a> page.'
      : 'A run starts each time a legacy user is sent to CloakTail to migrate, or on "Simulate" on the <a href="/admin/migrate#test">Migration</a> page.');
  }
  const registration = def.id === 'registration';
  const rows = runs.map((r) => {
    const st = r.state;
    const done = st?.phases?.filter((p) => ['done', 'skipped'].includes(p.status)).length ?? 0;
    const who = registration
      ? badge(r.attributes.protocol === 'oidc' ? 'OpenID Connect' : 'SAML', r.attributes.protocol === 'oidc' ? 'oidc' : 'saml')
      : esc(st?.user?.username ?? r.attributes.user ?? '');
    const detail = registration
      ? (st ? `${st.metrics.modelCalls} model calls · ${(st.metrics.inputTokens + st.metrics.outputTokens).toLocaleString('en')} tokens` : none('—'))
      : (st?.outcome ? badge(esc(st.outcome.replace(/_/g, ' ')), { migrated: 'ok', conflict: 'warn', rejected: 'bad', abandoned: 'warn' }[st.outcome] ?? '') : none('—'));
    return `<tr>
      <td><a href="/admin/workflows/${esc(r.id)}"><code>${esc(r.id)}</code></a></td>
      <td>${who}</td>
      <td>${statusBadge(r)}</td>
      <td>${st ? `${done} of ${st.phases.length}` : none('—')}</td>
      <td>${detail}</td>
      <td>${time(iso(r.createdAt))}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Run</th><th>${registration ? 'Protocol' : 'User'}</th><th>Status</th><th>Phases</th><th>${registration ? 'Cost' : 'Outcome'}</th><th>Started</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// Next step: change the workflow by describing it. Shown, not wired yet.
const changeByPrompt = () => `<div class="wf-next">
  <div class="row" style="justify-content:space-between"><strong>${icon('sparkle')}Change this workflow by describing it</strong>${badge('Next phase', 'outline')}</div>
  <p class="small muted">For example: "Skip user migration", "Ask me before reading anything", or "Check the migration twice". An AI will edit the definition below, the app will check it against the catalog of tools and checks, and you'll approve the new version. Runs already started keep the version they began with.</p>
  <label class="sr-only" for="f-change">Describe the change</label>
  <textarea id="f-change" class="input" rows="2" disabled placeholder="Coming next: describe the change you want…"></textarea>
</div>`;

export function workflowsPage(data) {
  const { engine, definitions, runs } = data;
  const engineInfo = engine.ok
    ? kv([['Engine', 'DBOS, durable workflows on Postgres'], ['Database', code(engine.database)], ['Version', `${code(engine.version)} <span class="small muted">runs resume only on the version they started on</span>`]])
    : alert('warn', 'Workflows are off', [esc(engine.reason), 'Without them the registration assistant is off, and user migration works without tracking.']);
  const cards = definitions.map((def) => card({
    id: def.id,
    iconHtml: `<span class="proto-icon ${def.id === 'registration' ? 'oidc' : 'saml'}">${icon(def.id === 'registration' ? 'sparkle' : 'migrate')}</span>`,
    title: `${esc(def.title)} ${badge(`v${def.version}`, 'outline')}`,
    description: esc(def.description),
    body: `${phaseList(def)}
      ${def.id === 'registration' ? `${changeByPrompt()}
      <details class="wf-json"><summary>Definition (JSON)</summary>${codeBlock('Workflow definition', JSON.stringify(def, null, 2))}</details>` : ''}
      <h3 class="wf-h3">Recent runs</h3>
      ${engine.ok ? runsTable(def, runs[def.id] ?? []) : none('Workflows are off')}`,
  }));
  return layout({
    ...data,
    title: 'Workflows',
    body: `
      ${pageHead('Workflows', 'What runs in the background, step by step. Each step is saved in Postgres, so a run survives restarts and can wait days for an approval.')}
      <div class="stack-lg">
        ${card({ title: 'Engine', body: engineInfo })}
        ${cards.join('')}
      </div>`,
  });
}

export function runPage(data) {
  const { run, definition: def } = data;
  const st = run.state;
  const registration = def.id === 'registration';
  const final = FINAL.includes(run.status);
  const actions = [
    !final ? `<form class="inline" method="post" action="/admin/workflows/${esc(run.id)}/cancel" data-confirm="Stop this run? Its saved steps are kept; Resume carries on from the last one."><button class="btn">${icon('x')}Stop</button></form>` : '',
    ['CANCELLED', 'ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(run.status) ? `<form class="inline" method="post" action="/admin/workflows/${esc(run.id)}/resume"><button class="btn primary">${icon('play')}Resume</button></form>` : '',
    registration && st ? `<a class="btn" href="/admin/${st.protocol === 'oidc' ? 'oidc' : 'saml'}#assistant">${icon('arrow')}Open the assistant</a>` : '',
  ].join('');

  let waiting = '';
  if (!final && st?.status === 'waiting_approval' && st.pending) {
    waiting = card({ id: 'waiting', title: 'Waiting for your approval', body: `<div class="cc-window">${transcript([], st.pending)}${decisionPanel(st.pending, `/admin/workflows/${esc(run.id)}/decide`, { chat: false })}</div>` });
  } else if (!final && registration && st?.status === 'waiting_input') {
    waiting = card({
      id: 'waiting',
      title: 'Waiting for you',
      body: `<div class="cc-window"><form method="post" action="/admin/workflows/${esc(run.id)}/message" class="cc-composer" data-busy="Thinking…">
        <label class="sr-only" for="f-message">Message</label>
        <div class="cc-input"><span class="cc-mark" aria-hidden="true">›</span><textarea id="f-message" name="message" rows="2" data-enter-submits placeholder="Answer the assistant…"></textarea></div>
        <div class="cc-actions"><span class="small muted">Enter to send</span><button class="btn primary sm" data-needs-text>${icon('arrow')}Send</button></div></form></div>`,
    });
  }

  const metrics = registration && st ? kv([
    ['Model calls', `${st.metrics.modelCalls} <span class="small muted">(${st.metrics.inputTokens.toLocaleString('en')} tokens in, ${st.metrics.outputTokens.toLocaleString('en')} out)</span>`],
    ['Tool calls', String(st.metrics.toolCalls)],
    ['Approvals', `${st.metrics.approvals} approved, ${st.metrics.declines} declined`],
    ['Reference', code(st.referenceUrl)],
  ]) : '';
  const facts = kv([
    ['Status', `${statusBadge(run)} <span class="small muted">DBOS: ${esc(run.status)}</span>`],
    registration ? ['Protocol', st?.protocol === 'oidc' ? 'OpenID Connect' : 'SAML 2.0'] : ['User', st?.user ? `${esc(st.user.username)} <span class="small muted">${esc(st.user.id)}</span>` : none()],
    !registration && st?.outcome ? ['Outcome', esc(st.outcome.replace(/_/g, ' '))] : null,
    ['Started', time(iso(run.createdAt))],
    ['Last change', time(iso(st?.updatedAt ?? run.updatedAt))],
    run.completedAt ? ['Took', duration(run.createdAt, run.completedAt)] : null,
    ['Definition', `${esc(def.title)} ${badge(`v${st?.definition?.version ?? def.version}`, 'outline')}`],
    run.recoveryAttempts > 1 ? ['Recovered', `${run.recoveryAttempts - 1} time(s) after a restart`] : null,
    run.error ? ['Error', `<span class="error">${esc(run.error)}</span>`] : null,
  ]);

  // DBOS also saves its own bookkeeping (the clock, published state, timers): counted, not listed.
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
    title: `Run ${run.id}`,
    body: `
      ${pageHead(`${esc(def.title)}`, `Run <code>${esc(run.id)}</code>`, actions)}
      <div class="stack-lg"${polling ? ' data-poll' : ''}>
        ${waiting}
        ${card({ title: 'Run', body: `${facts}${metrics ? `<hr class="divider">${metrics}` : ''}` })}
        ${card({ title: 'Phases', description: 'The definition this run follows, and how far each phase got.', body: phaseList(def, st) })}
        ${st?.log?.length ? card({ title: registration ? 'Transcript' : 'Events', body: `<div class="cc-window">${transcript(st.log, null)}</div>` }) : ''}
        ${card({ title: 'Saved steps', description: 'What DBOS saved in Postgres. After a restart these replay from the database instead of running again: no second model call, no second request to CloakTail.', body: steps })}
      </div>`,
  });
}
