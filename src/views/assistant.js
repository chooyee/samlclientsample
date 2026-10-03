// The registration assistant card on the SAML and OIDC pages (see assistant.js).
import { esc, icon, alert, card, code, badge, field, time, codeBlock } from './ui.js';
import { markdown } from './markdown.js';

const LABEL = { saml: 'SAML 2.0', oidc: 'OpenID Connect' };

function connectForm(a, draft) {
  const fromDraft = draft?.section === 'assistant';
  const values = fromDraft ? draft.values : {};
  const errors = (fromDraft && draft.errors) || {};
  return `<form method="post" action="/assistant/${a.protocol}/connect" novalidate data-chat data-busy="Connecting…">
    ${Object.keys(errors).length ? alert('bad', 'Not connected to CloakTail', ['Check the highlighted fields.'], { cls: 'flash' }) : ''}
    <div class="fields">
      ${field({ name: 'referenceUrl', label: 'CloakTail reference URL', type: 'url', value: values.referenceUrl ?? a.defaultReferenceUrl, error: errors.referenceUrl, required: true, mono: true,
        hint: 'The CloakTail API guide or spec the agent works from, e.g. its agent guide or OpenAPI document. The agent learns the token endpoint, paths and fields from it, and can only call that server.' })}
      ${field({ name: 'clientId', label: 'API client ID', value: values.clientId, error: errors.clientId, required: true, mono: true,
        hint: 'From CloakTail\'s API credentials page.' })}
      ${field({ name: 'clientSecret', label: 'API client secret', type: 'password', value: '', error: errors.clientSecret, required: true, mono: true,
        hint: 'Kept in this browser session\'s server memory only: never saved, logged or shown to the AI model.',
        after: `<button type="button" class="btn" data-reveal="f-clientSecret" aria-pressed="false" aria-label="Show secret">${icon('eye')}</button>` })}
    </div>
    <div class="row" style="margin-top:16px"><button class="btn primary">${icon('login')}Connect</button></div>
  </form>`;
}

// Tool names as the transcript shows them, Claude Code style.
const TOOL_LABEL = {
  fetch_reference: 'Fetch',
  get_access_token: 'GetToken',
  http_request: 'Request',
  get_this_app: 'ReadApp',
  update_this_app_settings: 'SaveSettings',
  check_user_migration: 'CheckMigration',
};

// A thought summary usually opens with a bold title line; it labels the collapsed block.
function splitThought(text) {
  const m = text.match(/^\s*\*\*(.+?)\*\*\s*\n?/);
  return m ? { title: m[1], body: text.slice(m[0].length) } : { title: 'Thinking', body: text };
}

function entry(e) {
  switch (e.kind) {
    case 'user':
      return `<li class="cc-user"><span class="cc-mark" aria-hidden="true">›</span><div class="cc-body">${esc(e.text)}</div></li>`;
    case 'assistant':
      return `<li class="cc-reply"><span class="cc-mark" aria-hidden="true">●</span><div class="cc-body md">${markdown(e.text)}</div></li>`;
    case 'thinking': {
      const { title, body } = splitThought(e.text);
      return `<li class="cc-thinking"><span class="cc-mark" aria-hidden="true">✻</span><details class="cc-body">
        <summary>${esc(title)}</summary><div class="md">${markdown(body)}</div></details></li>`;
    }
    case 'tool': {
      // Entries logged before tool rows had a name carry only text.
      const call = e.name ? `<strong>${esc(TOOL_LABEL[e.name] ?? e.name)}</strong>(${esc(e.target ?? '')})` : esc(e.text);
      return `<li class="cc-tool${e.bad ? ' bad' : ''}"><span class="cc-mark" aria-hidden="true">●</span><div class="cc-body">
        <div class="cc-call">${call}</div>${e.name ? `<div class="cc-result"><span aria-hidden="true">⎿</span>${esc(e.text)}</div>` : ''}</div></li>`;
    }
    case 'approval':
      return `<li class="cc-tool${e.bad ? ' bad' : ''}"><span class="cc-mark" aria-hidden="true">${e.bad ? '✕' : '✓'}</span><div class="cc-body"><div class="cc-call">${esc(e.text)}</div></div></li>`;
    default:
      return `<li class="cc-tool bad"><span class="cc-mark" aria-hidden="true">!</span><div class="cc-body"><div class="cc-call">${esc(e.text)}</div></div></li>`;
  }
}

// A change waiting for the admin: the call and what it sends, as the last transcript entry.
// The decision itself is asked where the composer is (see decisionPanel), as Claude Code does.
function pendingEntry(a) {
  const { pending } = a.conversation;
  if (!pending) return '';
  return pending.calls.map((c) => {
    const target = c.name === 'http_request' ? c.title : Object.keys(c.args ?? {}).join(', ');
    return `<li class="cc-ask"><span class="cc-mark" aria-hidden="true">●</span><div class="cc-body">
      <div class="cc-call"><strong>${esc(TOOL_LABEL[c.name] ?? c.name)}</strong>(${esc(target)})</div>
      ${c.detail ? codeBlock(c.name === 'http_request' ? 'Request body' : 'New values for this app', c.detail, { copy: false }) : ''}
      <div class="cc-result"><span aria-hidden="true">⎿</span>Waiting for your approval</div></div></li>`;
  }).join('');
}

const PRESET = (protocol) => `Register this app in CloakTail as a ${LABEL[protocol]} application, fill this app's settings from the result, then set up and check user migration.`;

const textBox = (placeholder) => `<label class="sr-only" for="f-message">Message</label>
  <div class="cc-input"><span class="cc-mark" aria-hidden="true">›</span>
    <textarea id="f-message" name="message" rows="2" data-enter-submits placeholder="${esc(placeholder)}"></textarea></div>`;

// Replaces the composer while a change waits. Typing an answer declines and tells the agent what
// to do instead.
function decisionPanel(a) {
  const many = a.conversation.pending.calls.length > 1;
  return `<form method="post" action="/assistant/${a.protocol}/decide" class="cc-composer cc-decide" data-chat data-busy="Working…">
    <div class="cc-decide-head">
      <span><strong>${many ? 'Make these changes?' : 'Make this change?'}</strong>
        <span class="small muted">Nothing is sent or saved until you approve.</span></span>
      <span class="row">
        <button class="btn primary sm" name="decision" value="approve">${icon('check')}Approve</button>
        <button class="btn sm" name="decision" value="decline">${icon('x')}Decline</button>
      </span>
    </div>
    ${textBox('Or decline and tell the assistant what to do instead…')}
    <div class="cc-actions"><span class="small muted">Enter declines and sends your instructions.</span></div>
  </form>`;
}

function composer(a) {
  const { conversation: c, protocol } = a;
  if (c.pending) return decisionPanel(a);
  return `<form method="post" action="/assistant/${protocol}/message" class="cc-composer" data-chat data-busy="Thinking…">
      ${textBox('e.g. Register this app as "Acme Bank (test)"')}
      <div class="cc-actions">
        <span class="small muted">Enter to send · Shift+Enter for a new line</span>
        <span class="row">
          ${c.log.length ? '' : `<button class="btn sm" name="preset" value="${esc(PRESET(protocol))}">${icon('play')}Register this app</button>`}
          <button class="btn primary sm" data-needs-text>${icon('arrow')}Send</button>
        </span>
      </div></form>`;
}

// One chat window: connection bar, transcript (with any pending change last), composer.
function chatWindow(a) {
  const { connection: conn, conversation: c, protocol } = a;
  const token = conn.token
    ? `<span${conn.token.scope ? ` title="Scopes: ${esc(conn.token.scope)}"` : ''}>${badge('Token obtained', 'ok')}</span>${conn.token.expiresAt ? ` <span class="small">expires ${time(new Date(conn.token.expiresAt).toISOString())}</span>` : ''}`
    : `<span title="The agent gets one as the reference describes.">${badge('No token yet')}</span>`;
  const log = c.log.length || c.pending
    ? `<ol class="cc-log" aria-live="polite">${c.log.map(entry).join('')}${pendingEntry(a)}</ol>`
    : `<div class="cc-log cc-empty"><p>Ask it to register this app, or to check an existing registration. It reads the reference first, asks you before each change, then fills the settings below.</p></div>`;
  return `<div class="cc-window">
    <div class="cc-head">
      <span class="cc-status-info"><span class="dot ok" aria-hidden="true"></span>Connected as ${code(conn.clientId)} to
        <a href="${esc(conn.referenceUrl)}" target="_blank" rel="noopener"><code>${esc(conn.referenceUrl)}</code>${icon('external')}</a> ${token}</span>
      <span class="row">
        ${c.log.length ? `<form class="inline" method="post" action="/assistant/${protocol}/reset" data-chat><button class="btn ghost sm">${icon('refresh')}New conversation</button></form>` : ''}
        <form class="inline" method="post" action="/assistant/${protocol}/disconnect" data-chat data-confirm="Disconnect from CloakTail? The credential and both conversations are forgotten."><button class="btn ghost sm">${icon('logout')}Disconnect</button></form>
      </span>
    </div>
    ${log}
    ${composer(a)}
  </div>`;
}

export function assistantCard(a, draft) {
  const description = `Does steps 2 to 4 for you, then sets up <a href="/admin/migrate">user migration</a>: an AI agent (Google Gemini, <code>${esc(a.model)}</code>) registers this app in CloakTail as a ${LABEL[a.protocol]} application, using only the CloakTail API reference you give it, and fills this app's settings. You approve every change. Or skip it and follow the steps by hand.`;
  let body;
  if (!a.enabled) {
    body = alert('info', 'The assistant is off', ['Set <code>GEMINI_API_KEY</code> and <code>GEMINI_MODEL</code> in <code>.env</code> and restart to turn it on.']);
  } else if (!a.connection) {
    body = connectForm(a, draft);
  } else {
    body = chatWindow(a);
  }
  return card({
    id: 'assistant',
    iconHtml: `<span class="proto-icon ${a.protocol}">${icon('sparkle')}</span>`,
    title: `Shortcut: register with the AI assistant ${badge('Optional')}`,
    description,
    body,
  });
}
