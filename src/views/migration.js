// The admin console's Migration page: setup, testing against CloakTail, legacy users and activity.
// The customer side of migration (legacy sign-in, hand-off) is in customer.js.
import { config } from '../config.js';
import { STATUSES } from '../migration.js';
import { isMigrated } from '../legacyUsers.js';
import {
  esc, icon, layout, alert, pageHead, card, badge, statusBadge, none, code, copyable, kv, time,
  codeBlock, emptyState, field, initials,
} from './ui.js';

const PROTOCOL_LABEL = { oidc: 'OpenID Connect', saml: 'SAML' };
const fullName = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ');

function migrationBadge(u) {
  if (isMigrated(u)) return badge(`${icon('check')}Migrated`, 'ok');
  if (u.conflict) return badge('Conflict', 'bad');
  return badge('Not migrated', 'warn');
}

const FLOW = [
  ['Old password', 'The user signs in here, as today.'],
  ['Hand-off', 'Not migrated yet: no session; a signed request goes to CloakTail.'],
  ['New password', 'CloakTail creates the Keycloak account and returns a signed result.'],
  ['Keycloak from now on', 'Marked migrated; this and every later sign-in uses Keycloak.'],
];
const flow = `<ol class="flow">${FLOW.map(([t, d]) => `<li><strong>${t}</strong><span>${d}</span></li>`).join('')}</ol>`;

// ---------- Migration page ----------

function registerCard({ m, keyStatus, hasSecret }) {
  const k = keyStatus.key;
  const signing = m.requestSigning === 'jwks'
    ? [
      ['Request signing', `${badge('JWKS URL', 'ok')}<small>Choose <em>JWKS URL</em> on the migration page and paste the URL below.</small>`],
      ['JWKS URL', `${copyable(config.jwksUrl, 'JWKS URL')}<small><a href="/migrate/jwks.json" target="_blank">Open the JWKS ${icon('external')}</a></small>`],
      ['Key ID (kid)', k ? copyable(k.kid, 'key ID') : none(keyStatus.error ? 'Key unreadable' : 'No key yet')],
      ['Algorithm', code('RS256')],
    ]
    : [['Request signing', `${badge('Migration secret (HS256)')}<small>The default on the migration page.</small>`]];
  return card({
    step: 1,
    title: 'Register in CloakTail',
    description: 'In CloakTail, <em>Applications → (this app) → User migration</em>. Enter these values, then copy the migration secret into <code>.env</code>.',
    body: kv([
      ['Client ID (iss)', m.clientId ? `${copyable(m.clientId, 'client ID')}<small>The ${esc(PROTOCOL_LABEL[m.protocol])} ${m.protocol === 'oidc' ? 'client ID' : 'entity ID'}: the application with user migration set up.</small>` : none('Set up the protocol first')],
      ['Return URL', copyable(m.returnUrl, 'return URL')],
      ...signing,
      ['Migration secret', `${statusBadge(hasSecret, 'Set', 'Not set')}<small>From the migration page, as <code>CLOAKTAIL_MIGRATION_SECRET</code> in <code>.env</code>; restart after changing it. Verifies results${m.requestSigning === 'secret' ? ' and signs requests' : ''}. Never shown here.</small>`],
    ]),
  });
}

function keyCard({ keyStatus, m }) {
  const k = keyStatus.key;
  const body = keyStatus.error
    ? alert('bad', 'The signing key can\'t be loaded', [esc(keyStatus.error)])
    : k
      ? `${kv([
        ['Key ID (kid)', copyable(k.kid, 'key ID')],
        ['Key', esc(`RSA ${k.bits} bit, RS256`)],
        ['Created', time(k.createdAt)],
        ['Private key', `${code(config.migrationKeyFile)}<small>Stays on this machine; only the public key is published.</small>`],
      ])}
      <div style="margin-top:16px">${codeBlock('Public JWKS', JSON.stringify({ keys: [k.jwk] }, null, 2))}</div>`
      : emptyState('key', 'No signing key yet', 'Generate one to publish the JWKS.');
  return card({
    id: 'key',
    iconHtml: `<span class="proto-icon oidc">${icon('key')}</span>`,
    title: `Request signing key ${m.requestSigning === 'jwks' ? badge('In use', 'ok') : badge('Not in use')}`,
    description: `Published at <code>${esc(config.jwksUrl)}</code>. CloakTail fetches it again when a request names a new kid, so rotating needs no change in the portal.`,
    body,
    foot: `<form class="inline" method="post" action="/migrate/key"${k ? ' data-confirm="Replace the signing key? Requests signed with the old key stop verifying once CloakTail fetches the new JWKS."' : ''}>
      <button class="btn${k ? '' : ' primary'}">${icon('refresh')}${k ? 'Rotate key' : 'Generate key'}</button></form>`,
  });
}

function settingsCard({ s, errors, m }) {
  const radio = (name, value, label, hint, current) => `<label class="switch-row"><input type="radio" name="${name}" value="${value}"${current === value ? ' checked' : ''}>
    <span><strong>${label}</strong>${hint ? `<span class="hint">${hint}</span>` : ''}</span></label>`;
  return card({
    id: 'settings',
    step: 2,
    title: 'Settings',
    description: `Match the migration page. Defaults come from <code>.env</code>; saved changes are kept in <code>${esc(config.settingsFile)}</code>.`,
    body: `<form method="post" action="/migrate/settings" novalidate>
      <fieldset class="fieldset"><legend>Keycloak sign-in for migrated users</legend>
        <p>Also decides the client ID sent as <code>iss</code>. Now: ${esc(PROTOCOL_LABEL[m.protocol])}${m.protocolAuto ? ' (automatic)' : ''}.</p>
        <div class="switches">
          ${radio('migrationProtocol', '', 'Automatic', 'OpenID Connect when it is set up, else SAML.', s.migrationProtocol)}
          ${radio('migrationProtocol', 'oidc', 'OpenID Connect', 'Sends <code>login_hint</code>.', s.migrationProtocol)}
          ${radio('migrationProtocol', 'saml', 'SAML 2.0', 'passport-saml can\'t add a Subject to the AuthnRequest, so no username hint.', s.migrationProtocol)}
        </div>
        ${errors.migrationProtocol ? `<p class="error">${icon('bad')}${esc(errors.migrationProtocol)}</p>` : ''}
      </fieldset>
      <fieldset class="fieldset"><legend>Request signing</legend>
        <p>The method chosen on the migration page. Results are always HS256 with the migration secret.</p>
        <div class="switches">
          ${radio('migrationRequestSigning', 'jwks', 'JWKS URL (RS256)', 'Signed with this app\'s private key; CloakTail reads the public key from the JWKS URL.', s.migrationRequestSigning)}
          ${radio('migrationRequestSigning', 'secret', 'Migration secret (HS256)', 'The portal\'s default.', s.migrationRequestSigning)}
        </div>
      </fieldset>
      <fieldset class="fieldset"><legend>Return URL</legend>
        <div class="fields">${field({ name: 'migrationReturnUrl', label: 'Return URL', type: 'url', value: s.migrationReturnUrl, error: errors.migrationReturnUrl, required: true, mono: true,
          hint: 'Must be byte-for-byte one of the return URLs registered on the migration page. This app handles it at <code>/migrate/return</code>.' })}</div>
      </fieldset>
      <hr class="divider">
      <div class="row"><button class="btn primary">Save settings</button></div>
    </form>`,
  });
}

function testCard({ users, check, ready, simulatedAccepted }) {
  const userOptions = users.map((u) => `<option value="${esc(u.id)}">${esc(u.username)} (${esc(u.id)})</option>`).join('');
  let result = '';
  if (check) {
    const ok = check.body?.ok;
    result = `<hr class="divider">${alert(ok ? (check.body.warning ? 'warn' : 'ok') : 'bad',
      ok ? `Request accepted for ${esc(check.username)}` : `Request refused: ${esc(check.body?.error?.code ?? check.error ?? 'error')}`,
      [esc(ok ? (check.body.warning?.message ?? 'POST /migrate/check returned ok: true.') : (check.body?.error?.message ?? check.error ?? ''))])}
      ${check.claims ? `<div style="margin-top:12px">${codeBlock(`Request sent (header ${esc(JSON.stringify(check.header))})`, JSON.stringify(check.claims, null, 2))}</div>` : ''}
      ${check.body ? codeBlock('CloakTail answered', JSON.stringify(check.body, null, 2)) : ''}`;
  }
  return card({
    id: 'test',
    step: 3,
    title: 'Test against CloakTail',
    description: '<em>Check</em> validates a request built for the user exactly as <code>/migrate/start</code> would. <em>Simulate</em> gets a signed result with the status you choose and opens the return URL in this browser, to test each branch. Neither creates users or uses up the jti.',
    body: `${ready ? '' : alert('info', 'Finish steps 1 and 2 first', ['Both calls need a request this app can sign and a client ID.'])}
      <form method="post" action="/migrate/test" class="stack">
        <div class="row">
          <label class="sr-only" for="t-user">User</label>
          <select class="input" id="t-user" name="userId">${userOptions}</select>
          <button class="btn" name="action" value="check"${ready ? '' : ' disabled'}>${icon('check')}Check request</button>
        </div>
        <div class="row">
          <label class="sr-only" for="t-status">Status</label>
          <select class="input" id="t-status" name="status">${STATUSES.map((s) => `<option>${s}</option>`).join('')}</select>
          <button class="btn" name="action" value="simulate"${ready ? '' : ' disabled'}>${icon('play')}Simulate result</button>
        </div>
        <p class="hint" style="margin:0">${simulatedAccepted
          ? 'Simulated results are accepted (<code>MIGRATION_ACCEPT_SIMULATED</code>), as in development. The user\'s password is not asked: this is a test shortcut.'
          : 'Simulated results are treated as <code>error</code> (<code>MIGRATION_ACCEPT_SIMULATED=false</code>), as in production.'}</p>
      </form>${result}`,
  });
}

function usersCard({ users }) {
  const rows = users.map((u) => `<tr>
      <td><div class="row" style="flex-wrap:nowrap"><span class="avatar">${esc(initials(fullName(u) || u.username))}</span>
        <div><div>${esc(fullName(u) || u.username)}</div><code class="small">${esc(u.username)} · id ${esc(u.id)}</code></div></div></td>
      <td>${migrationBadge(u)}${u.conflict?.detail ? `<div class="small muted">${esc(u.conflict.detail)}</div>` : ''}</td>
      <td>${u.keycloakId ? `<code class="small">${esc(u.keycloakId)}</code>` : none('—')}</td>
      <td>${u.migratedAt ? time(u.migratedAt) : none('—')}${u.firstKeycloakSignInAt ? `<div class="small muted">Keycloak sign-in ${time(u.firstKeycloakSignInAt)}</div>` : ''}</td>
      <td>${isMigrated(u) || u.conflict ? `<form class="inline" method="post" action="/migrate/users/${esc(u.id)}/reset" data-confirm="Forget ${esc(u.username)}'s migration? They will be sent to CloakTail again. The Keycloak account is not deleted.">
        <button class="btn ghost sm">${icon('refresh')}Reset</button></form>` : ''}</td></tr>`).join('');
  return card({
    id: 'users',
    title: 'Legacy users',
    description: `The app's own user table with the migration flag (<code>migrated_at</code>, <code>keycloak_id</code>). Kept in <code>${esc(config.legacyUsersFile)}</code>.`,
    bodyClass: '',
    body: `<div class="table-wrap"><table>
      <thead><tr><th>User</th><th>Status</th><th>Keycloak ID</th><th>Migrated</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`,
    foot: `${users.some((u) => isMigrated(u) || u.conflict || u.migrationStartedAt) ? `<form class="inline" method="post" action="/migrate/users/reset-migrations" data-confirm="Forget every user's migration? They will be sent to CloakTail again. Keycloak accounts are not deleted." style="display:block;width:100%">
        <button class="btn sm">${icon('refresh')}Reset all migrations</button></form>` : ''}
      <details class="more" style="width:100%"><summary>Add a legacy user</summary>
      <form method="post" action="/migrate/users" class="stack">
        <div class="grid-2">
          ${field({ name: 'username', label: 'Username', required: true })}
          ${field({ name: 'email', label: 'Email', type: 'email', optional: true })}
          ${field({ name: 'firstName', label: 'First name', optional: true })}
          ${field({ name: 'lastName', label: 'Last name', optional: true })}
          ${field({ name: 'password', label: 'Password', type: 'password', required: true, hint: 'At least 8 characters.' })}
        </div>
        <div class="row"><button class="btn primary">Add user</button></div>
      </form>
      <form class="inline" method="post" action="/migrate/users/reset" data-confirm="Restore the three demo users and forget every migration? Keycloak accounts are not deleted." style="display:block;margin-top:16px">
        <button class="btn danger sm">${icon('trash')}Restore demo users</button></form>
    </details>`,
  });
}

function eventsCard({ events }) {
  const KIND = { started: 'Sent to CloakTail', result: 'Result accepted', rejected: 'Result rejected', keycloak: 'Keycloak sign-in', legacy: 'Old-way sign-in', check: 'Checked', simulate: 'Simulated' };
  return card({
    id: 'events',
    title: 'Recent activity',
    description: 'Since the app started. Tokens are never recorded.',
    bodyClass: events.length ? '' : 'card-body',
    body: events.length
      ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Event</th><th>User</th><th>Status</th><th>Detail</th></tr></thead><tbody>
        ${events.map((e) => `<tr><td>${time(e.at)}</td><td>${esc(KIND[e.kind] ?? e.kind)}</td><td>${e.user ? code(e.user) : none('—')}</td>
          <td>${e.status ? code(e.status) : none('—')}</td><td class="small">${esc(e.detail ?? '')}</td></tr>`).join('')}</tbody></table></div>`
      : emptyState('migrate', 'Nothing yet', 'Sign in on the customer site\'s <a href="/legacy">legacy sign-in</a> page.'),
  });
}

export function migrationPage(data) {
  const { m, problems, settings, draft, hasSecret } = data;
  const fromDraft = draft?.section === 'migration';
  const s = fromDraft ? draft.values : settings;
  const errors = fromDraft ? draft.errors ?? {} : {};
  // Check and simulate need only a signable request; Keycloak sign-in isn't involved.
  const canTest = Boolean(m.clientId && hasSecret && (m.requestSigning !== 'jwks' || data.keyStatus.key));
  return layout({
    ...data,
    title: 'Migration',
    body: `
      ${pageHead(`User migration ${statusBadge(!problems.length, 'Ready', 'Not ready')}`,
        'Move legacy users into Keycloak through CloakTail as they sign in. The protocol: <a href="http://localhost:3000/migrate/spec.md" target="_blank">CloakTail user migration</a>.',
        `<a class="btn primary" href="/legacy">${icon('landmark')}Open the legacy sign-in</a>`)}
      <div class="stack-lg">
        ${card({ body: flow })}
        ${problems.length ? alert('warn', 'Before users can migrate', problems.map(esc)) : ''}
        ${registerCard(data)}
        ${settingsCard({ s, errors, m })}
        ${testCard({ ...data, ready: canTest })}
        ${keyCard(data)}
        ${usersCard(data)}
        ${eventsCard(data)}
      </div>`,
  });
}
