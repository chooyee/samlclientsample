// The admin console's API credentials page: the CloakTail API credential the registration assistant
// uses, and a button to get an access token with it (see apiCredentials.js).
import { config } from '../config.js';
import { TOKEN_PATH } from '../apiCredentials.js';
import { esc, icon, layout, pageHead, card, badge, statusBadge, none, code, kv, time, field } from './ui.js';

function credentialForm(c, draft) {
  const fromDraft = draft?.section === 'api';
  const values = fromDraft ? draft.values : c;
  const errors = (fromDraft && draft.errors) || {};
  return `<form method="post" action="/api-credentials" novalidate>
    <div class="fields">
      ${field({ name: 'cloaktailUrl', label: 'CloakTail URL', type: 'url', value: values.cloaktailUrl, error: errors.cloaktailUrl, required: true, mono: true,
        placeholder: 'http://localhost:3000', hint: `The CloakTail site the credential was created on. Tokens come from <code>${esc(TOKEN_PATH)}</code> under it.` })}
      ${field({ name: 'clientId', label: 'Client ID', value: values.clientId, error: errors.clientId, required: true, mono: true,
        placeholder: 'ctc_…', hint: 'From CloakTail\'s <em>API credentials</em> page.' })}
      ${field({ name: 'clientSecret', label: 'Client secret', type: 'password', value: '', error: errors.clientSecret, required: !c.saved, mono: true,
        placeholder: c.saved ? 'Saved: leave empty to keep it' : 'cts_…',
        hint: `Shown once by CloakTail. Kept in <code>${esc(config.apiCredentialsFile)}</code> on this machine; never shown again, logged or sent to the AI model.`,
        after: `<button type="button" class="btn" data-reveal="f-clientSecret" aria-pressed="false" aria-label="Show secret">${icon('eye')}</button>` })}
    </div>
    <hr class="divider">
    <div class="row">
      <button class="btn primary" name="action" value="token">${icon('key')}Save and get access token</button>
      <button class="btn" name="action" value="save">Save</button>
    </div>
  </form>`;
}

function tokenCard(c) {
  const t = c.token;
  const status = !c.saved ? badge('No credential') : t ? badge('Token obtained', 'ok') : badge('No token yet');
  const body = kv([
    ['Token endpoint', c.tokenUrl ? `${code(c.tokenUrl)}<small>Client credentials grant, with the credential in HTTP Basic, as CloakTail documents it.</small>` : none('Save a credential first')],
    ['Obtained', t ? time(new Date(t.obtainedAt).toISOString()) : none('Not yet')],
    ['Expires', t?.expiresAt ? time(new Date(t.expiresAt).toISOString()) : none(t ? 'No expiry given' : 'Not yet')],
    ['Scopes', t ? code(t.scope) : none('Not yet')],
  ]);
  return card({
    id: 'token',
    iconHtml: `<span class="proto-icon oidc">${icon('key')}</span>`,
    title: `Access token ${status}`,
    description: 'The registration assistant asks this app for a token; it never sees the credential or the token. The token stays in this app\'s memory and is renewed when it expires.',
    body,
    foot: c.saved
      ? `<form class="inline" method="post" action="/api-credentials/token"><button class="btn primary">${icon('refresh')}Get access token</button></form>`
      : '',
  });
}

export function apiCredentialsPage(data) {
  const { credentials: c, draft } = data;
  return layout({
    ...data,
    title: 'API credentials',
    body: `
      ${pageHead(`API credentials ${statusBadge(c.saved, 'Saved', 'Not saved')}`,
        'The CloakTail API credential the <a href="/admin/saml#assistant">registration assistant</a> registers this app with. Create one in CloakTail under <em>API credentials</em>, with the <code>apps:read</code>, <code>apps:write</code> and <code>secrets:read</code> scopes.',
        c.saved ? `<form class="inline" method="post" action="/api-credentials/delete" data-confirm="Delete the saved API credential? The assistant can't call CloakTail until you save one again.">
          <button class="btn danger">${icon('trash')}Delete credential</button></form>` : '')}
      <div class="stack-lg">
        ${card({
          id: 'credential',
          step: 1,
          title: 'Enter the API credential',
          description: c.saved && c.updatedAt ? `Saved ${time(c.updatedAt)}.` : 'Saved on this machine, so it survives a restart.',
          body: credentialForm(c, draft),
        })}
        ${tokenCard(c)}
      </div>`,
  });
}
