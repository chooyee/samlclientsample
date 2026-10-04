import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

const flag = (name, fallback) => (process.env[name] ?? String(fallback)).toLowerCase() === 'true';

const port = Number(process.env.PORT || 4000);

// The URLs this app registers in CloakTail, all under the base URL: the address the browser uses.
// The base URL is a setting (see settings.js); BASE_URL is only its default.
export function appUrls(base) {
  const baseUrl = base.replace(/\/+$/, '');
  return {
    baseUrl,
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
    jwksUrl: `${baseUrl}/migrate/jwks.json`,
    migrationReturnUrl: `${baseUrl}/migrate/return`,
  };
}

// Fixed for the life of the process.
export const config = {
  port,
  sessionSecret: required('SESSION_SECRET'),
  settingsFile: process.env.SETTINGS_FILE || 'data/settings.json',
  usersFile: process.env.USERS_FILE || 'data/users.json',

  legacyUsersFile: process.env.LEGACY_USERS_FILE || 'data/legacy-users.json',
  // The CloakTail API credential, saved on the API credentials page (see apiCredentials.js).
  apiCredentialsFile: process.env.API_CREDENTIALS_FILE || 'data/api-credentials.json',

  // User migration's URL and secret are settings (see settings.js): they come with the
  // registration, from CloakTail's migration page or API.
  cloaktail: {
    // Only pre-fills the API credentials page: the URL saved there is the one used.
    url: (process.env.CLOAKTAIL_URL || '').replace(/\/+$/, ''),
    // Only pre-fills the registration assistant's form: the spec it works from is the URL entered there.
    referenceUrl: process.env.CLOAKTAIL_REFERENCE_URL || '',
  },

  // The registration assistant on the SAML and OIDC pages. Off unless both are set.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || '',
  },
  // Durable workflows (DBOS, see workflow/engine.js): the registration assistant and user
  // migration tracking. Off unless a Postgres URL is set.
  workflows: {
    databaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL || '',
    // Runs resume only on the same version: bump it when a workflow's steps change order.
    version: process.env.DBOS_APP_VERSION || 'testsp-workflows-1',
  },
  migrationKeyFile: process.env.MIGRATION_KEY_FILE || 'certs/migration-key.pem',
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
  // The address the browser uses for this app.
  baseUrl: process.env.BASE_URL || `http://localhost:${port}`,

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
  // Empty: <base URL>/migrate/return.
  migrationReturnUrl: process.env.MIGRATION_RETURN_URL || '',
  // CloakTail's migration URL: requests' aud and results' iss; /start, /check, /simulate and
  // /status are under it. Not from .env: it comes with the registration (the API's
  // endpoints.request_aud_and_result_iss, or the migration page).
  migrationUrl: '',
  // Verifies results (always HS256) and signs requests with the "secret" method. Saved here by the
  // assistant or the Migration page; .env only gives the default.
  migrationSecret: process.env.CLOAKTAIL_MIGRATION_SECRET || '',
};
