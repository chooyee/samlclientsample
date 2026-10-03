// Admin console pages: overview, SAML and OIDC setup, certificates, local profiles.
// Customers never see these; their pages are in customer.js.
import { config } from '../config.js';
import { NAME_ID_FORMATS, isCustomized } from '../settings.js';
import { assistantCard } from './assistant.js';
import { KEY_SIZES, VALIDITY_YEARS, certBase64 } from '../certs.js';
import {
  esc, icon, layout, alert, pageHead, card, badge, statusBadge, none, code, copyable, kv, time,
  emptyState, field, toggle, options, initials, protocolBadge,
} from './ui.js';

const onOff = (v) => (v ? badge('On', 'ok') : badge('Off'));
const protoIcon = (p) => `<span class="proto-icon ${p}">${icon(p === 'oidc' ? 'globe' : 'shield')}</span>`;

// The values a setup form shows: the rejected input after a failed save, else the settings.
function formState(draft, section, settings) {
  return draft?.section === section
    ? { values: draft.values, errors: draft.errors ?? {} }
    : { values: settings, errors: {} };
}

const resetForm = (back) => (isCustomized()
  ? `<form class="inline" method="post" action="/settings/reset" data-confirm="Discard the saved settings for both protocols and use the .env values?">
      <input type="hidden" name="back" value="${back}"><button class="btn ghost sm">${icon('refresh')}Reset to .env values</button></form>`
  : '');

// Shared by the SAML and OIDC settings: saving either changes it for both.
const baseUrlField = (s, errors) => field({
  name: 'baseUrl', label: 'Base URL', type: 'url', value: s.baseUrl, error: errors.baseUrl, required: true, mono: true,
  hint: 'The address the browser uses for this app. Every URL to register in CloakTail is under it, for SAML, OpenID Connect and user migration alike.',
});

function importCard({ section, step, action, title, description, placeholder, draft }) {
  const { values, errors } = formState(draft, `${section}-import`, {});
  return card({
    step,
    title,
    description,
    body: `<form method="post" action="${action}" class="stack">
      ${field({ name: 'portalConfig', label: 'Example code', textarea: true, value: values.portalConfig, error: errors.portalConfig, placeholder, required: true })}
      <div class="row"><button class="btn">${icon('arrow')}Fill settings from the example</button></div></form>`,
  });
}

// ---------- overview ----------

const ADMIN_FLOW = [
  ['Register in CloakTail', 'Create a SAML or OpenID Connect application with the values on its setup page here.'],
  ['Copy its settings here', 'Paste the application page\'s example code, or fill the fields by hand.'],
  ['Sign in as a customer', 'On the <a href="/">bank sign-in page</a>, with a test user created in CloakTail.'],
  ['Check the result', 'The customer\'s <em>Developer view</em> shows the attributes, claims, tokens and XML.'],
];

const SCENARIOS = [
  ['SP-initiated login', 'SAML <em>Sign in</em> sends an AuthnRequest; OIDC <em>Sign in</em> runs the authorization code flow.'],
  ['Force the login form', '<em>Always ask for the password</em> sends <code>ForceAuthn</code> (SAML) or <code>prompt=login</code> (OIDC), even with a Keycloak session.'],
  ['Self-registration', '<em>Open an account</em> opens Keycloak\'s form; choose <em>Register</em> (the realm must allow it).'],
  ['JIT provisioning', 'The first sign-in creates a <a href="/admin/users">local profile</a>; later ones update it.'],
  ['Attributes and claims', 'Set the expected ones in the settings; missing ones are flagged after sign-in.'],
  ['IdP-initiated login', 'SAML only: <em>Start at Keycloak</em>, once the IdP-initiated link is in the settings.'],
  ['Logout', '<em>Sign out</em> sends a SAML LogoutRequest, or redirects to the OIDC end session endpoint.'],
  ['Token refresh', 'OIDC: <em>Refresh tokens</em> uses the refresh token and shows the new ones.'],
  ['User migration', 'Sign in on the <a href="/legacy">legacy sign-in</a> page: users not yet migrated move to Keycloak through CloakTail; migrated ones go straight to Keycloak.'],
  ['Negative tests', 'Require a signature or PKCE the portal doesn\'t turn on: sign-in should fail with a clear error.'],
];

function setupItem({ iconHtml, title, status, text, href, ready }) {
  return `<li>${iconHtml}<div><strong>${title} ${status}</strong><p>${text}</p></div>
    <a class="btn${ready ? '' : ' primary'} sm" href="${href}">${ready ? 'Edit' : 'Set up'}${icon('arrow')}</a></li>`;
}

export function adminHomePage(data) {
  const { ready, active, keys, profileCount } = data;
  const { sp, idp, oidc } = active;
  const keyIcon = `<span class="proto-icon saml">${icon('key')}</span>`;
  const usersIcon = `<span class="proto-icon oidc">${icon('users')}</span>`;
  const certsInUse = [sp.signRequests && 'signing', sp.decryptAssertions && 'encryption'].filter(Boolean);
  const certsMissing = certsInUse.filter((k) => !keys[k]);

  const setup = `<ul class="setup-list">
    ${setupItem({
      iconHtml: protoIcon('saml'), title: 'SAML 2.0', status: statusBadge(ready.saml), href: '/admin/saml', ready: ready.saml,
      text: ready.saml
        ? `Entity ID <code>${esc(sp.entityId)}</code> · signed requests ${sp.signRequests ? 'on' : 'off'} · encryption ${sp.decryptAssertions ? 'on' : 'off'} · ${idp.sloUrl ? 'single logout' : 'local logout only'}`
        : 'Copy the values from a SAML application page in CloakTail.',
    })}
    ${setupItem({
      iconHtml: protoIcon('oidc'), title: 'OpenID Connect', status: statusBadge(ready.oidc), href: '/admin/oidc', ready: ready.oidc,
      text: ready.oidc
        ? `Client ID <code>${esc(oidc.clientId)}</code> · ${oidc.isPublic ? 'public' : 'confidential'} client · PKCE ${oidc.usePkce ? 'on' : 'off'}`
        : 'Copy the issuer and client ID from an OpenID Connect application page.',
    })}
    ${setupItem({
      iconHtml: `<span class="proto-icon legacy">${icon('migrate')}</span>`, title: 'User migration', status: statusBadge(ready.migration, 'Ready', 'Not ready'),
      href: '/admin/migrate', ready: ready.migration,
      text: 'Optional. Moves customers from the app\'s own passwords to Keycloak through CloakTail as they sign in.',
    })}
    ${setupItem({
      iconHtml: keyIcon, title: 'SAML certificates',
      status: certsMissing.length ? badge('Missing', 'bad') : certsInUse.length ? badge(`${certsInUse.join(' and ')} in use`, 'ok') : badge('Not in use'),
      href: '/admin/certs', ready: !certsMissing.length,
      text: 'Signing and encryption key pairs, for signed requests and encrypted assertions.',
    })}
    ${setupItem({
      iconHtml: usersIcon, title: 'Local profiles', status: badge(String(profileCount)),
      href: '/admin/users', ready: true,
      text: 'Created by each customer\'s first sign-in (JIT provisioning).',
    })}
  </ul>`;

  return layout({
    ...data,
    title: 'Overview',
    body: `
      ${pageHead('Admin console', 'Connect Acme Bank, the demo app, to Keycloak through CloakTail, and check what each sign-in returns. Customers never see this side.',
        `<a class="btn primary" href="/">${icon('landmark')}Open the bank sign-in</a>`)}
      <div class="stack-lg">
        ${card({
          title: 'What this app is',
          description: 'A test service provider for CloakTail. It plays a developer\'s app (a pretend bank) that signs its customers in through Keycloak. It knows only what CloakTail\'s application page shows a developer: if a test needs more, the page is missing something.',
          body: `<ol class="flow">${ADMIN_FLOW.map(([t, d]) => `<li><strong>${t}</strong><span>${d}</span></li>`).join('')}</ol>`,
        })}
        ${card({ title: 'Setup', description: 'Either protocol is enough for customers to sign in.', body: setup })}
        ${card({
          title: 'What to test',
          description: 'Scenarios this app covers, for both protocols unless noted. Customers start each one on the <a href="/">bank sign-in page</a>.',
          body: `<ul class="checklist">${SCENARIOS.map(([k, v]) => `<li><strong>${k}</strong><span>${v}</span></li>`).join('')}</ul>`,
        })}
      </div>`,
  });
}

// ---------- SAML setup ----------

export function samlPage(data) {
  const { active, settings, draft, ready } = data;
  const { sp } = active;
  const { values: s, errors } = formState(draft, 'saml', settings);

  const register = card({
    step: 1,
    title: 'Register this app in CloakTail',
    description: 'In CloakTail, <em>Applications → New application → SAML</em>. Fill the form with these values, or import the metadata.',
    body: `${kv([
      ['Entity ID', copyable(sp.entityId, 'entity ID')],
      ['ACS URL', copyable(sp.acsUrl, 'ACS URL')],
      ['Logout URL', copyable(sp.sloUrl, 'logout URL')],
      ['Home URL', copyable(sp.homeUrl, 'home URL')],
      ['SP metadata', `${copyable(sp.metadataUrl, 'metadata URL')}<small><a href="/saml/metadata" target="_blank">Open the XML ${icon('external')}</a> to paste it into <em>Import metadata</em>.</small>`],
    ])}
    <hr class="divider">
    <h3 style="margin-bottom:10px">Match these portal settings</h3>
    ${kv([
      ['Sign response', onOff(sp.wantResponseSigned)],
      ['Sign assertion', onOff(sp.wantAssertionsSigned)],
      ['Require signed requests', onOff(sp.signRequests) + (sp.signRequests ? `<small>Paste the <a href="/admin/certs#signing">signing certificate</a> into the portal.</small>` : '')],
      ['Encrypt assertions', onOff(sp.decryptAssertions) + (sp.decryptAssertions ? `<small>Paste the <a href="/admin/certs#encryption">encryption certificate</a> into the portal.</small>` : '')],
      ['Name ID format', code(sp.nameIdFormat || 'Any')],
    ])}`,
  });

  const importer = importCard({
    section: 'saml',
    step: 2,
    action: '/saml/settings/import',
    title: 'Paste the example from the application page',
    description: 'The quickest way to fill step 3. Copy the <em>Example: Node.js (@node-saml/passport-saml)</em> block. It fills the SSO and logout URLs, both entity IDs, the Name ID format and the signing and encryption switches; copy the rest by hand.',
    placeholder: "passport.use('saml', new SamlStrategy({ entryPoint: ... }))",
    draft,
  });

  const form = `<form method="post" action="/saml/settings" novalidate>
    <fieldset class="fieldset"><legend>Keycloak (IdP) details</legend>
      <p>From the application page, <em>Keycloak (IdP) details</em>.</p>
      <div class="fields">
        ${field({ name: 'idpSsoUrl', label: 'Single sign-on URL', type: 'url', value: s.idpSsoUrl, error: errors.idpSsoUrl, required: true, mono: true })}
        ${field({ name: 'idpEntityId', label: 'IdP entity ID (issuer)', value: s.idpEntityId, error: errors.idpEntityId, required: true, mono: true })}
        ${field({ name: 'idpMetadataUrl', label: 'IdP metadata URL', type: 'url', value: s.idpMetadataUrl, error: errors.idpMetadataUrl, mono: true,
          hint: 'The signing certificate is read from here (cached for an hour) unless you pin one below.' })}
        ${field({ name: 'idpSloUrl', label: 'Single logout URL', type: 'url', value: s.idpSloUrl, error: errors.idpSloUrl, optional: true, mono: true,
          hint: 'Empty: <em>Sign out</em> ends only the local session.' })}
        ${field({ name: 'idpInitiatedUrl', label: 'IdP-initiated login URL', type: 'url', value: s.idpInitiatedUrl, error: errors.idpInitiatedUrl, optional: true, mono: true,
          hint: 'Shown on the application page when the client has an IdP-initiated link.' })}
        ${field({ name: 'idpCert', label: 'Signing certificate', textarea: true, value: s.idpCert, error: errors.idpCert, optional: true,
          placeholder: 'Empty: read from the IdP metadata URL', hint: 'PEM or base64, as the application page shows it. Pins the certificate instead of reading the metadata.' })}
      </div>
    </fieldset>
    <fieldset class="fieldset"><legend>Your app (SP)</legend>
      <p>From the application page, <em>Your app (SP) settings</em>.</p>
      <div class="fields">
        ${baseUrlField(s, errors)}
        ${field({ name: 'entityId', label: 'Entity ID', value: s.entityId, error: errors.entityId, optional: true, mono: true,
          placeholder: sp.defaultEntityId, hint: 'Becomes the Keycloak client ID. Empty uses the default shown.' })}
        ${field({ name: 'nameIdFormat', label: 'Name ID format', value: s.nameIdFormat, error: errors.nameIdFormat, optional: true, mono: true,
          placeholder: 'Any', list: 'nameIdFormats', hint: 'The URN under <em>Name ID format</em>. Empty accepts whatever Keycloak sends.' })}
        <datalist id="nameIdFormats">${NAME_ID_FORMATS.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
        ${field({ name: 'expectedAttributes', label: 'Expected attributes', value: s.expectedAttributes, optional: true,
          placeholder: 'email, firstName, lastName', hint: 'The page\'s <em>Attributes</em>. After sign-in, missing ones are flagged.' })}
      </div>
    </fieldset>
    <fieldset class="fieldset"><legend>Signatures and encryption</legend>
      <p>Each switch must match its portal setting. Turning one on that the portal leaves off is a good negative test.</p>
      <div class="switches">
        ${toggle('wantResponseSigned', 'Require signed response', s.wantResponseSigned, 'Portal: <em>Sign response</em>')}
        ${toggle('wantAssertionsSigned', 'Require signed assertion', s.wantAssertionsSigned, 'Portal: <em>Sign assertion</em>')}
        ${toggle('signRequests', 'Sign requests', s.signRequests, 'Portal: <em>Require signed requests</em>. Generates a signing key pair if missing.')}
        ${toggle('decryptAssertions', 'Decrypt assertions', s.decryptAssertions, 'Portal: <em>Encrypt assertions</em>. Generates an encryption key pair if missing.')}
      </div>
    </fieldset>
    <hr class="divider">
    <div class="row"><button class="btn primary">Save settings</button><span class="small muted">Applies immediately; signed-in sessions are kept.</span></div>
  </form>`;

  return layout({
    ...data,
    title: 'SAML 2.0',
    body: `
      ${pageHead(`SAML 2.0 ${statusBadge(ready.saml)}`, 'Test a SAML application registered in CloakTail. Every value here comes from, or goes to, the application page.',
        `${resetForm('/admin/saml')}${ready.saml ? `<a class="btn primary" href="/?via=saml">${icon('landmark')}Test on the bank sign-in</a>` : ''}`)}
      <div class="stack-lg">
        ${assistantCard(data.assistant, draft)}
        ${register}
        ${importer}
        ${card({ id: 'settings', step: 3, title: 'Settings', description: `Defaults come from <code>.env</code>; saved changes are kept in <code>${esc(config.settingsFile)}</code>.`, body: form })}
      </div>`,
  });
}

// ---------- OIDC setup ----------

function discoveryCard(discovery, ready) {
  let body;
  if (!ready) {
    body = alert('info', 'Not checked yet', ['Save the issuer and client ID to read the discovery document.']);
  } else if (!discovery.ok) {
    body = alert('bad', 'Could not read the discovery document', [esc(discovery.error)]);
  } else {
    const e = discovery.endpoints;
    body = `<div class="stack">${alert('ok', 'Discovery document read', ['openid-client takes every endpoint below from it.'])}
      ${kv([
        ['Authorization', code(e.authorization)],
        ['Token', code(e.token)],
        ['Userinfo', code(e.userinfo)],
        ['JWKS (signing keys)', code(e.jwks)],
        ['End session', e.endSession ? code(e.endSession) : `${none('None')}<small>Sign out ends the local session only.</small>`],
        ['PKCE methods', discovery.pkceMethods.length ? code(discovery.pkceMethods.join(', ')) : none('None advertised')],
      ])}</div>`;
  }
  return card({ id: 'discovery', title: 'Connection', description: 'What the provider\'s discovery document says.', body });
}

export function oidcPage(data) {
  const { active, settings, draft, ready, discovery } = data;
  const { oidc } = active;
  const { values: s, errors } = formState(draft, 'oidc', settings);

  const register = card({
    step: 1,
    title: 'Register this app in CloakTail',
    description: 'In CloakTail, <em>Applications → New application → OpenID Connect</em>. Either client type works: a confidential client needs its secret in step 3; a public client has none and uses PKCE.',
    body: `${kv([
      ['Redirect URI', copyable(oidc.redirectUri, 'redirect URI')],
      ['Post-logout redirect URI', copyable(oidc.postLogoutRedirectUri, 'post-logout redirect URI')],
      ['Web origin', copyable(oidc.webOrigin, 'web origin')],
      ['Home URL', copyable(oidc.homeUrl, 'home URL')],
      ['PKCE', `${oidc.usePkce ? 'Sent (S256)' : 'Not sent'}<small>Match the portal's <em>Require PKCE</em>, or turn it off here as a negative test.</small>`],
    ])}
    <hr class="divider">
    <details class="more"><summary>Test IdP-initiated logout (optional)</summary>
      <p class="muted" style="margin-top:0">The portal doesn't set a front-channel logout URL. To test logout started from Keycloak, set it on the client in the Keycloak admin console, then sign out of another app in the same realm and browser.</p>
      ${kv([['Front-channel logout URL', copyable(oidc.frontchannelLogoutUri, 'front-channel logout URL')]])}
    </details>`,
  });

  const importer = importCard({
    section: 'oidc',
    step: 2,
    action: '/oidc/settings/import',
    title: 'Paste the example from the application page',
    description: 'Copy the <em>Example code → Node.js</em> block (openid-client). It fills the issuer, client ID, client type, scopes and PKCE. The client secret is never in it.',
    placeholder: "const config = await client.discovery(new URL('...'), 'my-app', ...)",
    draft,
  });

  const form = `<form method="post" action="/oidc/settings" novalidate>
    <fieldset class="fieldset"><legend>Your app</legend>
      <p>Where this app runs. The URLs in step 1 are under it.</p>
      <div class="fields">${baseUrlField(s, errors)}</div>
    </fieldset>
    <fieldset class="fieldset"><legend>Keycloak (OpenID provider)</legend>
      <p>From the application page, <em>Keycloak (OpenID provider) details</em>. Everything else is read from the discovery document.</p>
      <div class="fields">
        ${field({ name: 'oidcIssuer', label: 'Issuer', type: 'url', value: s.oidcIssuer, error: errors.oidcIssuer, required: true, mono: true,
          placeholder: 'http://localhost:8080/realms/my-realm', hint: 'The <em>Issuer</em>. The discovery document URL works too.' })}
      </div>
    </fieldset>
    <fieldset class="fieldset"><legend>Client credentials</legend>
      <p>From the application page, <em>Client credentials</em>.</p>
      <div class="fields">
        ${field({ name: 'oidcClientId', label: 'Client ID', value: s.oidcClientId, error: errors.oidcClientId, required: true, mono: true })}
        ${field({ name: 'oidcClientSecret', label: 'Client secret', type: 'password', value: s.oidcClientSecret, error: errors.oidcClientSecret, optional: true, mono: true,
          placeholder: 'Empty for a public client', hint: 'Confidential clients only. Kept in the settings file on this machine.',
          after: `<button type="button" class="btn" data-reveal="f-oidcClientSecret" aria-pressed="false" aria-label="Show secret">${icon('eye')}</button>` })}
      </div>
    </fieldset>
    <fieldset class="fieldset"><legend>Authorization request</legend>
      <p>What this app asks Keycloak for at sign-in.</p>
      <div class="fields">
        ${field({ name: 'oidcScopes', label: 'Scopes', value: s.oidcScopes, error: errors.oidcScopes, mono: true,
          hint: 'Space-separated; must include <code>openid</code>. The portal\'s example asks for <code>openid profile email</code>.' })}
        ${field({ name: 'oidcExpectedClaims', label: 'Expected claims', value: s.oidcExpectedClaims, optional: true,
          placeholder: 'email, given_name, family_name', hint: 'Checked against the ID token and userinfo after sign-in.' })}
        <div class="switches">${toggle('oidcUsePkce', 'Use PKCE (S256)', s.oidcUsePkce, 'Required when the portal\'s <em>Require PKCE</em> is on, and for public clients.')}</div>
      </div>
    </fieldset>
    <hr class="divider">
    <div class="row"><button class="btn primary">Save settings</button><span class="small muted">Applies immediately; signed-in sessions are kept.</span></div>
  </form>`;

  return layout({
    ...data,
    title: 'OpenID Connect',
    body: `
      ${pageHead(`OpenID Connect ${statusBadge(ready.oidc)}`, 'Test an OpenID Connect application registered in CloakTail, as the portal\'s Node.js example does: issuer, client ID and secret are all the app is given.',
        `${resetForm('/admin/oidc')}${ready.oidc ? `<a class="btn primary" href="/?via=oidc">${icon('landmark')}Test on the bank sign-in</a>` : ''}`)}
      <div class="stack-lg">
        ${assistantCard(data.assistant, draft)}
        ${register}
        ${importer}
        ${card({ id: 'settings', step: 3, title: 'Settings', description: `Defaults come from <code>.env</code>; saved changes are kept in <code>${esc(config.settingsFile)}</code>.`, body: form })}
        ${discoveryCard(discovery, ready.oidc)}
      </div>`,
  });
}

// ---------- certificates ----------

function certCard(kind, title, purpose, inUse, pair, error) {
  const status = error ? badge('Error', 'bad')
    : !pair ? badge('Not generated')
      : pair.info.expired ? badge('Expired', 'bad')
        : inUse ? badge('In use', 'ok') : badge('Not in use');

  const body = error
    ? alert('bad', 'The key pair can\'t be loaded', [esc(error)])
    : pair
      ? `${kv([
        ['Subject', code(pair.info.subject)],
        ['Key', esc(`RSA ${pair.info.keySize ?? '?'} bit`)],
        ['Valid', `${time(pair.info.validFrom, { relative: false })} to ${time(pair.info.validTo, { relative: false })}`],
        ['SHA-256 fingerprint', copyable(pair.info.fingerprint256, 'fingerprint')],
        ['Files', `${code(config.keyFiles[kind].cert)}<small>${esc(config.keyFiles[kind].key)}</small>`],
      ])}
      <hr class="divider">
      <div class="row">
        <button type="button" class="btn primary sm" data-copy="${esc(certBase64(pair.cert))}" aria-label="Copy certificate">${icon('copy')}Copy certificate (base64)</button>
        <a class="btn sm" href="/certs/${kind}" target="_blank">View PEM</a>
        <a class="btn sm" href="/certs/${kind}?download=1">${icon('download')}Download .pem</a>
      </div>
      <p class="hint">Keycloak's certificate fields take the base64 form.</p>`
      : emptyState('key', 'No key pair yet', inUse ? 'One is generated when you save the SAML settings.' : 'Generate one below.');

  const confirmReplace = pair
    ? ` data-confirm="Replace the ${kind} key pair? The certificate registered in the portal stops matching until you paste the new one."`
    : '';
  return card({
    id: kind,
    iconHtml: `<span class="proto-icon saml">${icon('key')}</span>`,
    title: `${title} ${status}`,
    description: purpose,
    body,
    foot: `<form class="row" method="post" action="/certs/${kind}/generate"${confirmReplace}>
        <label class="sr-only" for="ks-${kind}">Key size</label>
        <select class="input" id="ks-${kind}" name="keySize">${options(KEY_SIZES, pair?.info.keySize ?? 2048, '-bit RSA')}</select>
        <label class="sr-only" for="yr-${kind}">Validity</label>
        <select class="input" id="yr-${kind}" name="years">${options(VALIDITY_YEARS, 10, ' years')}</select>
        <button class="btn${pair ? '' : ' primary'}">${icon('refresh')}${pair ? 'Regenerate' : 'Generate'} key pair</button>
      </form>`,
  });
}

export function certsPage(data) {
  const { active, keys, keyErrors } = data;
  return layout({
    ...data,
    title: 'Certificates',
    body: `
      ${pageHead('Certificates', 'Self-signed key pairs for SAML. Private keys stay on this machine; paste the certificate into the portal. OpenID Connect doesn\'t use them.')}
      <div class="stack-lg">
        ${certCard('signing', 'Signing', 'Signs AuthnRequests and LogoutRequests, when <em>Sign requests</em> is on.',
          active.sp.signRequests, keys.signing, keyErrors.signing)}
        ${certCard('encryption', 'Encryption', 'Keycloak encrypts assertions to this certificate and the app decrypts them, when <em>Decrypt assertions</em> is on.',
          active.sp.decryptAssertions, keys.encryption, keyErrors.encryption)}
        ${alert('info', 'Rotating a key pair', ['After regenerating a pair that is in use, paste the new certificate into the portal. Until then Keycloak rejects signed requests, or encrypts to the old key.'])}
      </div>`,
  });
}

// ---------- local profiles ----------

export function usersPage(data) {
  const { profiles } = data;
  const table = profiles.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>User</th><th>Protocol</th><th>Email</th><th>First sign-in</th><th>Last sign-in</th><th>Sign-ins</th></tr></thead>
        <tbody>${profiles.map((p) => {
          const id = p.protocol === 'oidc' ? (p.username || p.subject) : p.nameID;
          const name = [p.firstName, p.lastName].filter(Boolean).join(' ');
          return `<tr>
            <td><div class="row" style="flex-wrap:nowrap"><span class="avatar">${esc(initials(name || id))}</span>
              <div>${name ? `<div>${esc(name)}</div>` : ''}<code class="small">${esc(id)}</code></div></div></td>
            <td>${protocolBadge(p.protocol)}</td>
            <td>${code(p.email)}</td>
            <td>${time(p.createdAt)}</td>
            <td>${time(p.lastSignInAt)}</td>
            <td>${esc(p.signInCount)}</td></tr>`;
        }).join('')}</tbody></table></div>`
    : emptyState('users', 'No profiles yet', 'Each user\'s first sign-in creates one.', '<a class="btn" href="/">Open the bank sign-in</a>');

  return layout({
    ...data,
    title: 'Local profiles',
    body: `
      ${pageHead('Local profiles', `Just-in-time provisioning: each user's first sign-in creates a profile from the assertion or ID token. Accounts and passwords stay in Keycloak. Kept in <code>${esc(config.usersFile)}</code>.`,
        profiles.length ? `<form class="inline" method="post" action="/users/clear" data-confirm="Forget every local profile? Keycloak accounts are not affected.">
          <button class="btn danger">${icon('trash')}Clear local profiles</button></form>` : '')}
      ${card({ body: table, bodyClass: profiles.length ? '' : 'card-body' })}`,
  });
}
