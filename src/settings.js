// Settings editable in the app, in two sections: SAML and OpenID Connect. .env supplies the
// defaults; saved changes go to config.settingsFile so they survive a restart. "Reset" deletes it.
//
// Every setting is a value the CloakTail application page shows (/apps/<id>): this app plays a
// developer's app, which knows only what the portal tells it. It never derives Keycloak URLs
// from a server URL and realm name.
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { config, envDefaults, appUrls } from './config.js';

export const NAME_ID_FORMATS = [
  'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
];

export const SECTIONS = ['saml', 'oidc', 'migration'];
export const MIGRATION_PROTOCOLS = ['', 'oidc', 'saml'];
export const REQUEST_SIGNING = ['jwks', 'secret'];

// errors: [{ field, message }]. field names the form input, or is null for the whole form.
export class SettingsError extends Error {
  constructor(errors) {
    super(errors.map((e) => e.message).join(' '));
    this.errors = errors;
  }

  get fields() {
    return Object.fromEntries(this.errors.filter((e) => e.field).map((e) => [e.field, e.message]));
  }
}

const isOn = (v) => v === true || v === 'on' || v === 'true';
const text = (v) => String(v ?? '').trim();
const list = (v) => [...new Set(text(v).split(/[\s,]+/).filter(Boolean))];

// Accepts PEM or bare base64; returns the single-line base64 form node-saml and Keycloak use.
function normalizeCert(value) {
  const b64 = text(value).replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (!b64) return '';
  new X509Certificate(`-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`);
  return b64;
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function collector(raw) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  const url = (name, label, { required = false } = {}) => {
    const value = text(raw[name]);
    if (value ? !isHttpUrl(value) : required) fail(name, `${label} must be an http(s) URL, as shown on the application page.`);
    return value;
  };
  // The address the browser uses for this app; every URL registered in CloakTail is under it.
  const baseUrl = () => {
    const value = text(raw.baseUrl).replace(/\/+$/, '');
    if (!isHttpUrl(value) || /[?#]/.test(value)) fail('baseUrl', 'Base URL must be an http(s) URL without a query or fragment: the address the browser uses for this app.');
    return value;
  };
  const done = (values) => {
    if (errors.length) throw new SettingsError(errors);
    return values;
  };
  return { fail, url, baseUrl, done };
}

// Validates form input (checkboxes arrive as "on" or are absent) or saved JSON (booleans).
export function normalizeSaml(raw) {
  const { fail, url, baseUrl, done } = collector(raw);

  const idpMetadataUrl = url('idpMetadataUrl', 'IdP metadata URL');
  const idpSsoUrl = url('idpSsoUrl', 'Single sign-on URL', { required: true });
  const idpSloUrl = url('idpSloUrl', 'Single logout URL');
  const idpInitiatedUrl = url('idpInitiatedUrl', 'IdP-initiated login URL');

  const idpEntityId = text(raw.idpEntityId);
  if (!idpEntityId || /\s/.test(idpEntityId)) fail('idpEntityId', 'IdP entity ID is required and must not contain spaces.');

  let idpCert = '';
  try {
    idpCert = normalizeCert(raw.idpCert);
  } catch {
    fail('idpCert', 'Not a valid X.509 certificate. Paste PEM or base64, or leave it empty.');
  }
  if (!idpCert && !idpMetadataUrl && !raw.idpCert) {
    fail('idpMetadataUrl', 'Give the IdP metadata URL or the signing certificate, so responses can be verified.');
  }

  const entityId = text(raw.entityId);
  if (/\s/.test(entityId) || entityId.length > 1024) fail('entityId', 'SP entity ID must not contain spaces.');

  const nameIdFormat = text(raw.nameIdFormat);
  if (/\s/.test(nameIdFormat)) fail('nameIdFormat', 'Name ID format must be a URN without spaces.');

  return done({
    baseUrl: baseUrl(),
    idpMetadataUrl,
    idpEntityId,
    idpSsoUrl,
    idpSloUrl,
    idpInitiatedUrl,
    idpCert,
    entityId,
    nameIdFormat,
    expectedAttributes: list(raw.expectedAttributes).join(', '),
    wantResponseSigned: isOn(raw.wantResponseSigned),
    wantAssertionsSigned: isOn(raw.wantAssertionsSigned),
    signRequests: isOn(raw.signRequests),
    decryptAssertions: isOn(raw.decryptAssertions),
  });
}

// The portal shows the issuer and the discovery document; accept either.
const issuerOf = (value) => text(value).replace(/\/\.well-known\/openid-configuration$/, '').replace(/\/+$/, '');

export function normalizeOidc(raw) {
  const { fail, baseUrl, done } = collector(raw);

  const oidcIssuer = issuerOf(raw.oidcIssuer);
  if (!isHttpUrl(oidcIssuer)) fail('oidcIssuer', 'Issuer must be an http(s) URL, as shown on the application page.');

  const oidcClientId = text(raw.oidcClientId);
  if (!oidcClientId || !/^[\x21-\x7e]+$/.test(oidcClientId)) fail('oidcClientId', 'Client ID is required and must not contain spaces.');

  const oidcClientSecret = text(raw.oidcClientSecret);
  if (/\s/.test(oidcClientSecret)) fail('oidcClientSecret', 'Client secret must not contain spaces.');

  const scopes = list(raw.oidcScopes);
  if (!scopes.includes('openid')) fail('oidcScopes', 'Scopes must include openid, or Keycloak returns no ID token.');

  return done({
    baseUrl: baseUrl(),
    oidcIssuer,
    oidcClientId,
    oidcClientSecret,
    oidcScopes: scopes.join(' '),
    oidcUsePkce: isOn(raw.oidcUsePkce),
    oidcExpectedClaims: list(raw.oidcExpectedClaims).join(', '),
  });
}

// User migration, as registered on the application's User migration page in CloakTail.
export function normalizeMigration(raw) {
  const { fail, url, done } = collector(raw);
  const migrationProtocol = text(raw.migrationProtocol);
  if (!MIGRATION_PROTOCOLS.includes(migrationProtocol)) fail('migrationProtocol', 'Choose OpenID Connect, SAML or automatic.');
  const migrationRequestSigning = text(raw.migrationRequestSigning);
  if (!REQUEST_SIGNING.includes(migrationRequestSigning)) fail('migrationRequestSigning', 'Choose the JWKS URL or the migration secret.');
  const migrationReturnUrl = url('migrationReturnUrl', 'Return URL');
  const migrationUrl = url('migrationUrl', 'Migration URL').replace(/\/+$/, '');
  const migrationSecret = text(raw.migrationSecret);
  if (/\s/.test(migrationSecret)) fail('migrationSecret', 'Migration secret must not contain spaces.');
  return done({ migrationProtocol, migrationRequestSigning, migrationReturnUrl, migrationUrl, migrationSecret });
}

const NORMALIZE = { saml: normalizeSaml, oidc: normalizeOidc, migration: normalizeMigration };
const SECTION_KEYS = {
  saml: ['baseUrl', 'idpMetadataUrl', 'idpEntityId', 'idpSsoUrl', 'idpSloUrl', 'idpInitiatedUrl', 'idpCert', 'entityId',
    'nameIdFormat', 'expectedAttributes', 'wantResponseSigned', 'wantAssertionsSigned', 'signRequests', 'decryptAssertions'],
  oidc: ['baseUrl', 'oidcIssuer', 'oidcClientId', 'oidcClientSecret', 'oidcScopes', 'oidcUsePkce', 'oidcExpectedClaims'],
  migration: ['migrationProtocol', 'migrationRequestSigning', 'migrationReturnUrl', 'migrationUrl', 'migrationSecret'],
};

// Reads the passport-saml example on a SAML application page ("Example: Node.js").
// Returns the settings it names; values it doesn't mention are left out.
export function parsePortalConfig(snippet) {
  const str = (key) => snippet.match(new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`))?.[1];
  const bool = (key) => snippet.match(new RegExp(`\\b${key}\\s*:\\s*(true|false)\\b`))?.[1];
  const has = (key) => new RegExp(`^\\s*${key}\\s*:`, 'm').test(snippet);

  const found = {
    idpSsoUrl: str('entryPoint'),
    entityId: str('issuer'),
    idpEntityId: str('idpIssuer'),
    nameIdFormat: str('identifierFormat'),
    idpSloUrl: str('logoutUrl'),
    wantResponseSigned: bool('wantAuthnResponseSigned'),
    wantAssertionsSigned: bool('wantAssertionsSigned'),
  };
  if (!found.idpSsoUrl && !found.entityId) {
    throw new SettingsError([{ field: 'portalConfig', message: 'That is not the passport-saml example from a SAML application page (no entryPoint or issuer found).' }]);
  }
  // The example lists privateKey / decryptionPvk only when the client requires them.
  found.signRequests = String(has('privateKey'));
  found.decryptAssertions = String(has('decryptionPvk'));
  return Object.fromEntries(Object.entries(found).filter(([, v]) => v !== undefined));
}

// Reads the openid-client example on an OpenID Connect application page ("Example code: Node.js").
// Returns { values, notes }. The secret is never in the example; a public client clears it.
export function parsePortalOidcConfig(snippet) {
  const issuer = snippet.match(/new\s+URL\(\s*['"`]([^'"`]+)['"`]\s*\)/)?.[1];
  const clientId = snippet.match(/discovery\(\s*new\s+URL\([^)]*\)\s*,\s*['"`]([^'"`]+)['"`]/)?.[1];
  if (!issuer || !clientId) {
    throw new SettingsError([{ field: 'portalConfig', message: 'That is not the openid-client example from an OpenID Connect application page (no issuer or client ID found).' }]);
  }
  const values = { oidcIssuer: issuer, oidcClientId: clientId };
  const scope = snippet.match(/\bscope\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
  if (scope) values.oidcScopes = scope;
  if (/code_challenge/.test(snippet)) values.oidcUsePkce = 'true';
  const isPublic = /client\.None\(\)/.test(snippet);
  if (isPublic) values.oidcClientSecret = '';

  const notes = [];
  const redirectUri = snippet.match(/\bredirect_uri\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
  const ours = resolve().oidc.redirectUri;
  if (redirectUri && redirectUri !== ours) {
    notes.push(`The example's redirect URI is ${redirectUri}; add ${ours} to the application's redirect URIs in the portal.`);
  }
  if (!isPublic) notes.push('Copy the client secret from the application page; it is not in the example.');
  return { values, notes };
}

// Settings saved before this app took the portal's URLs as given had a Keycloak URL and realm.
function migrate(saved) {
  if (!saved.keycloakUrl || !saved.realm || saved.idpEntityId) return saved;
  const realmUrl = `${String(saved.keycloakUrl).replace(/\/+$/, '')}/realms/${saved.realm}`;
  const { keycloakUrl, realm, ...rest } = saved;
  return {
    ...rest,
    idpEntityId: realmUrl,
    idpSsoUrl: `${realmUrl}/protocol/saml`,
    idpSloUrl: `${realmUrl}/protocol/saml`,
    idpMetadataUrl: `${realmUrl}/protocol/saml/descriptor`,
  };
}

// Normalizes each section on its own, so an incomplete one doesn't discard the other.
// An invalid section keeps its raw values and is reported as not configured.
function normalizeAll(raw, source) {
  const out = {};
  for (const section of SECTIONS) {
    try {
      Object.assign(out, NORMALIZE[section](raw));
    } catch (err) {
      if (!(err instanceof SettingsError)) throw err;
      if (source) console.warn(`${source}: ${section.toUpperCase()} is not configured (${err.message})`);
      for (const key of SECTION_KEYS[section]) out[key] = raw[key] ?? envDefaults[key];
    }
  }
  return out;
}

function initial() {
  const defaults = normalizeAll(envDefaults, '.env');
  if (!fs.existsSync(config.settingsFile)) return defaults;
  try {
    return normalizeAll({ ...defaults, ...migrate(JSON.parse(fs.readFileSync(config.settingsFile, 'utf8'))) }, config.settingsFile);
  } catch (err) {
    console.warn(`Ignoring ${config.settingsFile}: ${err.message}`);
    return defaults;
  }
}

let current = initial();

export const getSettings = () => current;
export const isCustomized = () => fs.existsSync(config.settingsFile);

// Whether a section has what sign-in needs.
export function isConfigured(section, s = current) {
  try {
    NORMALIZE[section](s);
    return true;
  } catch {
    return false;
  }
}

function write(next) {
  fs.mkdirSync(path.dirname(config.settingsFile), { recursive: true });
  fs.writeFileSync(config.settingsFile, `${JSON.stringify(next, null, 2)}\n`);
  current = next;
  return current;
}

// Saves one section; the other is kept as it is. The base URL has its own form, so a section
// saved without one keeps the current base URL.
export const saveSettings = (section, raw) => write({ ...current, ...NORMALIZE[section]({ baseUrl: resolve().baseUrl, ...raw }) });

// Saves the base URL alone. It is shared by SAML, OpenID Connect and user migration.
export function saveBaseUrl(raw) {
  const { baseUrl, done } = collector(raw);
  return write({ ...current, ...done({ baseUrl: baseUrl() }) });
}

export function resetSettings() {
  fs.rmSync(config.settingsFile, { force: true });
  current = normalizeAll(envDefaults);
  return current;
}

// The SP, IdP and OIDC client values the app runs with, derived from the settings.
export function resolve(s = current) {
  // A base URL saved by neither section (both incomplete) may be invalid; fall back to .env.
  const urls = appUrls(isHttpUrl(s.baseUrl) ? s.baseUrl : envDefaults.baseUrl);
  const spEntityId = s.entityId || urls.sp.defaultEntityId;
  const protocol = s.migrationProtocol || (isConfigured('oidc', s) ? 'oidc' : 'saml');
  return {
    baseUrl: urls.baseUrl,
    migration: {
      protocol,
      protocolAuto: !s.migrationProtocol,
      // The request's iss: the client ID of the Keycloak sign-in that migrated users use.
      clientId: protocol === 'oidc' ? s.oidcClientId : spEntityId,
      requestSigning: s.migrationRequestSigning,
      returnUrl: s.migrationReturnUrl || urls.migrationReturnUrl,
      defaultReturnUrl: urls.migrationReturnUrl,
      jwksUrl: urls.jwksUrl,
      url: s.migrationUrl, // CloakTail's; empty until registered
    },
    sp: {
      ...urls.sp,
      entityId: spEntityId,
      nameIdFormat: s.nameIdFormat || null,
      expectedAttributes: s.expectedAttributes ? s.expectedAttributes.split(', ') : [],
      wantResponseSigned: s.wantResponseSigned,
      wantAssertionsSigned: s.wantAssertionsSigned,
      signRequests: s.signRequests,
      decryptAssertions: s.decryptAssertions,
    },
    idp: {
      entityId: s.idpEntityId,
      ssoUrl: s.idpSsoUrl,
      sloUrl: s.idpSloUrl,
      initiatedUrl: s.idpInitiatedUrl,
      metadataUrl: s.idpMetadataUrl,
      cert: s.idpCert,
    },
    oidc: {
      ...urls.oidc,
      issuer: s.oidcIssuer,
      clientId: s.oidcClientId,
      clientSecret: s.oidcClientSecret,
      isPublic: !s.oidcClientSecret,
      scopes: s.oidcScopes,
      usePkce: s.oidcUsePkce,
      expectedClaims: s.oidcExpectedClaims ? s.oidcExpectedClaims.split(', ') : [],
    },
  };
}
