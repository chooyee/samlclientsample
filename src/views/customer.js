// Customer-facing pages, in the Acme Bank theme: the sign-in page, the signed-in dashboard,
// the legacy (pre-Keycloak) sign-in and the hand-off to CloakTail. Settings live in the admin
// console (pages.js, migration.js); these pages only link to it.
import { decodeJwt } from '../oidc.js';
import { CLOAKTAIL } from '../migration.js';
import { DEMO_PASSWORD, isMigrated } from '../legacyUsers.js';
import { bankLayout, BANK } from './bank.js';
import {
  esc, icon, alert, card, badge, none, code, copyable, kv, time, codeBlock, tabs, emptyState,
  prettyXml, initials, displayName, protocolBadge,
} from './ui.js';

const first = (v) => (Array.isArray(v) ? v[0] : v);

// ---------- sign-in page ----------

// What the sign-in card offers for each protocol.
const PROTOCOLS = {
  oidc: {
    label: 'OpenID Connect',
    signIn: '/oidc/login',
    signUp: '/oidc/signup',
    force: '/oidc/login?prompt=login',
  },
  saml: {
    label: 'SAML 2.0',
    signIn: '/login',
    signUp: '/signup',
    force: '/login?forceAuthn=1',
  },
};

function protocolChoice(available, chosen) {
  return `<div><p class="choice-label" id="via-label">Sign in using</p>
    <div class="segmented" role="group" aria-labelledby="via-label">${Object.entries(PROTOCOLS).map(([key, p]) => {
      if (!available.includes(key)) return `<span aria-disabled="true" title="Not set up yet: see the admin console">${p.label}<small>· not set up</small></span>`;
      return `<a href="/?via=${key}"${key === chosen ? ' aria-current="true"' : ''}>${p.label}</a>`;
    }).join('')}</div></div>`;
}

function signInCard({ ready, active, via }) {
  const available = ['oidc', 'saml'].filter((p) => ready[p]);
  const chosen = available.includes(via) ? via : available[0];
  const legacy = `<div class="or">or</div>
    <a class="btn lg block" href="/legacy">${icon('key')}Sign in with your old Online Banking ID</a>
    <p class="hint" style="margin-top:-8px">For customers who haven't moved to the new sign-in yet. You'll upgrade your account once.</p>`;

  if (!chosen) {
    return `<section class="signin-card" aria-labelledby="signin-title">
      <div><span class="eyebrow dark">Online Banking</span><h2 class="display" id="signin-title">Sign in</h2></div>
      ${alert('warn', 'Sign-in isn\'t connected yet', ['An administrator needs to register this app in CloakTail and copy its settings into the admin console (SAML 2.0 or OpenID Connect).'])}
      <a class="btn primary lg block" href="/admin">${icon('sliders')}Open the admin console</a>
      ${legacy}
    </section>`;
  }

  const p = PROTOCOLS[chosen];
  const idpInitiated = chosen === 'saml' && active.idp.initiatedUrl
    ? `<li><a href="${esc(active.idp.initiatedUrl)}">Start at Keycloak</a> (IdP-initiated login)</li>` : '';
  return `<section class="signin-card" aria-labelledby="signin-title">
    <div><span class="eyebrow dark">Online Banking</span><h2 class="display" id="signin-title">Sign in</h2></div>
    <p>You'll continue to ${BANK}'s secure sign-in page, then come straight back here.</p>
    ${protocolChoice(available, chosen)}
    <a class="btn primary lg block" href="${p.signIn}">${icon('lock')}Sign in securely</a>
    <a class="btn lg block" href="${p.signUp}">${icon('userPlus')}Open an account</a>
    <details class="more testers"><summary>More options for testers</summary>
      <ul>
        <li><a href="${p.force}">Always ask for the password</a> (${chosen === 'saml' ? '<code>ForceAuthn</code>' : '<code>prompt=login</code>'}), even with a Keycloak session</li>
        ${idpInitiated}
        <li>Test users are created in CloakTail under <em>Test users</em>. <em>Open an account</em> needs registration on in the realm.</li>
      </ul>
    </details>
    ${legacy}
    <p class="trust">${icon('shieldCheck')}<span>${BANK} never sees your password: you type it at Keycloak, which sends back a signed ${chosen === 'saml' ? 'assertion' : 'ID token'}.</span></p>
  </section>`;
}

const JOURNEY = [
  ['Choose how to sign in', 'OpenID Connect or SAML 2.0, the two kinds of application CloakTail registers.'],
  ['Authenticate at Keycloak', 'You\'re sent to the bank\'s identity provider to enter your credentials.'],
  ['Come back signed in', 'The app checks the signed response, creates or updates your local profile, and opens your accounts.'],
];

function landing(data) {
  return `<div class="stack-lg">
    <div class="hero">
      <section class="hero-panel" aria-labelledby="hero-title">
        <span class="eyebrow">Demo · CloakTail test app</span>
        <h1 class="display" id="hero-title">Online banking, signed in through Keycloak.</h1>
        <p>${BANK} is a pretend bank used to test CloakTail end to end. Customers sign in here. An administrator connects the app to Keycloak in the <a href="/admin">admin console</a>, using only what CloakTail's application page shows.</p>
        <ol class="journey">${JOURNEY.map(([t, d]) => `<li><div><strong>${t}</strong><span>${d}</span></div></li>`).join('')}</ol>
      </section>
      ${signInCard(data)}
    </div>
    <section aria-labelledby="who-title">
      <div class="section-title"><h2 class="display" id="who-title">Who uses this app</h2></div>
      <div class="audiences">
        <div class="audience"><span class="proto-icon accent">${icon('users')}</span><h3>Customers</h3>
          <p>Sign in with Keycloak using <em>Sign in securely</em>, or open an account. You land on your accounts page with the details of the sign-in.</p></div>
        <div class="audience"><span class="proto-icon accent">${icon('key')}</span><h3>Customers from before Keycloak</h3>
          <p>Use the <a href="/legacy">old Online Banking ID</a>. The first time, your account moves to Keycloak through CloakTail; after that you sign in with Keycloak.</p></div>
        <div class="audience admin"><span class="proto-icon gold">${icon('sliders')}</span><h3>Administrators</h3>
          <p>Register the app in CloakTail, then set up SAML, OpenID Connect, certificates and user migration in the <a href="/admin">admin console</a>.</p></div>
      </div>
    </section>
  </div>`;
}

// ---------- signed in ----------

const DEMO_ACCOUNTS = [
  { label: 'Everyday account', icon: 'wallet', amount: '$4,250.18', num: '•••• 4821', feature: true },
  { label: 'Savings', icon: 'trend', amount: '$18,903.55', num: '•••• 9034' },
  { label: 'Credit card', icon: 'card', amount: '−$612.40', num: '•••• 1177' },
];

const accounts = `<section aria-labelledby="accounts-title">
  <div class="section-title"><h2 class="display" id="accounts-title">Your accounts</h2>${badge('Demo data', 'warn')}</div>
  <div class="accounts">${DEMO_ACCOUNTS.map((a) => `<div class="account${a.feature ? ' feature' : ''}">
    <span class="label">${icon(a.icon)}${a.label}</span>
    <div class="amount">${a.amount}</div><span class="num">${a.num}</span></div>`).join('')}</div>
</section>`;

function firstName(user) {
  if (user.protocol === 'legacy') return (user.name || user.username).split(' ')[0];
  if (user.protocol === 'oidc') return user.claims?.given_name || user.userinfo?.given_name || displayName(user);
  return first(user.attributes?.firstName) || first(user.attributes?.givenName) || displayName(user);
}

function greeting(user, secondary) {
  return `<div class="greeting"><div>
      <h1 class="display">Welcome back, ${esc(firstName(user))}</h1>
      ${secondary ? `<p>${esc(secondary)}</p>` : ''}</div>
    <div class="row">${protocolBadge(user.protocol)}<span class="badge outline">Signed in ${time(user.signedInAt)}</span></div></div>`;
}

function expectedMissing(names, received) {
  return names.filter((n) => !Object.hasOwn(received, n));
}

function expectedCheck(names, missing, noun) {
  if (!names.length) return '';
  return missing.length
    ? alert('warn', `Expected ${noun} not received`, [missing.map((m) => `<code>${esc(m)}</code>`).join(', ')])
    : alert('ok', `Every expected ${noun.replace(/s$/, '')} was received`, [names.map((m) => `<code>${esc(m)}</code>`).join(', ')]);
}

const TIME_CLAIMS = ['exp', 'iat', 'nbf', 'auth_time', 'updated_at'];

function claimValue(key, v) {
  if (TIME_CLAIMS.includes(key) && typeof v === 'number') {
    return `<code>${v}</code><small>${time(new Date(v * 1000).toISOString())}</small>`;
  }
  if (v !== null && typeof v === 'object') return `<code>${esc(JSON.stringify(v))}</code>`;
  return `<code>${esc(v)}</code>`;
}

const claimsList = (obj, emptyText) => {
  const entries = Object.entries(obj ?? {});
  return entries.length
    ? kv(entries.map(([k, v]) => [`<code>${esc(k)}</code>`, claimValue(k, v)]))
    : emptyState('info', emptyText);
};

function profileCard(profile) {
  const body = profile
    ? kv([
      ['Customer since', time(profile.createdAt)],
      ['Last sign-in', time(profile.lastSignInAt)],
      ['Sign-ins', esc(profile.signInCount)],
      ['Email', code(profile.email)],
      ['Name', code([profile.firstName, profile.lastName].filter(Boolean).join(' '))],
    ])
    : alert('warn', 'No local profile', ['The Name ID is transient, so this sign-in can\'t be tied to a returning customer. Use a persistent, username or email Name ID format.']);
  return card({
    iconHtml: `<span class="proto-icon accent">${icon('users')}</span>`,
    title: 'Your profile at ' + BANK,
    description: 'Created the first time you signed in (just-in-time provisioning) and updated on every sign-in. Your password stays in Keycloak.',
    body,
  });
}

function securityCard(user, active) {
  const isOidc = user.protocol === 'oidc';
  const signOutHint = isOidc
    ? 'Sign out ends this session, then Keycloak\'s (RP-initiated logout).'
    : active.idp.sloUrl ? 'Sign out ends this session, then Keycloak\'s (SAML single logout).' : 'No single logout URL is set: sign out ends this session only.';
  const flow = isOidc
    ? (user.usedPkce ? 'Authorization code + PKCE' : 'Authorization code')
    : (user.inResponseTo ? 'Started here (SP-initiated)' : 'Started at Keycloak (IdP-initiated)');
  return card({
    iconHtml: `<span class="proto-icon accent">${icon('shieldCheck')}</span>`,
    title: 'Sign-in and security',
    description: 'How this session was established.',
    body: kv([
      ['Signed in with', `${isOidc ? 'OpenID Connect' : 'SAML 2.0'} at Keycloak`],
      ['Flow', esc(flow)],
      ['Identity provider', code(user.issuer)],
      ['Signed in', time(user.signedInAt)],
    ]),
    foot: `<div class="row">
        <form class="inline" method="post" action="/logout"><button class="btn primary" title="${esc(signOutHint)}">${icon('logout')}Sign out</button></form>
        <form class="inline" method="post" action="/logout/local"><button class="btn" title="Keeps the Keycloak session, so the next sign-in is silent">Sign out of ${BANK} only</button></form>
        <a class="btn" href="${isOidc ? '/oidc/login?prompt=login' : '/login?forceAuthn=1'}">${icon('userPlus')}Switch user</a>
        ${isOidc && user.tokens.refreshToken ? `<form class="inline" method="post" action="/oidc/refresh"><button class="btn">${icon('refresh')}Refresh tokens</button></form>` : ''}
      </div>
      <span class="small muted">${signOutHint}</span>`,
  });
}

function tokenSection(label, token, { expiresAt, note } = {}) {
  if (!token) return '';
  const decoded = decodeJwt(token);
  return `<div class="stack" style="margin-bottom:24px">
    <div class="row" style="justify-content:space-between"><h3>${label}</h3>
      ${expiresAt ? `<span class="small muted">Expires ${time(expiresAt)}</span>` : ''}</div>
    ${note ? `<p class="hint" style="margin:0">${note}</p>` : ''}
    ${decoded ? codeBlock('Payload (decoded, not verified here)', JSON.stringify(decoded.payload, null, 2)) : ''}
    <details class="more"><summary>${decoded ? 'Header and raw token' : 'Raw token'}</summary>
      ${decoded ? codeBlock('Header', JSON.stringify(decoded.header, null, 2)) : ''}
      ${codeBlock('Raw', token)}
    </details></div>`;
}

function samlTabs(user, active) {
  const attrs = Object.entries(user.attributes);
  return tabs('Sign-in details', [
    {
      id: 'attributes', label: 'Attributes', count: attrs.length,
      content: attrs.length
        ? kv(attrs.map(([k, v]) => [`<code>${esc(k)}</code>`, code([].concat(v).join(', '))]))
        : emptyState('info', 'No attributes received', 'Add mappers to the client in the portal.'),
    },
    {
      id: 'details', label: 'Assertion details',
      content: kv([
        ['Name ID', copyable(user.nameID, 'Name ID')],
        ['Name ID format', code(user.nameIDFormat)],
        ['Session index', code(user.sessionIndex)],
        ['Issuer', code(user.issuer)],
        ['Flow', user.inResponseTo
          ? `SP-initiated<small>InResponseTo <code>${esc(user.inResponseTo)}</code></small>`
          : 'IdP-initiated<small>No InResponseTo</small>'],
        ['Signed in', time(user.signedInAt)],
      ]),
    },
    { id: 'assertion', label: 'Assertion XML', content: codeBlock(`Assertion${active.sp.decryptAssertions ? ' (decrypted)' : ''}`, prettyXml(user.assertionXml)) },
    { id: 'response', label: 'Response XML', content: codeBlock('SAML Response, as received', prettyXml(user.responseXml)) },
  ]);
}

function oidcTabs(user) {
  const t = user.tokens;
  return tabs('Sign-in details', [
    { id: 'claims', label: 'ID token claims', count: Object.keys(user.claims).length, content: claimsList(user.claims, 'No claims') },
    {
      id: 'userinfo', label: 'Userinfo', count: user.userinfo ? Object.keys(user.userinfo).length : null,
      content: user.userinfoError
        ? alert('bad', 'The userinfo request failed', [esc(user.userinfoError)])
        : claimsList(user.userinfo, 'No userinfo'),
    },
    {
      id: 'tokens', label: 'Tokens',
      content: `${kv([
        ['Token type', code(t.tokenType)],
        ['Granted scope', code(t.scope)],
        user.refreshedAt && ['Last refreshed', time(user.refreshedAt)],
      ])}<hr class="divider">
        ${tokenSection('ID token', t.idToken)}
        ${tokenSection('Access token', t.accessToken, { expiresAt: t.expiresAt })}
        ${tokenSection('Refresh token', t.refreshToken, { expiresAt: t.refreshExpiresAt, note: 'Opaque to the app; Keycloak happens to issue a JWT.' })}`,
    },
    {
      id: 'details', label: 'Session details',
      content: kv([
        ['Subject (sub)', copyable(user.subject, 'subject')],
        ['Issuer', code(user.issuer)],
        ['Session ID (sid)', code(user.sid)],
        ['Flow', esc(user.flow)],
        ['Signed in', time(user.signedInAt)],
      ]),
    },
  ]);
}

// What Keycloak sent, for the developer testing the app. Collapsed so the bank page reads as one.
function developerPanel(user, active) {
  const isOidc = user.protocol === 'oidc';
  const names = isOidc ? active.oidc.expectedClaims : active.sp.expectedAttributes;
  const received = isOidc ? { ...user.userinfo, ...user.claims } : user.attributes;
  const noun = isOidc ? 'claims' : 'attributes';
  const missing = expectedMissing(names, received);
  const summaryBadge = names.length
    ? (missing.length ? badge(`${missing.length} expected ${missing.length === 1 ? noun.replace(/s$/, '') : noun} missing`, 'warn') : badge(`Expected ${noun} received`, 'ok'))
    : '';
  return `<details class="dev-panel" id="developer">
    <summary>${icon('code')}<strong>Developer view</strong><span class="small muted">What Keycloak sent: ${isOidc ? 'claims, userinfo and tokens' : 'attributes, Name ID and XML'}</span>${summaryBadge}${icon('back', 'chev')}</summary>
    <div class="dev-body">
      ${expectedCheck(names, missing, noun)}
      ${card({ body: isOidc ? oidcTabs(user) : samlTabs(user, active), bodyClass: '' })}
    </div>
  </details>`;
}

function dashboard({ user, profile, active }) {
  const isOidc = user.protocol === 'oidc';
  const name = displayName(user);
  const secondary = isOidc ? [user.email, user.username].filter((v) => v && v !== name).join(' · ') : (user.email !== name ? user.email : '');
  return `<div class="stack-lg">
    ${greeting(user, secondary)}
    ${accounts}
    ${ploverCard}
    <div class="grid-2">${securityCard(user, active)}${profileCard(profile)}</div>
    ${developerPanel(user, active)}
  </div>`;
}

// ---------- partner site, after signing in again ----------

export const PLOVER_URL = 'https://www.plovertrip.com/';

const ploverCard = `<section aria-labelledby="partners-title">
  <div class="section-title"><h2 class="display" id="partners-title">Partner offers</h2></div>
  ${card({
    iconHtml: `<span class="proto-icon gold">${icon('globe')}</span>`,
    title: 'Plover Trip',
    description: 'Plan and book your next trip with our travel partner.',
    body: `<p class="small muted">For your security, you'll confirm it's you at our secure sign-in page, with your one-time code, before you leave ${BANK}.</p>`,
    foot: `<a class="btn primary" href="/plover">${icon('external')}Go to Plover Trip</a>`,
  })}
</section>`;

// Legacy customers have no Keycloak sign-in to repeat: they confirm with their old password.
export function ploverReauthPage(data) {
  const { user, error, locked } = data;
  const form = locked
    ? alert('bad', 'Too many incorrect passwords', [`Try again in ${esc(locked)}.`])
    : `<form method="post" action="/plover/legacy" class="stack">
        <div class="login-who"><span class="avatar">${esc(initials(user.username))}</span><code>${esc(user.username)}</code></div>
        <div class="field${error ? ' invalid' : ''}"><label for="f-password">Password</label>
          <input id="f-password" name="password" type="password" class="input" autocomplete="current-password" required autofocus${error ? ' aria-invalid="true" aria-describedby="f-password-error"' : ''}>
          ${error ? `<p class="error" id="f-password-error">${icon('bad')}<span>${esc(error)}</span></p>` : ''}</div>
        <button class="btn primary lg block">${icon('shieldCheck')}Confirm and continue to Plover Trip</button>
      </form>`;
  return bankLayout({
    ...data,
    title: 'Confirm it\'s you',
    body: `<div class="narrow">
      <a class="back-link" href="/">${icon('back')}Back to your accounts</a>
      <section class="signin-card" aria-labelledby="reauth-title">
        <div><span class="eyebrow dark">Extra security</span>
          <h2 class="display" id="reauth-title">Confirm it's you</h2></div>
        <p>You're leaving ${BANK} for our partner Plover Trip. Enter your password to continue.</p>
        ${form}
      </section>
    </div>`,
  });
}

// Why account upgrades are off, in admin terms: tucked away so customers aren't shown config jargon.
const adminWhy = (problems) => `<details class="more small"><summary>Why? (for administrators)</summary>
  <ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
  <p>Fix it in the <a href="/admin/migrate">admin console</a>.</p></details>`;

// Signed in the old way: with the legacy password, no Keycloak.
function legacyDashboard({ user }) {
  const outcome = user.migration;
  const kind = { created: 'ok', conflict: 'bad', blocked: 'warn' }[outcome?.status] ?? 'info';
  const sessionNote = outcome?.status === 'created'
    ? 'You signed in with your old password while your account moved to Keycloak. Next time, sign in securely with Keycloak.'
    : 'A legacy session: no Keycloak account is involved.';
  return `<div class="stack-lg">
    ${greeting(user, user.email)}
    ${outcome ? alert(kind, esc(outcome.title), [esc(outcome.message)]) : ''}
    ${outcome?.adminDetail?.length ? adminWhy(outcome.adminDetail) : ''}
    ${accounts}
    ${ploverCard}
    <div class="grid-2">
      ${card({
        iconHtml: `<span class="proto-icon legacy">${icon('key')}</span>`,
        title: 'Sign-in and security',
        description: 'How this session was established.',
        body: kv([
          ['Signed in with', 'Old Online Banking ID and password'],
          ['Signed in', time(user.signedInAt)],
        ]),
        foot: `<form class="inline" method="post" action="/logout"><button class="btn primary">${icon('logout')}Sign out</button></form>
          <span class="small muted">${sessionNote}</span>`,
      })}
      ${card({
        iconHtml: `<span class="proto-icon legacy">${icon('users')}</span>`,
        title: 'Legacy account',
        description: 'The account in the app\'s own user table.',
        body: kv([
          ['User ID (sub)', code(user.id)],
          ['Username', code(user.username)],
          ['Email', code(user.email)],
          ['Account upgrade', outcome?.status ? code(outcome.status) : none('Not attempted')],
        ]),
      })}
    </div>
  </div>`;
}

export function homePage(data) {
  const { user } = data;
  let body;
  if (!user) body = landing(data);
  else if (user.protocol === 'legacy') body = legacyDashboard(data);
  else body = dashboard(data);
  return bankLayout({ ...data, title: user ? 'Your accounts' : 'Sign in', body });
}

// ---------- legacy sign-in ----------

export function legacyPage(data) {
  const { step, username, problems, users } = data;
  const isPassword = step === 'password';
  const form = isPassword
    ? `<form method="post" action="/legacy/login" class="stack">
        <div class="login-who"><span class="avatar">${esc(initials(username))}</span><code>${esc(username)}</code>
          <a class="btn ghost sm" href="/legacy/restart">${icon('back')}Change</a></div>
        <input type="hidden" name="username" value="${esc(username)}">
        <div class="field"><label for="f-password">Password</label>
          <input id="f-password" name="password" type="password" class="input" autocomplete="current-password" required autofocus></div>
        <button class="btn primary lg block">${icon('login')}Sign in</button>
      </form>`
    : `<form method="post" action="/legacy/identify" class="stack">
        <div class="field"><label for="f-username">Online Banking ID</label>
          <input id="f-username" name="username" class="input" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(username ?? '')}" required autofocus>
          <p class="hint">If your account has already moved to the new sign-in, we'll take you there.</p></div>
        <button class="btn primary lg block">Continue${icon('arrow')}</button>
      </form>`;

  const notReady = problems.length
    ? `${alert('info', 'Account upgrades are switched off', ['You\'ll sign in the old way this time.'])}${adminWhy(problems)}`
    : '';

  return bankLayout({
    ...data,
    title: 'Sign in with your Online Banking ID',
    body: `<div class="narrow">
      <a class="back-link" href="/">${icon('back')}All sign-in options</a>
      <section class="signin-card" aria-labelledby="legacy-title">
        <div><span class="eyebrow dark">Existing customers</span>
          <h2 class="display" id="legacy-title">${isPassword ? 'Enter your password' : 'Sign in with your Online Banking ID'}</h2></div>
        <p>${isPassword ? 'Use the password you\'ve always used with us.' : `We're moving ${BANK} to a new, more secure sign-in. Sign in as usual: if your account hasn't moved yet, you'll choose a new password once.`}</p>
        ${form}
      </section>
      ${notReady}
      <div class="demo-creds"><strong>${icon('info')} Demo customers</strong>
        Password <code>${esc(DEMO_PASSWORD)}</code> for every seeded account.
        <div class="row">${users.map((u) => `<span class="badge outline">${esc(u.username)} · ${isMigrated(u) ? 'moved to Keycloak' : u.conflict ? 'conflict' : 'not moved'}</span>`).join('')}</div>
      </div>
    </div>`,
  });
}

// ---------- hand-off to CloakTail ----------

// An auto-submitted form POST keeps the request out of logs and browser history (spec).
export function redirectToCloakTail({ token, user }) {
  return bankLayout({
    title: 'Upgrading your account',
    showUser: false,
    head: '<meta name="referrer" content="no-referrer">',
    body: `<div class="narrow"><section class="signin-card handoff">
      <span class="spinner" aria-hidden="true"></span>
      <h1 class="display">Upgrading your account</h1>
      <p>Hi ${esc(user.firstName || user.username)}, we're moving sign-in to our new identity service. You'll confirm your details and choose a new password, then come straight back.</p>
      <form id="handoff" method="post" action="${esc(CLOAKTAIL.startUrl)}">
        <input type="hidden" name="request" value="${esc(token)}">
        <button class="btn primary lg">Continue${icon('arrow')}</button>
      </form>
      <p class="small">You're not signed in until this is done.</p>
    </section></div>
    <script>setTimeout(() => document.getElementById('handoff').submit(), 600);</script>`,
  });
}

// ---------- errors ----------

export function errorPage({ status, message }) {
  return bankLayout({
    title: status === 404 ? 'Not found' : 'Error',
    showUser: false,
    body: `<div class="narrow">${card({
      body: emptyState(status === 404 ? 'info' : 'bad', status === 404 ? 'Page not found' : 'Something went wrong',
        `<code>${esc(message)}</code>`, `<div class="row"><a class="btn primary" href="/">${icon('home')}Back to ${BANK}</a><a class="btn" href="/admin">Admin console</a></div>`),
    })}</div>`,
  });
}
