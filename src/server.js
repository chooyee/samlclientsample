import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as SamlStrategy, ValidateInResponseTo } from '@node-saml/passport-saml';
import { config } from './config.js';
import { idpCertCallback, loadIdpCerts, clearIdpCertCache } from './idpCerts.js';
import {
  getSettings, saveSettings, saveBaseUrl, resetSettings, resolve, isConfigured, parsePortalConfig, parsePortalOidcConfig, SettingsError,
} from './settings.js';
import { loadKeyPair, generateKeyPair, isKind, certBase64, KEY_SIZES, VALIDITY_YEARS } from './certs.js';
import { provision, getProfile, listProfiles, clearProfiles } from './users.js';
import * as oidc from './oidc.js';
import * as migration from './migration.js';
import * as legacy from './legacyUsers.js';
import * as assistant from './assistant.js';
import * as credentials from './apiCredentials.js';
import * as files from './files.js';
import * as engine from './workflow/engine.js';
import * as registration from './workflow/registration.js';
import * as userMigration from './workflow/userMigration.js';
import { DEFINITIONS, REGISTRATION, USER_MIGRATION } from './workflow/definitions.js';
import { adminHomePage, samlPage, oidcPage, certsPage, usersPage } from './views/pages.js';
import { migrationPage } from './views/migration.js';
import { apiCredentialsPage } from './views/apiCredentials.js';
import { workflowsPage, runPage } from './views/workflow.js';
import { architecturePage } from './views/architecture.js';
import { homePage, legacyPage, redirectToCloakTail, errorPage } from './views/customer.js';
import { documentsPage } from './views/documents.js';

// ---------- key pairs ----------

const keys = { signing: null, encryption: null };
const keyErrors = { signing: null, encryption: null };

function reloadKeys() {
  for (const kind of Object.keys(keys)) {
    try {
      keys[kind] = loadKeyPair(kind);
      keyErrors[kind] = null;
    } catch (err) {
      keys[kind] = null;
      keyErrors[kind] = err.message;
    }
  }
}

// Creates a key pair for each enabled feature that doesn't have one yet. Returns the kinds created.
async function ensureKeys(sp) {
  const needed = [sp.signRequests && 'signing', sp.decryptAssertions && 'encryption'].filter((k) => k && !keys[k]);
  for (const kind of needed) {
    await generateKeyPair(kind, { commonName: `${sp.entityId} ${kind}` });
    console.log(`Generated the ${kind} key pair (${config.keyFiles[kind].cert}).`);
  }
  reloadKeys();
  return needed;
}

// ---------- sessions ----------

const sessionStore = new session.MemoryStore();

// Destroys the sessions whose user matches, for IdP-initiated logout. Returns how many.
function destroySessions(predicate) {
  return new Promise((resolve, reject) => {
    sessionStore.all((err, sessions) => {
      if (err) return reject(err);
      const ids = Object.entries(sessions || {})
        .filter(([, s]) => s?.passport?.user && predicate(s.passport.user))
        .map(([id]) => id);
      Promise.all(ids.map((id) => new Promise((done) => sessionStore.destroy(id, done)))).then(() => resolve(ids.length));
    });
  });
}

const isOidcUser = (user) => user?.protocol === 'oidc';

// ---------- SAML ----------

// AuthnRequest IDs for InResponseTo checks, shared by both strategies below and across
// rebuilds (node-saml's default cache is per instance).
const REQUEST_TTL_MS = 10 * 60 * 1000;
const requestIds = new Map();
const cacheProvider = {
  async saveAsync(key, value) {
    for (const [k, v] of requestIds) if (Date.now() - v.createdAt > REQUEST_TTL_MS) requestIds.delete(k);
    const item = { value, createdAt: Date.now() };
    requestIds.set(key, item);
    return item;
  },
  async getAsync(key) {
    const item = requestIds.get(key);
    return item && Date.now() - item.createdAt < REQUEST_TTL_MS ? item.value : null;
  },
  async removeAsync(key) {
    const item = requestIds.get(key);
    requestIds.delete(key);
    return item?.value ?? null;
  },
};

const first = (v) => (Array.isArray(v) ? v[0] : v);

function signOnVerify(req, profile, done) {
  done(null, {
    protocol: 'saml',
    nameID: profile.nameID,
    nameIDFormat: profile.nameIDFormat,
    sessionIndex: profile.sessionIndex,
    issuer: profile.issuer,
    inResponseTo: profile.inResponseTo || null,
    attributes: profile.attributes || {},
    email: first(profile.attributes?.email) || null,
    assertionXml: profile.getAssertionXml?.() || '',
    responseXml: profile.getSamlResponseXml?.() || '',
    signedInAt: new Date().toISOString(),
  });
}

// Keycloak front-channel logout. Find sessions in the store; the request may arrive without our cookie.
// Returning req.user when it is the same user lets passport-saml answer with a Success LogoutResponse.
function logoutVerify(req, profile, done) {
  const matches = (u) => !isOidcUser(u) && u.nameID === profile.nameID
    && (!profile.sessionIndex || u.sessionIndex === profile.sessionIndex);
  const current = req.user && matches(req.user) ? req.user : profile;
  destroySessions(matches).then((n) => {
    console.log(`SAML IdP-initiated logout for ${profile.nameID}: ${n} session(s) ended`);
    done(null, current);
  }, done);
}

let strategy;
let active; // { baseUrl, sp, idp, oidc, migration, signing, encryption } the app is running with

// (Re)creates the strategies from the current settings and key pairs.
function buildStrategies() {
  const { baseUrl, sp, idp, oidc: oidcSettings, migration: migrationSettings } = resolve();
  const signing = sp.signRequests ? keys.signing : null;
  const encryption = sp.decryptAssertions ? keys.encryption : null;
  const samlOptions = {
    entryPoint: idp.ssoUrl,
    logoutUrl: idp.sloUrl || undefined,
    issuer: sp.entityId,
    callbackUrl: sp.acsUrl,
    logoutCallbackUrl: sp.sloUrl,
    idpCert: idp.cert || idpCertCallback(idp.metadataUrl),
    idpIssuer: idp.entityId,
    audience: sp.entityId,
    identifierFormat: sp.nameIdFormat,
    wantAuthnResponseSigned: sp.wantResponseSigned,
    wantAssertionsSigned: sp.wantAssertionsSigned,
    privateKey: signing?.key,
    publicCert: signing?.cert,
    signatureAlgorithm: 'sha256',
    decryptionPvk: encryption?.key,
    disableRequestedAuthnContext: true,
    // Checks InResponseTo for SP-initiated logins but still allows IdP-initiated SSO.
    validateInResponseTo: ValidateInResponseTo.ifPresent,
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    cacheProvider,
    acceptedClockSkewMs: 5000,
    passReqToCallback: true,
  };
  strategy = new SamlStrategy(samlOptions, signOnVerify, logoutVerify);
  passport.use('saml', strategy);
  // Same settings with ForceAuthn, so "sign in as someone else" always shows Keycloak's form.
  passport.use('saml-force', new SamlStrategy({ ...samlOptions, forceAuthn: true }, signOnVerify, logoutVerify));
  active = { baseUrl, sp, idp, oidc: oidcSettings, migration: migrationSettings, signing, encryption };
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

reloadKeys();
await ensureKeys(resolve().sp);
buildStrategies();
migration.ensureSigningKey();

// What stops users from migrating now, as sentences. Empty when ready.
const migrationProblems = () => migration.problems(active.migration, { protocolReady: isConfigured(active.migration.protocol) });

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(session({
  name: 'testsp.sid',
  secret: config.sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  // Set from the base URL at startup: switching it between http and https needs a restart.
  cookie: { httpOnly: true, sameSite: 'lax', secure: active.baseUrl.startsWith('https://'), maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(passport.session());

// kind: 'ok' | 'warn' | 'bad'. notes: further lines shown under the message.
const setFlash = (req, kind, message, notes = []) => { req.session.flash = { kind, message, notes }; };

// The settings and key routes change how the app behaves for everyone, so refuse cross-site posts.
function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin && origin !== 'null') {
    try {
      if (new URL(origin).host === req.get('host')) return next();
    } catch { /* fall through */ }
    return res.status(403).type('text').send('Cross-origin request refused.');
  }
  next();
}

// Admin pages show how many workflow runs wait for the admin, in the nav.
app.use('/admin', async (req, res, next) => {
  if (req.method === 'GET') res.locals.waiting = (await engine.waitingForAdmin()).length;
  next();
});

// Renders a page with what every page needs, and consumes the one-time flash and form draft.
function render(req, res, page, data = {}) {
  const { flash, draft } = req.session ?? {};
  if (flash) delete req.session.flash;
  if (draft) delete req.session.draft;
  res.set('Cache-Control', 'no-store').type('html').send(page({
    path: req.path,
    user: req.user,
    flash,
    draft,
    ready: { saml: isConfigured('saml'), oidc: isConfigured('oidc'), migration: !migrationProblems().length },
    waiting: res.locals.waiting ?? 0,
    active,
    ...data,
  }));
}

// ---------- pages ----------

// Customer site (Acme Bank): sign-in page, or the signed-in dashboard. ?via= picks the protocol.
app.get('/', (req, res) => render(req, res, homePage, { profile: getProfile(req.user), via: req.query.via }));

// Admin console: everything that changes how the app signs customers in.
app.get('/admin', (req, res) => render(req, res, adminHomePage, { keys, profileCount: listProfiles().length }));

app.get('/admin/saml', async (req, res) => render(req, res, samlPage, { settings: getSettings(), keys, assistant: await assistantView(req, 'saml') }));

app.get('/admin/oidc', async (req, res) => {
  render(req, res, oidcPage, { settings: getSettings(), discovery: await oidc.discoveryStatus(active.oidc), assistant: await assistantView(req, 'oidc') });
});

app.get('/admin/certs', (req, res) => render(req, res, certsPage, { keys, keyErrors }));

app.get('/admin/users', (req, res) => render(req, res, usersPage, { profiles: listProfiles() }));

app.get('/admin/api', (req, res) => render(req, res, apiCredentialsPage, { credentials: credentials.credentialsView() }));

app.get('/admin/architecture', (req, res) => render(req, res, architecturePage, { enabled: assistant.isEnabled(), model: config.gemini.model }));

// The admin pages used to live at the top level.
for (const page of ['saml', 'oidc', 'certs', 'users', 'migrate']) {
  app.get(`/${page}`, (req, res) => res.redirect(`/admin/${page}`));
}

// ---------- sign-in ----------

function welcome(req, user, label) {
  const result = provision(user);
  if (!result) {
    setFlash(req, 'warn', `Signed in as ${label}.`, ['No local profile: a transient Name ID can\'t identify a returning user.']);
  } else {
    setFlash(req, 'ok', result.created ? `Welcome, ${label}. First sign-in: local profile created.` : `Signed in as ${label}.`);
  }
  const linked = legacy.findByKeycloakUser(user);
  if (linked) {
    const first = legacy.recordKeycloakSignIn(linked.id);
    migration.logEvent('keycloak', { user: linked.username, detail: first ? 'first Keycloak sign-in after migration' : 'migrated user' });
    req.session.flash.notes.push(first
      ? `Account upgraded: legacy user ${linked.username} (id ${linked.id}) now signs in with Keycloak.`
      : `Migrated legacy user ${linked.username} (id ${linked.id}).`);
  }
}

function requireConfigured(section) {
  return (req, res, next) => {
    if (isConfigured(section)) return next();
    setFlash(req, 'warn', `${section === 'saml' ? 'SAML' : 'OpenID Connect'} sign-in isn't set up yet.`,
      ['An administrator can set it up in the admin console, from the CloakTail application page.']);
    res.redirect('/');
  };
}

// SP-initiated SSO.
app.get('/login', requireConfigured('saml'), (req, res, next) => {
  passport.authenticate(req.query.forceAuthn ? 'saml-force' : 'saml')(req, res, next);
});

// Sign up: registration belongs to Keycloak. ForceAuthn makes sure its login form (with the
// "Register" link, when the realm allows user registration) shows even with an SSO session.
// The new account comes back through the ACS like any sign-in and is provisioned there.
app.get('/signup', requireConfigured('saml'), (req, res, next) => {
  passport.authenticate('saml-force')(req, res, next);
});

// Assertion Consumer Service.
app.post('/saml/acs', (req, res, next) => {
  passport.authenticate('saml', (err, user) => {
    if (err || !user) {
      const message = err?.message || 'No user returned';
      console.error('SAML login failed:', message);
      req.session.regenerate(() => {
        setFlash(req, 'bad', 'SAML sign-in failed.', [message]);
        res.redirect('/');
      });
      return;
    }
    req.session.regenerate((regenErr) => {
      if (regenErr) return next(regenErr);
      req.login(user, { keepSessionInfo: false }, (loginErr) => {
        if (loginErr) return next(loginErr);
        welcome(req, user, user.nameID);
        res.redirect('/');
      });
    });
  })(req, res, next);
});

// OIDC sign-in. Pending sign-ins are kept per state, so two tabs can sign in at once.
const PENDING_MAX = 5;

async function oidcSignIn(req, res, prompt, loginHint) {
  try {
    const { url, pending } = await oidc.startSignIn(active.oidc, { prompt, loginHint });
    const kept = Object.entries(req.session.oidcPending ?? {})
      .filter(([, p]) => Date.now() - p.startedAt < REQUEST_TTL_MS)
      .slice(-(PENDING_MAX - 1));
    req.session.oidcPending = Object.fromEntries([...kept, [pending.state, pending]]);
    res.redirect(url);
  } catch (err) {
    setFlash(req, 'bad', 'Could not start the OpenID Connect sign-in.', [oidc.describeError(err)]);
    res.redirect('/');
  }
}

app.get('/oidc/login', requireConfigured('oidc'), (req, res) => oidcSignIn(req, res, req.query.prompt === 'login' ? 'login' : undefined));

// Same as SAML sign-up: prompt=login shows Keycloak's form, with its "Register" link.
app.get('/oidc/signup', requireConfigured('oidc'), (req, res) => oidcSignIn(req, res, 'login'));

// Redirect URI.
app.get('/oidc/callback', async (req, res, next) => {
  const pending = req.session.oidcPending?.[req.query.state];
  const fail = (message) => req.session.regenerate(() => {
    console.error('OIDC login failed:', message);
    setFlash(req, 'bad', 'OpenID Connect sign-in failed.', [message]);
    res.redirect('/');
  });
  if (!pending) {
    return fail(req.query.error
      ? `${req.query.error}${req.query.error_description ? `: ${req.query.error_description}` : ''}`
      : 'No sign-in in progress for this state: it was started in another browser, or more than 10 minutes ago.');
  }
  delete req.session.oidcPending[req.query.state];

  let user;
  try {
    user = await oidc.finishSignIn(active.oidc, new URL(req.originalUrl, active.baseUrl), pending);
  } catch (err) {
    return fail(oidc.describeError(err));
  }
  req.session.regenerate((regenErr) => {
    if (regenErr) return next(regenErr);
    req.login(user, { keepSessionInfo: false }, (loginErr) => {
      if (loginErr) return next(loginErr);
      welcome(req, user, user.username || user.email || user.subject);
      if (user.userinfoError) req.session.flash.notes.push(`Userinfo request failed: ${user.userinfoError}`);
      res.redirect('/');
    });
  });
});

app.post('/oidc/refresh', async (req, res) => {
  if (!isOidcUser(req.user) || !req.user.tokens.refreshToken) return res.redirect('/');
  try {
    const user = await oidc.refresh(active.oidc, req.user);
    req.login(user, { keepSessionInfo: true }, () => {
      setFlash(req, 'ok', 'Tokens refreshed.');
      res.redirect('/#tokens');
    });
  } catch (err) {
    setFlash(req, 'bad', 'Refresh failed.', [oidc.describeError(err)]);
    res.redirect('/#tokens');
  }
});

// ---------- sign-out ----------

function endLocalSession(req, res, then) {
  req.logout(() => req.session.destroy(() => {
    res.clearCookie('testsp.sid');
    then();
  }));
}

// SP-initiated logout: SAML SLO, or OIDC RP-initiated logout. Ends the local session first.
app.post('/logout', async (req, res, next) => {
  if (!req.user) return res.redirect('/');
  if (req.user.protocol === 'legacy') return endLocalSession(req, res, () => res.redirect('/'));
  if (isOidcUser(req.user)) {
    let url = null;
    try {
      url = await oidc.endSessionUrl(active.oidc, req.user);
    } catch (err) {
      setFlash(req, 'warn', 'Signed out locally only.', [oidc.describeError(err)]);
      return req.logout(() => res.redirect('/'));
    }
    if (!url) {
      setFlash(req, 'warn', 'Signed out locally only: the provider has no end session endpoint.');
      return req.logout(() => res.redirect('/'));
    }
    return endLocalSession(req, res, () => res.redirect(url));
  }
  if (!active.idp.sloUrl) {
    setFlash(req, 'warn', 'Signed out locally only.', ['No single logout URL in the SAML settings (the application page shows one when a logout URL is registered).']);
    return req.logout(() => res.redirect('/'));
  }
  strategy.logout(req, (err, url) => {
    if (err) return next(err);
    endLocalSession(req, res, () => res.redirect(url || '/'));
  });
});

app.post('/logout/local', (req, res) => endLocalSession(req, res, () => res.redirect('/')));

// Single logout endpoint. A LogoutRequest from Keycloak is answered by passport-saml with a
// LogoutResponse redirect; a LogoutResponse (after our /logout) falls through to here.
const hasSamlMessage = (req) => ['SAMLRequest', 'SAMLResponse'].some((k) => req.query?.[k] || req.body?.[k]);
app.all('/saml/slo', (req, res, next) => (hasSamlMessage(req) ? next() : res.redirect('/')),
  passport.authenticate('saml', { session: false }), (req, res) => {
  req.session.regenerate(() => {
    setFlash(req, 'ok', 'Signed out of Keycloak.');
    res.redirect('/');
  });
});

// Post-logout redirect URI, after OIDC RP-initiated logout.
app.get('/oidc/logged-out', (req, res) => {
  req.session.regenerate(() => {
    setFlash(req, 'ok', 'Signed out of Keycloak.');
    res.redirect('/');
  });
});

// OIDC front-channel logout: Keycloak loads this in an iframe with iss and sid, often without
// our cookie, so find the sessions in the store.
app.get('/oidc/frontchannel-logout', async (req, res) => {
  const { iss, sid } = req.query;
  let n = 0;
  if (iss && sid) {
    n = await destroySessions((u) => isOidcUser(u) && u.issuer === iss && u.sid === sid);
    console.log(`OIDC front-channel logout for sid ${sid}: ${n} session(s) ended`);
  }
  res.set('Cache-Control', 'no-store').type('text').send(n ? 'Signed out.' : 'No matching session.');
});

app.get('/saml/metadata', (req, res) => {
  res.type('application/xml').send(strategy.generateServiceProviderMetadata(
    active.encryption?.cert ?? null,
    active.signing?.cert ?? null,
  ));
});

// ---------- settings ----------

// Applies new settings, creates any key pair they need, and checks the IdP is reachable.
// Returns { kind, notes } for the message: kind 'ok' or 'warn'.
async function applySettingsQuietly(sections, apply) {
  apply();
  const notes = [];
  let kind = 'ok';
  if (sections.includes('saml')) {
    clearIdpCertCache();
    const created = await ensureKeys(resolve().sp);
    notes.push(...created.map((k) => `Generated the ${k} key pair: paste its certificate into the portal.`));
  }
  if (sections.includes('oidc')) oidc.clearOidcConfig();
  buildStrategies();

  if (sections.includes('saml') && isConfigured('saml') && !active.idp.cert) {
    try {
      await loadIdpCerts(active.idp.metadataUrl);
    } catch (err) {
      kind = 'warn';
      notes.push(`Could not read the IdP metadata: ${err.cause?.message || err.message}`);
    }
  }
  if (sections.includes('oidc') && isConfigured('oidc')) {
    const status = await oidc.discoveryStatus(active.oidc);
    if (!status.ok) {
      kind = 'warn';
      notes.push(`Could not read the discovery document: ${status.error}`);
    }
  }
  return { kind, notes };
}

async function applySettings(req, sections, apply, label) {
  const { kind, notes } = await applySettingsQuietly(sections, apply);
  setFlash(req, kind, label, notes);
}

function settingsFailed(req, section, body, err, message) {
  req.session.draft = { section, values: { ...body }, errors: err.fields };
  setFlash(req, 'bad', message, err.errors.filter((e) => !e.field || e.field === 'portalConfig').map((e) => e.message));
}

for (const section of ['saml', 'oidc']) {
  app.post(`/${section}/settings`, sameOrigin, async (req, res, next) => {
    try {
      await applySettings(req, [section], () => saveSettings(section, req.body), 'Settings saved.');
    } catch (err) {
      if (!(err instanceof SettingsError)) return next(err);
      settingsFailed(req, section, req.body, err, 'Settings not saved. Check the highlighted fields.');
    }
    res.redirect(`/admin/${section}#settings`);
  });
}

// The base URL, step 1 on both protocol pages. Every URL registered in CloakTail is under it.
app.post('/settings/base-url', sameOrigin, async (req, res, next) => {
  const back = ['/admin/saml', '/admin/oidc'].includes(req.body.back) ? req.body.back : '/admin/saml';
  try {
    await applySettings(req, ['saml', 'oidc'], () => saveBaseUrl(req.body), 'Base URL saved. Check the values to register in CloakTail.');
  } catch (err) {
    if (!(err instanceof SettingsError)) return next(err);
    settingsFailed(req, 'base', req.body, err, 'Base URL not saved.');
  }
  res.redirect(`${back}#base-url`);
});

// Fills the SAML settings from the passport-saml example on the application page.
// Settings the example doesn't name (metadata URL, IdP-initiated link, certificate) are kept.
app.post('/saml/settings/import', sameOrigin, async (req, res, next) => {
  try {
    const found = parsePortalConfig(String(req.body.portalConfig ?? ''));
    await applySettings(req, ['saml'], () => saveSettings('saml', { ...getSettings(), ...found }),
      `Settings filled from the application page (${Object.keys(found).length} values).`);
  } catch (err) {
    if (!(err instanceof SettingsError)) return next(err);
    settingsFailed(req, 'saml-import', req.body, err, 'Settings not changed.');
  }
  res.redirect('/admin/saml#settings');
});

// Fills the OIDC settings from the openid-client example on the application page.
app.post('/oidc/settings/import', sameOrigin, async (req, res, next) => {
  try {
    const { values, notes } = parsePortalOidcConfig(String(req.body.portalConfig ?? ''));
    await applySettings(req, ['oidc'], () => saveSettings('oidc', { ...getSettings(), ...values }),
      `Settings filled from the application page (${Object.keys(values).length} values).`);
    req.session.flash.notes.unshift(...notes);
  } catch (err) {
    if (!(err instanceof SettingsError)) return next(err);
    settingsFailed(req, 'oidc-import', req.body, err, 'Settings not changed.');
  }
  res.redirect('/admin/oidc#settings');
});

app.post('/settings/reset', sameOrigin, async (req, res) => {
  await applySettings(req, ['saml', 'oidc'], resetSettings, 'Settings reset to the .env values.');
  const back = ['/admin/saml', '/admin/oidc'].includes(req.body.back) ? req.body.back : '/admin';
  res.redirect(`${back}#settings`);
});

// ---------- CloakTail API credential (see apiCredentials.js) ----------

function credentialsFailed(req, body, err) {
  if (!(err instanceof credentials.CredentialsError)) throw err;
  const { clientSecret, ...values } = body; // never echo the secret back into the form
  req.session.draft = { section: 'api', values, errors: err.fields };
  setFlash(req, 'bad', err.message, Object.keys(err.fields).length ? ['Check the highlighted fields.'] : []);
}

// "Save" stores the credential; "Save and get access token" also checks it against CloakTail.
app.post('/api-credentials', sameOrigin, async (req, res) => {
  try {
    credentials.saveCredentials(req.body);
    if (req.body.action === 'token') {
      const t = await credentials.getAccessToken({ force: true }).catch((err) => {
        throw new credentials.CredentialsError(`API credential saved, but no access token: ${err.message}`);
      });
      setFlash(req, 'ok', 'API credential saved and an access token obtained.', [t.scope ? `Scopes: ${t.scope}` : 'The token has no scopes.']);
    } else {
      setFlash(req, 'ok', 'API credential saved.');
    }
  } catch (err) {
    credentialsFailed(req, req.body, err);
  }
  res.redirect('/admin/api');
});

app.post('/api-credentials/token', sameOrigin, async (req, res) => {
  try {
    const t = await credentials.getAccessToken({ force: true });
    setFlash(req, 'ok', 'Access token obtained.', [t.scope ? `Scopes: ${t.scope}` : 'The token has no scopes.']);
  } catch (err) {
    credentialsFailed(req, {}, err);
  }
  res.redirect('/admin/api');
});

app.post('/api-credentials/delete', sameOrigin, (req, res) => {
  credentials.deleteCredentials();
  delete req.session.cloaktail; // the assistant can't start a run without it
  setFlash(req, 'ok', 'API credential deleted.');
  res.redirect('/admin/api');
});

// ---------- registration assistant (see assistant.js and workflow/registration.js) ----------

// The assistant runs as a durable workflow (DBOS): one run per conversation, saved in Postgres, so
// it survives restarts and waits for approvals as long as needed. The CloakTail connection (the
// reference URL) is kept in this session until a run starts; the run keeps its own copy.

// How long a page request waits for the run to stop working before showing it as it is.
const RUN_WAIT_MS = 90_000;

// What the agent registers: this app's own values for the protocol, and its current settings.
// User migration, for the assistant: what to register in CloakTail and what is set here.
function migrationValues(protocol) {
  const s = getSettings();
  const m = active.migration;
  const key = migration.signingKeyStatus().key;
  return {
    register_in_cloaktail: {
      return_url: m.returnUrl,
      request_signing: s.migrationRequestSigning,
      jwks_url: m.jwksUrl,
      jwks_key_id: key?.kid ?? 'no key yet',
    },
    request_iss_is_client_id_of: `this app's ${protocol === 'oidc' ? 'OpenID Connect client ID' : 'SAML entity ID'}, once migrationProtocol = "${protocol}"`,
    current_settings: {
      migrationUrl: s.migrationUrl, migrationSecret: s.migrationSecret ? 'set' : '', migrationRequestSigning: s.migrationRequestSigning,
      migrationReturnUrl: s.migrationReturnUrl, migrationProtocol: s.migrationProtocol || 'automatic',
    },
    missing_here: migrationProblems(),
  };
}

function localValues(protocol) {
  const s = getSettings();
  const { sp, oidc: o } = active;
  if (protocol === 'saml') {
    return {
      protocol: 'saml',
      base_url: active.baseUrl,
      sp_entity_id: sp.entityId,
      sp_entity_id_is_default: !s.entityId,
      acs_url: sp.acsUrl,
      single_logout_url: sp.sloUrl,
      home_url: sp.homeUrl,
      sp_metadata_url: sp.metadataUrl,
      name_id_format: sp.nameIdFormat ?? 'any',
      expected_attributes: sp.expectedAttributes,
      require_signed_response: sp.wantResponseSigned,
      require_signed_assertions: sp.wantAssertionsSigned,
      signs_requests: sp.signRequests,
      expects_encrypted_assertions: sp.decryptAssertions,
      signing_certificate_pem: sp.signRequests ? keys.signing?.cert ?? 'missing: save the SAML settings to generate one' : 'not in use',
      encryption_certificate_pem: sp.decryptAssertions ? keys.encryption?.cert ?? 'missing: save the SAML settings to generate one' : 'not in use',
      idp_configured: isConfigured('saml'),
      current_idp_settings: { idpEntityId: s.idpEntityId, idpSsoUrl: s.idpSsoUrl, idpSloUrl: s.idpSloUrl, idpMetadataUrl: s.idpMetadataUrl, idpInitiatedUrl: s.idpInitiatedUrl, idpCert: s.idpCert ? 'pinned' : '' },
      user_migration: migrationValues('saml'),
    };
  }
  return {
    protocol: 'oidc',
    base_url: active.baseUrl,
    redirect_uri: o.redirectUri,
    post_logout_redirect_uri: o.postLogoutRedirectUri,
    frontchannel_logout_uri: o.frontchannelLogoutUri,
    web_origin: o.webOrigin,
    home_url: o.homeUrl,
    uses_pkce: o.usePkce,
    scopes: o.scopes,
    expected_claims: o.expectedClaims,
    client_types_supported: 'confidential (client secret) or public (PKCE)',
    configured: isConfigured('oidc'),
    current_settings: { oidcIssuer: s.oidcIssuer, oidcClientId: s.oidcClientId, oidcClientSecret: s.oidcClientSecret ? 'set' : '' },
    user_migration: migrationValues('oidc'),
  };
}

// What the workflow's steps need from the app.
registration.setHost({
  local: localValues,
  // The outcome goes back to the agent and into the transcript, not to a page-top flash.
  save: async (section, values) => {
    const { notes } = await applySettingsQuietly([section], () => saveSettings(section, { ...getSettings(), ...values }));
    return { saved: Object.keys(values), configured: isConfigured(section), notes };
  },
  // The Migration page's "Check request", for the first legacy user. Creates no users.
  checkMigration: async () => {
    const problems = migrationProblems();
    if (problems.length) return { ok: false, problems };
    const user = legacy.listLegacyUsers()[0];
    if (!user) return { ok: false, problems: ['No legacy users to build a request for.'] };
    const built = migration.buildRequest(active.migration, user, migration.newState());
    const answer = await migration.check(built.token);
    migration.logEvent('check', { user: user.username, detail: answer.body.ok ? 'ok' : answer.body.error?.code });
    return { ok: Boolean(answer.body.ok), user: user.username, request_claims: built.claims, cloaktail: answer.body };
  },
  // A phase's postcondition (CATALOG.checks in workflow/definitions.js). { ok, reason }
  check: async (name, { protocol, facts }) => {
    if (name === 'signin_configured') {
      return isConfigured(protocol) ? { ok: true } : { ok: false, reason: `this app's ${protocol === 'oidc' ? 'OpenID Connect' : 'SAML'} settings are still incomplete.` };
    }
    if (name === 'migration_configured') {
      const problems = migrationProblems();
      return problems.length ? { ok: false, reason: problems.join(' ') } : { ok: true };
    }
    if (name === 'migration_check_passed') {
      return facts.migrationCheckOk ? { ok: true } : { ok: false, reason: 'CloakTail has not accepted a check_user_migration request yet.' };
    }
    return { ok: false, reason: `unknown check ${name}.` };
  },
});

// The run the protocol page shows: the newest, unless the admin started over after it finished.
async function currentRun(req, protocol) {
  if (!engine.isReady()) return null;
  const [run] = await engine.listRuns(registration.WORKFLOW_NAME, { attributes: { protocol }, limit: 1 });
  if (!run || (engine.isFinal(run.status) && req.session.assistantDismissed?.[protocol] === run.id)) return null;
  return run;
}

// What the page shows: never the credential, the token or the secrets.
async function assistantView(req, protocol) {
  const conn = req.session.cloaktail;
  const cred = credentials.credentialsView();
  const run = await currentRun(req, protocol);
  const referenceUrl = run?.state?.referenceUrl ?? conn?.referenceUrl;
  return {
    protocol,
    enabled: assistant.isEnabled(),
    model: assistant.modelName(),
    engine: engine.engineStatus(),
    credentials: cred,
    defaultReferenceUrl: config.cloaktail.referenceUrl || (cred.saved ? `${cred.cloaktailUrl}${credentials.AGENT_GUIDE_PATH}` : ''),
    connection: referenceUrl && { referenceUrl, clientId: cred.clientId, token: cred.token },
    run,
  };
}

for (const protocol of ['saml', 'oidc']) {
  const back = `/admin/${protocol}#assistant`;
  const usable = (res) => {
    if (assistant.isEnabled() && engine.isReady() && credentials.hasCredentials()) return true;
    res.redirect(back);
    return false;
  };

  app.post(`/assistant/${protocol}/connect`, sameOrigin, async (req, res, next) => {
    try {
      req.session.cloaktail = await assistant.connect(req.body);
    } catch (err) {
      if (!(err instanceof assistant.AssistantError)) return next(err);
      req.session.draft = { section: 'assistant', values: { referenceUrl: req.body.referenceUrl }, errors: err.fields }; // shown in the card
    }
    res.redirect(back);
  });

  // Starts a run with the message, or passes the message to the running one.
  app.post(`/assistant/${protocol}/message`, sameOrigin, async (req, res) => {
    if (!usable(res)) return;
    const text = String(req.body.preset || req.body.message || '').trim();
    if (!text) return res.redirect(back);
    const run = await currentRun(req, protocol);
    if (run && !engine.isFinal(run.status)) {
      await engine.send(run.id, { type: 'message', text });
      await engine.waitForIdle(run.id, { after: run.state?.v ?? 0, timeoutMs: RUN_WAIT_MS });
    } else if (req.session.cloaktail) {
      const { referenceUrl, origin } = req.session.cloaktail;
      const id = await registration.start({ protocol, referenceUrl, origin, message: text });
      await engine.waitForIdle(id, { timeoutMs: RUN_WAIT_MS });
    }
    res.redirect(back);
  });

  app.post(`/assistant/${protocol}/decide`, sameOrigin, async (req, res) => {
    if (!usable(res)) return;
    const run = await currentRun(req, protocol);
    if (run?.state?.status === 'waiting_approval') {
      await engine.send(run.id, { type: 'decision', approve: req.body.decision === 'approve', note: req.body.message });
      await engine.waitForIdle(run.id, { after: run.state.v, timeoutMs: RUN_WAIT_MS });
    }
    res.redirect(back);
  });

  // New conversation: stops the current run if it is still going.
  app.post(`/assistant/${protocol}/reset`, sameOrigin, async (req, res) => {
    const run = await currentRun(req, protocol);
    if (run) {
      if (!engine.isFinal(run.status)) await engine.cancel(run.id);
      (req.session.assistantDismissed ??= {})[protocol] = run.id;
    }
    res.redirect(back);
  });

  // Forgets the reference URL in this session. Runs already started keep going.
  app.post(`/assistant/${protocol}/disconnect`, sameOrigin, (req, res) => {
    delete req.session.cloaktail;
    res.redirect(back);
  });
}

// ---------- workflows (see workflow/) ----------

const RUN_ID = /^[a-z0-9-]{1,80}$/;

app.get('/admin/workflows', async (req, res) => {
  render(req, res, workflowsPage, {
    engine: engine.engineStatus(),
    attention: await engine.waitingForAdmin(),
    definitions: [REGISTRATION, USER_MIGRATION],
    runs: {
      [REGISTRATION.id]: await engine.listRuns(registration.WORKFLOW_NAME, { limit: 20 }),
      [USER_MIGRATION.id]: await engine.listRuns(userMigration.WORKFLOW_NAME, { limit: 20 }),
    },
  });
});

app.get('/admin/workflows/:id', async (req, res, next) => {
  const run = RUN_ID.test(req.params.id) ? await engine.getRun(req.params.id) : null;
  if (!run) return next();
  const definition = DEFINITIONS[run.name === registration.WORKFLOW_NAME ? REGISTRATION.id : USER_MIGRATION.id];
  render(req, res, runPage, { run, definition, engine: engine.engineStatus() });
});

// Approve or decline, send a message, stop or resume, from the run's page.
app.post('/admin/workflows/:id/:action', sameOrigin, async (req, res, next) => {
  const { id, action } = req.params;
  const run = RUN_ID.test(id) ? await engine.getRun(id) : null;
  if (!run) return next();
  const back = `/admin/workflows/${id}`;
  const after = run.state?.v ?? 0;
  if (action === 'decide' && run.state?.status === 'waiting_approval') {
    await engine.send(id, { type: 'decision', approve: req.body.decision === 'approve', note: req.body.message });
    await engine.waitForIdle(id, { after, timeoutMs: RUN_WAIT_MS });
  } else if (action === 'message' && !engine.isFinal(run.status) && String(req.body.message ?? '').trim()) {
    await engine.send(id, { type: 'message', text: String(req.body.message).trim() });
    await engine.waitForIdle(id, { after, timeoutMs: RUN_WAIT_MS });
  } else if (action === 'cancel' && !engine.isFinal(run.status)) {
    await engine.cancel(id);
    setFlash(req, 'ok', 'Run stopped.', ['Its saved steps are kept. Resume carries on from the last one.']);
  } else if (action === 'resume' && ['CANCELLED', 'ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(run.status)) {
    await engine.resume(id);
    setFlash(req, 'ok', 'Run resumed from its last saved step.');
  }
  res.redirect(back);
});

// ---------- user migration through CloakTail ----------

// A pre-login session lasts as long as CloakTail gives the user (30 minutes), plus some slack.
const MIGRATION_TTL_MS = 40 * 60 * 1000;

// The Keycloak sign-in migrated users use. OIDC passes the username as login_hint; passport-saml
// can't put a Subject in the AuthnRequest, so SAML users type it on Keycloak's form.
function keycloakSignIn(req, res, next, username) {
  const { protocol } = active.migration;
  if (!isConfigured(protocol)) {
    setFlash(req, 'bad', 'Your account has moved to Keycloak, but Keycloak sign-in isn\'t set up in this app.',
      [`Set up ${protocol === 'oidc' ? 'OpenID Connect' : 'SAML'} first.`]);
    return res.redirect('/legacy');
  }
  if (protocol === 'oidc') return oidcSignIn(req, res, undefined, username);
  passport.authenticate('saml')(req, res, next);
}

// Signs the user in the old way: a local session, no Keycloak. outcome says why, for the page.
function legacySignIn(req, res, next, user, outcome) {
  req.session.regenerate((err) => {
    if (err) return next(err);
    const sessionUser = {
      protocol: 'legacy',
      id: user.id,
      username: user.username,
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
      email: user.email,
      signedInAt: new Date().toISOString(),
      migration: outcome,
    };
    req.login(sessionUser, { keepSessionInfo: false }, (loginErr) => {
      if (loginErr) return next(loginErr);
      legacy.recordLegacySignIn(user.id);
      migration.logEvent('legacy', { user: user.username, status: outcome?.status });
      res.redirect('/');
    });
  });
}

// Starts the durable run that follows this user's migration (workflow/userMigration.js), if
// workflows are on. Returns its id, kept in the pre-login session for /migrate/return.
async function trackMigration(user, jti) {
  if (!engine.isReady()) return null;
  try {
    return await userMigration.start({ userId: user.id, username: user.username, jti });
  } catch (err) {
    console.error(`Migration run for ${user.username} not started: ${err.message}`);
    return null;
  }
}

// Tells the user's migration run what the return URL made of the result. Never blocks the user.
function reportMigration(pending, status, detail) {
  if (!pending?.workflowId || !engine.isReady()) return;
  userMigration.report(pending.workflowId, status, detail)
    .catch((err) => console.error(`Migration run ${pending.workflowId} not told: ${err.message}`));
}

// The run's host: the spec's status check, for a user who never came back.
userMigration.setHost({
  recover: async (userId) => {
    const user = legacy.getLegacyUser(userId);
    if (!user) return { migrated: false, detail: 'the user no longer exists' };
    if (legacy.isMigrated(user)) return { migrated: true, detail: 'already marked migrated here' };
    if (migrationProblems().length) return { migrated: false, detail: 'migration is not set up here any more' };
    const recovered = await recoverMigration(user);
    return recovered ? { migrated: true, detail: 'confirmed by CloakTail /migrate/status' } : { migrated: false, detail: 'CloakTail /migrate/status has no migration for them' };
  },
});

// Not migrated yet: no session. Keep state + user id in a pre-login session and hand the browser
// a signed request, auto-posted to CloakTail.
async function startMigration(req, res, next, user) {
  const state = migration.newState();
  const { token, claims } = migration.buildRequest(active.migration, user, state);
  const workflowId = await trackMigration(user, claims.jti);
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.migrationPending = { state, userId: user.id, startedAt: Date.now(), workflowId };
    legacy.recordMigrationStarted(user.id);
    migration.logEvent('started', { user: user.username, detail: `jti ${claims.jti}` });
    res.set('Cache-Control', 'no-store').type('html').send(redirectToCloakTail({ token, user }));
  });
}

const OUTCOMES = {
  created: {
    title: 'Account upgraded',
    message: 'You\'re signed in. From next time, sign in with the new sign-in service using your email address and the new password you just chose.',
  },
  conflict: {
    title: 'Your account needs a hand',
    message: 'Another account in the new sign-in service already uses your username or email. Our support team will sort it out; meanwhile you can keep signing in with your current password.',
  },
  cancelled: {
    title: 'Account upgrade skipped',
    message: 'You\'re signed in with your current password this time. We\'ll ask you to upgrade again next time.',
  },
  expired: {
    title: 'The account upgrade timed out',
    message: 'You\'re signed in with your current password this time. We\'ll ask you to upgrade again next time.',
  },
  error: {
    title: 'The account upgrade didn\'t complete',
    message: 'You\'re signed in with your current password this time. We\'ll ask you to upgrade again next time.',
  },
};

// Identifier first: a migrated user goes to Keycloak without the old password being asked.
app.get('/legacy', (req, res) => {
  const username = req.session.legacyLogin?.username;
  render(req, res, legacyPage, {
    step: username ? 'password' : 'identify',
    username,
    problems: migrationProblems(),
    m: active.migration,
    users: legacy.listLegacyUsers(),
  });
});

app.get('/legacy/restart', (req, res) => {
  delete req.session.legacyLogin;
  res.redirect('/legacy');
});

app.post('/legacy/identify', sameOrigin, (req, res, next) => {
  const username = String(req.body.username ?? '').trim();
  if (!username) {
    setFlash(req, 'bad', 'Enter your username.');
    return res.redirect('/legacy');
  }
  const user = legacy.findByUsername(username);
  if (legacy.isMigrated(user)) {
    delete req.session.legacyLogin;
    migration.logEvent('keycloak', { user: user.username, detail: 'migrated: sent to Keycloak, old password not asked' });
    return keycloakSignIn(req, res, next, user.keycloakUsername ?? user.username);
  }
  // Unknown users get the password step too, so the form doesn't tell who has an account.
  req.session.legacyLogin = { username };
  res.redirect('/legacy');
});

// Spec "Recovering a lost result": asks CloakTail, server to server, whether a user it was sent
// (or one in conflict, whose account the developer may have linked since) was migrated.
// Returns the user marked migrated, or null. A failed check never blocks the sign-in.
async function recoverMigration(user) {
  const { token } = migration.buildRequest(active.migration, user);
  try {
    const { body } = await migration.status(token);
    if (body?.ok !== true || body.migrated !== true) return null;
    const claims = migration.verifyResult(String(body.result ?? ''), active.migration.clientId);
    if (claims.sub !== user.id || claims.status !== 'already_migrated' || typeof claims.keycloak_id !== 'string'
      || (claims.simulated === true && !config.acceptSimulated)) {
      throw new migration.ResultError('status result does not match the user');
    }
    migration.logEvent('recovered', { user: user.username, status: claims.status });
    return legacy.markMigrated(user.id, { keycloakId: claims.keycloak_id, keycloakUsername: claims.preferred_username });
  } catch (err) {
    migration.logEvent('status', { user: user.username, detail: `status check failed: ${err.message}` });
    return null;
  }
}

app.post('/legacy/login', sameOrigin, async (req, res, next) => {
  const user = legacy.checkPassword(req.body.username, req.body.password);
  if (!user) {
    setFlash(req, 'bad', 'Wrong username or password.');
    return res.redirect('/legacy');
  }
  delete req.session.legacyLogin;
  if (legacy.isMigrated(user)) return keycloakSignIn(req, res, next, user.keycloakUsername ?? user.username);
  const problems = migrationProblems();
  if (!problems.length && (user.migrationStartedAt || user.conflict)) {
    const recovered = await recoverMigration(user);
    if (recovered) return keycloakSignIn(req, res, next, recovered.keycloakUsername ?? recovered.username);
  }
  if (user.conflict) return legacySignIn(req, res, next, user, { status: 'conflict', ...OUTCOMES.conflict });
  if (problems.length) {
    return legacySignIn(req, res, next, user, {
      status: 'unconfigured',
      title: 'Signed in with your current password',
      message: 'Account upgrades are switched off right now, so your account stays as it is.',
      adminDetail: problems,
    });
  }
  await startMigration(req, res, next, user);
});

// The return URL. Rejects anything that fails a check: no session, no change to the user.
app.get('/migrate/return', (req, res, next) => {
  const pending = req.session.migrationPending;
  delete req.session.migrationPending; // single use, whatever happens next
  const reject = (reason) => {
    migration.logEvent('rejected', { user: pending ? legacy.getLegacyUser(pending.userId)?.username : null, detail: reason });
    reportMigration(pending, 'rejected', reason);
    req.session.regenerate(() => {
      setFlash(req, 'bad', 'We couldn\'t finish signing you in. Please sign in again.');
      res.redirect('/legacy');
    });
  };
  if (!migration.hasSecret()) return reject('the migration secret is not set');

  let claims;
  try {
    claims = migration.verifyResult(String(req.query.result ?? ''), active.migration.clientId);
  } catch (err) {
    if (!(err instanceof migration.ResultError)) return next(err);
    return reject(err.message);
  }
  if (!pending || Date.now() - pending.startedAt > MIGRATION_TTL_MS) return reject('no pre-login session in this browser');
  if (typeof claims.state !== 'string' || claims.state !== pending.state) return reject('state does not match the pre-login session');
  if (claims.sub !== pending.userId) return reject('sub does not match the user who signed in');
  const user = legacy.getLegacyUser(pending.userId);
  if (!user) return reject('the user no longer exists');

  let status = migration.STATUSES.includes(claims.status) ? claims.status : 'error';
  if (claims.simulated === true && !config.acceptSimulated) status = 'error';
  if (['created', 'already_migrated'].includes(status) && typeof claims.keycloak_id !== 'string') status = 'error';
  migration.logEvent('result', {
    user: user.username,
    status: claims.status,
    detail: [claims.simulated && 'simulated', status !== claims.status && `handled as ${status}`, claims.error_description].filter(Boolean).join('; ') || null,
  });
  reportMigration(pending, status, [claims.simulated && 'simulated', claims.error_description].filter(Boolean).join('; ') || null);

  if (status === 'created' || status === 'already_migrated') {
    legacy.markMigrated(user.id, { keycloakId: claims.keycloak_id, keycloakUsername: claims.preferred_username });
    // created: the user proved their old password moments ago and just chose the new one, so they
    // get the session now instead of signing in again; Keycloak sign-in starts from their next visit.
    // (A deliberate departure from the spec, which asks for a Keycloak sign-in here.)
    // already_migrated: the account is older and the old password may be stale, so Keycloak.
    if (status === 'created') return legacySignIn(req, res, next, user, { status, ...OUTCOMES.created });
    return keycloakSignIn(req, res, next, claims.preferred_username);
  }
  if (status === 'conflict') legacy.markConflict(user.id, claims.error_description);
  legacySignIn(req, res, next, user, { status, ...OUTCOMES[status] });
});

// The public keys CloakTail verifies requests with (request signing method "JWKS URL").
app.get('/migrate/jwks.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300').type('application/json').send(JSON.stringify(migration.jwks(), null, 2));
});

app.get('/admin/migrate', (req, res) => {
  const check = req.session.migrationCheck;
  delete req.session.migrationCheck;
  render(req, res, migrationPage, {
    m: active.migration,
    problems: migrationProblems(),
    protocolReady: isConfigured(active.migration.protocol),
    hasSecret: migration.hasSecret(),
    simulatedAccepted: config.acceptSimulated,
    settings: getSettings(),
    keyStatus: migration.signingKeyStatus(),
    users: legacy.listLegacyUsers(),
    events: migration.listEvents(),
    check,
  });
});

app.post('/migrate/settings', sameOrigin, async (req, res, next) => {
  try {
    await applySettings(req, ['migration'], () => saveSettings('migration', req.body), 'Settings saved.');
  } catch (err) {
    if (!(err instanceof SettingsError)) return next(err);
    settingsFailed(req, 'migration', req.body, err, 'Settings not saved. Check the highlighted fields.');
  }
  res.redirect('/admin/migrate#settings');
});

app.post('/migrate/key', sameOrigin, (req, res) => {
  const key = migration.generateSigningKey();
  setFlash(req, 'ok', 'New request signing key published.', [`kid ${key.kid}`, 'CloakTail picks it up on the next request; nothing to change in the portal.']);
  res.redirect('/admin/migrate#key');
});

// Check: POST /migrate/check. Simulate: POST /migrate/simulate, then open its redirect_url here
// with a matching pre-login session, as if the user had come back from CloakTail.
app.post('/migrate/test', sameOrigin, async (req, res) => {
  const user = legacy.getLegacyUser(String(req.body.userId ?? ''));
  const simulateStatus = String(req.body.status ?? '');
  const isSimulate = req.body.action === 'simulate';
  if (!user || (isSimulate && !migration.STATUSES.includes(simulateStatus))) {
    setFlash(req, 'bad', 'Choose a user and a status from the lists.');
    return res.redirect('/admin/migrate#test');
  }
  const state = migration.newState();
  let built;
  let answer;
  try {
    built = migration.buildRequest(active.migration, user, state);
    answer = isSimulate ? await migration.simulate(built.token, simulateStatus) : await migration.check(built.token);
  } catch (err) {
    req.session.migrationCheck = { username: user.username, claims: built?.claims, header: built?.header, error: err.cause?.message || err.message };
    return res.redirect('/admin/migrate#test');
  }
  migration.logEvent(isSimulate ? 'simulate' : 'check', {
    user: user.username, status: isSimulate ? simulateStatus : null, detail: answer.body.ok ? 'ok' : answer.body.error?.code,
  });
  const redirectUrl = answer.body.redirect_url;
  if (isSimulate && answer.body.ok && typeof redirectUrl === 'string' && redirectUrl.startsWith(`${active.migration.returnUrl}?`)) {
    req.session.migrationPending = { state, userId: user.id, startedAt: Date.now(), workflowId: await trackMigration(user, built.claims.jti) };
    return res.redirect(redirectUrl);
  }
  req.session.migrationCheck = { username: user.username, claims: built.claims, header: built.header, body: answer.body };
  res.redirect('/admin/migrate#test');
});

app.post('/migrate/users', sameOrigin, (req, res, next) => {
  try {
    const user = legacy.addLegacyUser(req.body);
    setFlash(req, 'ok', `Added legacy user ${user.username}.`);
  } catch (err) {
    if (!(err instanceof legacy.LegacyUserError)) return next(err);
    setFlash(req, 'bad', 'User not added.', [err.message]);
  }
  res.redirect('/admin/migrate#users');
});

app.post('/migrate/users/reset', sameOrigin, (req, res) => {
  legacy.resetLegacyUsers();
  setFlash(req, 'ok', 'Demo users restored. Keycloak accounts and CloakTail\'s migration record were kept, so users migrated before come back as already_migrated. To start over cleanly, forget them in CloakTail and delete their Keycloak accounts.');
  res.redirect('/admin/migrate#users');
});

app.post('/migrate/users/reset-migrations', sameOrigin, (req, res) => {
  const n = legacy.resetAllMigrations();
  setFlash(req, 'ok', n ? `${n} user${n === 1 ? '' : 's'} will be asked to migrate again.` : 'No user was migrated.',
    n ? ['Their Keycloak accounts still exist and CloakTail remembers them, so they will be recovered as already_migrated without a new password. To start over cleanly, forget them in CloakTail and delete the Keycloak accounts.'] : undefined);
  res.redirect('/admin/migrate#users');
});

app.post('/migrate/users/:id/reset', sameOrigin, (req, res) => {
  const user = legacy.resetMigration(req.params.id);
  if (user) setFlash(req, 'ok', `${user.username} will be asked to migrate again.`, ['Their Keycloak account still exists and CloakTail remembers it, so they will be recovered as already_migrated without a new password. To start over cleanly, forget them in CloakTail and delete the Keycloak account.']);
  res.redirect('/admin/migrate#users');
});

// ---------- customer documents (see files.js) ----------

// The documents page, for any signed-in customer.
app.get('/documents', (req, res) => {
  if (!req.user) return res.redirect('/');
  render(req, res, documentsPage, { files: files.listFiles(req.user), uploads: files.settingsView() });
});

// Answers a files.js error as { error } with its status, or passes a bug on.
function documentsFailed(res, next, err) {
  const status = files.statusFor(err);
  if (!status) return next(err);
  if (status >= 500) console.error(`Documents: ${err.message}`);
  res.status(status).json({ error: status === 502 ? 'File storage is unavailable. Try again later.' : err.message });
}

// Proxied: one file per request, as the raw body (application/octet-stream), streamed on to S3 as
// it arrives. Its name and type come in X-File-Name (URI-encoded) and X-File-Type. Only a
// same-origin script can send those headers, so a cross-site form can't post here.
app.post('/documents/proxied', sameOrigin, async (req, res, next) => {
  // Refused before the body is read: close the connection rather than read a large file for nothing.
  const refuse = (status, error) => res.status(status).set('Connection', 'close').json({ error });
  if (!req.user) return refuse(401, 'Your session has ended. Sign in again.');
  if (!req.is('application/octet-stream') || !req.get('x-file-name')) return refuse(415, 'Send the file as application/octet-stream, with X-File-Name.');
  const size = Number(req.get('content-length'));
  if (!Number.isSafeInteger(size)) return refuse(411, 'The upload needs a Content-Length.');
  let filename;
  try {
    filename = decodeURIComponent(req.get('x-file-name'));
  } catch {
    return refuse(400, 'X-File-Name must be URI-encoded.');
  }

  // The browser went away (closed the tab, lost the network): stop, and leave nothing in S3.
  const cancel = new AbortController();
  res.on('close', () => { if (!res.writableFinished) cancel.abort(); });
  try {
    const file = await files.uploadProxied(req.user, { filename, contentType: req.get('x-file-type'), size, body: req, signal: cancel.signal });
    res.status(201).set('Cache-Control', 'no-store').json(file);
  } catch (err) {
    if (cancel.signal.aborted) return; // nobody to answer
    res.set('Connection', 'close'); // the body may be unread
    documentsFailed(res, next, err);
  }
});

// Presigned: JSON calls that sign URLs; the browser PUTs the bytes to S3 itself. JSON only, so a
// cross-site form can't post here.
const presignedApi = express.Router();
presignedApi.use(sameOrigin, (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Your session has ended. Sign in again.' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON.' });
  next();
}, express.json({ limit: '64kb' }));

const presignedCall = (handler) => async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json(await handler(req) ?? { ok: true });
  } catch (err) {
    documentsFailed(res, next, err);
  }
};

presignedApi.post('/', presignedCall((req) => files.startPresigned(req.user, req.body)));
presignedApi.post('/:id/parts', presignedCall(async (req) => ({ parts: await files.signParts(req.user, req.params.id, req.body.partNumbers) })));
presignedApi.post('/:id/complete', presignedCall((req) => files.completePresigned(req.user, req.params.id, req.body.parts)));
presignedApi.post('/:id/abort', presignedCall((req) => files.abortPresigned(req.user, req.params.id)));
app.use('/documents/presigned', presignedApi);

// Redirects to a presigned S3 URL that lasts a minute.
app.get('/documents/:id/download', async (req, res, next) => {
  if (!req.user) return res.redirect('/');
  try {
    res.set('Cache-Control', 'no-store').redirect(await files.downloadUrl(req.user, req.params.id));
  } catch (err) {
    if (!files.statusFor(err)) return next(err);
    setFlash(req, 'bad', 'The file could not be downloaded.', [err.message]);
    res.redirect('/documents');
  }
});

app.post('/documents/:id/delete', sameOrigin, async (req, res, next) => {
  if (!req.user) return res.redirect('/');
  try {
    const file = await files.deleteFile(req.user, req.params.id);
    setFlash(req, 'ok', `Deleted ${file.name}.`);
  } catch (err) {
    if (!files.statusFor(err)) return next(err);
    setFlash(req, 'bad', 'The file was not deleted.', [err.message]);
  }
  res.redirect('/documents');
});

// ---------- local profiles ----------

// Forgets every local profile, so the next sign-in counts as a first one again.
app.post('/users/clear', sameOrigin, (req, res) => {
  clearProfiles();
  setFlash(req, 'ok', 'Local profiles cleared. Keycloak accounts are untouched.');
  res.redirect('/admin/users');
});

// ---------- SP certificates ----------

app.post('/certs/:kind/generate', sameOrigin, async (req, res, next) => {
  const { kind } = req.params;
  if (!isKind(kind)) return res.status(404).type('text').send('Not found');
  const keySize = Number(req.body.keySize);
  const years = Number(req.body.years);
  if (!KEY_SIZES.includes(keySize) || !VALIDITY_YEARS.includes(years)) {
    setFlash(req, 'bad', 'Choose a key size and validity from the lists.');
    return res.redirect('/admin/certs');
  }
  try {
    const replaced = Boolean(keys[kind]);
    const { info } = await generateKeyPair(kind, { commonName: `${active.sp.entityId} ${kind}`, keySize, years });
    reloadKeys();
    buildStrategies();
    const inUse = kind === 'signing' ? active.sp.signRequests : active.sp.decryptAssertions;
    setFlash(req, 'ok', `${replaced ? 'Replaced' : 'Generated'} the ${kind} key pair.`, [
      `SHA-256 ${info.fingerprint256}`,
      inUse ? 'Paste the new certificate into the portal.' : `Turn on "${kind === 'signing' ? 'Sign requests' : 'Decrypt assertions'}" in the SAML settings to use it.`,
    ]);
    res.redirect(`/admin/certs#${kind}`);
  } catch (err) {
    next(err);
  }
});

// Certificates to paste into the portal form. ?format=base64 for the bare base64 body, ?download=1 to save.
app.get('/certs/:kind', (req, res) => {
  const pair = isKind(req.params.kind) ? keys[req.params.kind] : null;
  if (!pair) return res.status(404).type('text').send('No key pair yet. Generate one on the Certificates page.');
  const base64 = req.query.format === 'base64';
  if (req.query.download) res.attachment(`testsp-${req.params.kind}-cert.${base64 ? 'txt' : 'pem'}`);
  res.type('text').send(base64 ? certBase64(pair.cert) : pair.cert);
});

app.use((req, res) => res.status(404).type('html').send(errorPage({ status: 404, message: 'There is no page at this address.' })));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).type('html').send(errorPage({ status: 500, message: err.message }));
});

// DBOS resumes the runs a previous process left unfinished. The hosts above are set by now.
await engine.launch({ retry: true });

const server = app.listen(config.port, () => {
  console.log(`Test SP on ${active.baseUrl}`);
  console.log(`  Workflows:          ${engine.isReady() ? `on (${engine.engineStatus().database})` : `off: ${engine.engineStatus().reason}`}`);
  console.log(`  SAML  entity ID:    ${active.sp.entityId}${isConfigured('saml') ? '' : ' (IdP not configured)'}`);
  console.log(`        ACS URL:      ${active.sp.acsUrl}`);
  console.log(`  OIDC  client ID:    ${active.oidc.clientId || '(not configured)'}`);
  console.log(`        redirect URI: ${active.oidc.redirectUri}`);
});
// A document upload streams through the request for its whole length (Node's default is 5 minutes).
server.requestTimeout = config.uploads.timeoutSeconds * 1000;
