import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

const flag = (name, fallback) => (process.env[name] ?? String(fallback)).toLowerCase() === 'true';

const baseUrl = (process.env.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');

// Fixed for the life of the process.
export const config = {
  port: Number(process.env.PORT || 4000),
  baseUrl,
  sessionSecret: required('SESSION_SECRET'),
  secureCookies: baseUrl.startsWith('https://'),
  settingsFile: process.env.SETTINGS_FILE || 'data/settings.json',
  usersFile: process.env.USERS_FILE || 'data/users.json',

  sp: {
    defaultEntityId: `${baseUrl}/saml/metadata`,
    acsUrl: `${baseUrl}/saml/acs`,
    sloUrl: `${baseUrl}/saml/slo`,
    metadataUrl: `${baseUrl}/saml/metadata`,
    homeUrl: `${baseUrl}/`,
  },

  oidc: {
    redirectUri: `${baseUrl}/oidc/callback`,
    postLogoutRedirectUri: `${baseUrl}/oidc/logged-out`,
    frontchannelLogoutUri: `${baseUrl}/oidc/frontchannel-logout`,
    webOrigin: new URL(baseUrl).origin,
    homeUrl: `${baseUrl}/`,
  },

  legacyUsersFile: process.env.LEGACY_USERS_FILE || 'data/legacy-users.json',

  // User migration through CloakTail (see /migrate). The secret verifies results (always HS256)
  // and signs requests when the request signing method is "secret". Never shown, logged or saved.
  cloaktail: {
    migrateUrl: `${(process.env.CLOAKTAIL_URL || 'http://localhost:3000').replace(/\/$/, '')}/migrate`,
  },
  migrationSecret: process.env.CLOAKTAIL_MIGRATION_SECRET || '',
  migrationKeyFile: process.env.MIGRATION_KEY_FILE || 'certs/migration-key.pem',
  jwksUrl: `${baseUrl}/migrate/jwks.json`,
  // Results from POST /migrate/simulate carry simulated: true. Accepted only while testing.
  acceptSimulated: flag('MIGRATION_ACCEPT_SIMULATED', process.env.NODE_ENV !== 'production'),

  keyFiles: {
    signing: {
      key: process.env.SIGNING_KEY_FILE || 'certs/signing-key.pem',
      cert: process.env.SIGNING_CERT_FILE || 'certs/signing-cert.pem',
    },
    encryption: {
      key: process.env.ENCRYPTION_KEY_FILE || 'certs/encryption-key.pem',
      cert: process.env.ENCRYPTION_CERT_FILE || 'certs/encryption-cert.pem',
    },
  },
};

// Starting values for the settings editable on the home page (see settings.js).
export const envDefaults = {
  // As shown on the CloakTail application page, under "Keycloak (IdP) details".
  idpMetadataUrl: process.env.IDP_METADATA_URL || '',
  idpEntityId: process.env.IDP_ENTITY_ID || '',
  idpSsoUrl: process.env.IDP_SSO_URL || '',
  idpSloUrl: process.env.IDP_SLO_URL || '',
  idpInitiatedUrl: process.env.IDP_INITIATED_URL || '',
  idpCert: process.env.IDP_CERT || '',
  entityId: process.env.SP_ENTITY_ID || '',
  nameIdFormat: process.env.NAME_ID_FORMAT || '',
  expectedAttributes: process.env.EXPECTED_ATTRIBUTES || '',
  wantResponseSigned: flag('WANT_RESPONSE_SIGNED', true),
  wantAssertionsSigned: flag('WANT_ASSERTIONS_SIGNED', true),
  signRequests: flag('SIGN_REQUESTS', false),
  decryptAssertions: flag('DECRYPT_ASSERTIONS', false),

  // OpenID Connect, as shown on an OpenID Connect application page.
  oidcIssuer: process.env.OIDC_ISSUER || '',
  oidcClientId: process.env.OIDC_CLIENT_ID || '',
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET || '',
  oidcScopes: process.env.OIDC_SCOPES || 'openid profile email',
  oidcUsePkce: flag('OIDC_USE_PKCE', true),
  oidcExpectedClaims: process.env.OIDC_EXPECTED_CLAIMS || '',

  // User migration, as registered on the application's User migration page in CloakTail.
  // Empty protocol: OpenID Connect when it is set up, else SAML.
  migrationProtocol: process.env.MIGRATION_PROTOCOL || '',
  migrationRequestSigning: process.env.MIGRATION_REQUEST_SIGNING || 'jwks',
  migrationReturnUrl: process.env.MIGRATION_RETURN_URL || `${baseUrl}/migrate/return`,
};
