// The registration assistant card on the SAML and OIDC pages (see assistant.js).
import { esc, icon, alert, card, kv, code, badge, field, time, codeBlock } from './ui.js';

const LABEL = { saml: 'SAML 2.0', oidc: 'OpenID Connect' };

function connectForm(a, draft) {
  const fromDraft = draft?.section === 'assistant';
  const values = fromDraft ? draft.values : {};
  const errors = (fromDraft && draft.errors) || {};
  return `<form method="post" action="/assistant/${a.protocol}/connect" novalidate data-busy="Connecting…">
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

function entry(e) {
  if (e.kind === 'user') return `<li class="msg user"><span class="who">You</span><div class="text">${esc(e.text)}</div></li>`;
  if (e.kind === 'assistant') return `<li class="msg assistant"><span class="who">Assistant</span><div class="text">${esc(e.text)}</div></li>`;
  if (e.kind === 'error') return `<li class="msg note bad">${icon('bad')}<span>${esc(e.text)}</span></li>`;
  return `<li class="msg note${e.bad ? ' bad' : ''}">${icon(e.kind === 'approval' ? (e.bad ? 'x' : 'check') : 'arrow')}<span>${esc(e.text)}</span></li>`;
}

function pendingBlock(a) {
  const { pending } = a.conversation;
  if (!pending) return '';
  const calls = pending.calls.map((c) => `<div class="pending-call"><strong><code>${esc(c.title)}</code></strong>
    ${c.detail ? codeBlock(c.name === 'http_request' ? 'Request body' : 'Values', c.detail, { copy: false }) : ''}</div>`).join('');
  return `<div class="pending">
    ${alert('warn', pending.calls.length > 1 ? 'The assistant wants to make these changes' : 'The assistant wants to make this change', ['Nothing is sent or saved until you approve.'])}
    ${calls}
    <form method="post" action="/assistant/${a.protocol}/decide" class="row" data-busy="Working…">
      <button class="btn primary" name="decision" value="approve">${icon('check')}Approve</button>
      <button class="btn" name="decision" value="decline">${icon('x')}Decline</button>
    </form></div>`;
}

function chat(a) {
  const { conversation: c, protocol } = a;
  const log = c.log.length
    ? `<ol class="chat" aria-live="polite">${c.log.map(entry).join('')}</ol>`
    : `<p class="muted">Ask it to register this app, or to check an existing registration. It reads the reference first, shows each change for approval, then fills the settings below.</p>`;
  const start = `Register this app in CloakTail as a ${LABEL[protocol]} application, then fill this app's settings from the result.`;
  const composer = c.pending ? '' : `<form method="post" action="/assistant/${protocol}/message" class="stack" data-busy="Thinking…">
      ${field({ name: 'message', label: 'Message', textarea: true, placeholder: 'e.g. Register this app as "Acme Bank (test)"' })}
      <div class="row">
        <button class="btn primary">${icon('arrow')}Send</button>
        ${c.log.length ? '' : `<button class="btn" name="preset" value="${esc(start)}">${icon('play')}Register this app</button>`}
      </div></form>`;
  return `${log}${pendingBlock(a)}${composer}`;
}

export function assistantCard(a, draft) {
  const description = `An AI agent (Google Gemini, <code>${esc(a.model)}</code>) that registers this app in CloakTail as a ${LABEL[a.protocol]} application, using only the CloakTail API reference you give it, then fills the settings below. You approve every change.`;
  let body;
  if (!a.enabled) {
    body = alert('info', 'The assistant is off', ['Set <code>GEMINI_API_KEY</code> and <code>GEMINI_MODEL</code> in <code>.env</code> and restart to turn it on.']);
  } else if (!a.connection) {
    body = connectForm(a, draft);
  } else {
    const conn = a.connection;
    body = `<div class="stack">
      ${kv([
        ['Reference', `${code(conn.referenceUrl)}<small><a href="${esc(conn.referenceUrl)}" target="_blank" rel="noopener">Open ${icon('external')}</a></small>`],
        ['API client ID', code(conn.clientId)],
        ['Access token', conn.token ? `${badge('Obtained', 'ok')}${conn.token.scope ? `<small>Scopes: ${esc(conn.token.scope)}</small>` : ''}${conn.token.expiresAt ? `<small>Expires ${time(new Date(conn.token.expiresAt).toISOString())}</small>` : ''}` : `${badge('Not yet')}<small>The agent gets one as the reference describes.</small>`],
      ])}
      <div class="row">
        ${a.conversation.log.length ? `<form class="inline" method="post" action="/assistant/${a.protocol}/reset"><button class="btn ghost sm">${icon('refresh')}New conversation</button></form>` : ''}
        <form class="inline" method="post" action="/assistant/${a.protocol}/disconnect" data-confirm="Disconnect from CloakTail? The credential and both conversations are forgotten."><button class="btn ghost sm">${icon('logout')}Disconnect</button></form>
      </div>
      <hr class="divider">
      ${chat(a)}
    </div>`;
  }
  return card({
    id: 'assistant',
    iconHtml: `<span class="proto-icon ${a.protocol}">${icon('sparkle')}</span>`,
    title: `Register with the AI assistant ${badge('Optional')}`,
    description,
    body,
  });
}
