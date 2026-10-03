// User migration through CloakTail (http://localhost:3000/migrate/spec.md).
//
// Request: a JWT this app signs on the server, saying who the user is. Signed with the app's own
// RSA key (RS256, kid = the key's RFC 7638 thumbprint), published at <base URL>/migrate/jwks.json, or with the
// migration secret (HS256). Result: a JWT CloakTail signs with HS256 and the migration secret.
// The secret and private key never leave the server and are never logged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

export const STATUSES = ['created', 'already_migrated', 'conflict', 'cancelled', 'expired', 'error'];
export const CLOAKTAIL = {
  audience: config.cloaktail.migrateUrl, // request aud and result iss
  startUrl: `${config.cloaktail.migrateUrl}/start`,
  checkUrl: `${config.cloaktail.migrateUrl}/check`,
  simulateUrl: `${config.cloaktail.migrateUrl}/simulate`,
  statusUrl: `${config.cloaktail.migrateUrl}/status`,
};
const REQUEST_LIFETIME = 300;
const CLOCK_SKEW = 60;

export const hasSecret = () => Boolean(config.migrationSecret);

// ---------- request signing key (JWKS) ----------

let signingKey = null; // { privateKey, jwk, kid, createdAt }
let signingKeyError = null;

function thumbprint({ e, kty, n }) {
  // RFC 7638: the required members in lexicographic order, no whitespace.
  return crypto.createHash('sha256').update(JSON.stringify({ e, kty, n })).digest('base64url');
}

export function loadSigningKey() {
  signingKey = null;
  signingKeyError = null;
  const file = config.migrationKeyFile;
  if (!fs.existsSync(file)) return null;
  try {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
    if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('not an RSA key');
    const { kty, n, e } = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
    const kid = thumbprint({ e, kty, n });
    signingKey = {
      privateKey,
      kid,
      jwk: { kty, use: 'sig', alg: 'RS256', kid, n, e },
      bits: privateKey.asymmetricKeyDetails.modulusLength,
      createdAt: fs.statSync(file).mtime.toISOString(),
    };
  } catch (err) {
    signingKeyError = `${file} is not a usable RSA private key (${err.message}). Generate a new one.`;
  }
  return signingKey;
}

// Creates a new 2048-bit RSA key. CloakTail fetches the JWKS again when a request names a kid it
// hasn't cached (at most once a minute), so the next request after a rotation still verifies.
export function generateSigningKey() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.mkdirSync(path.dirname(config.migrationKeyFile), { recursive: true });
  fs.writeFileSync(config.migrationKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return loadSigningKey();
}

export function ensureSigningKey() {
  if (!loadSigningKey() && !signingKeyError) {
    generateSigningKey();
    console.log(`Generated the migration request signing key (${config.migrationKeyFile}).`);
  }
}

export const signingKeyStatus = () => ({
  key: signingKey && { kid: signingKey.kid, bits: signingKey.bits, createdAt: signingKey.createdAt, jwk: signingKey.jwk },
  error: signingKeyError,
});

// The public JWKS CloakTail fetches. Only public members.
export const jwks = () => ({ keys: signingKey ? [signingKey.jwk] : [] });

// ---------- JWT ----------

const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const hmac = (input) => crypto.createHmac('sha256', config.migrationSecret).update(input).digest();

function sign(header, claims) {
  const input = `${part(header)}.${part(claims)}`;
  const signature = header.alg === 'HS256'
    ? hmac(input)
    : crypto.sign('sha256', Buffer.from(input), signingKey.privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

// What is missing before this app can send users to CloakTail, as sentences. Empty when ready.
export function problems(m, { protocolReady }) {
  const out = [];
  if (!hasSecret()) out.push('Set CLOAKTAIL_MIGRATION_SECRET in .env (from Applications → your app → User migration) and restart. Results can\'t be verified without it.');
  if (!m.clientId) out.push(`No client ID: set up ${m.protocol === 'oidc' ? 'OpenID Connect' : 'SAML'} first, or choose the other protocol.`);
  if (!protocolReady) out.push(`${m.protocol === 'oidc' ? 'OpenID Connect' : 'SAML'} isn't set up, so migrated users couldn't sign in with Keycloak.`);
  if (m.requestSigning === 'jwks' && !signingKey) out.push(signingKeyError ?? 'No request signing key. Generate one.');
  return out;
}

// Builds and signs a request for one legacy user. Returns { token, claims } (claims for display).
export function buildRequest(m, user, state) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: m.clientId,
    aud: CLOAKTAIL.audience,
    iat: now,
    exp: now + REQUEST_LIFETIME,
    jti: crypto.randomUUID(),
    sub: String(user.id),
    preferred_username: user.username,
    ...(user.email ? { email: user.email } : {}),
    ...(user.firstName ? { given_name: user.firstName } : {}),
    ...(user.lastName ? { family_name: user.lastName } : {}),
    return_url: m.returnUrl,
    ...(state ? { state } : {}),
  };
  const header = m.requestSigning === 'jwks'
    ? { alg: 'RS256', typ: 'JWT', kid: signingKey.kid }
    : { alg: 'HS256', typ: 'JWT' };
  return { token: sign(header, claims), claims, header };
}

export const newState = () => crypto.randomBytes(32).toString('base64url'); // 256 bits

export class ResultError extends Error {}

// Spec steps 1-3: signature (HS256 only, constant time), iss and aud, exp. The caller checks
// state and sub against the pre-login session. Returns the claims; throws ResultError.
export function verifyResult(token, clientId) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new ResultError('not a compact JWT');
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new ResultError('header or claims are not JSON');
  }
  if (header?.alg !== 'HS256') throw new ResultError(`algorithm ${JSON.stringify(header?.alg)} is not HS256`);
  const expected = hmac(`${parts[0]}.${parts[1]}`);
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new ResultError('bad signature');
  if (!claims || typeof claims !== 'object') throw new ResultError('claims are not an object');
  if (claims.iss !== CLOAKTAIL.audience) throw new ResultError(`iss ${JSON.stringify(claims.iss)} is not ${CLOAKTAIL.audience}`);
  const aud = [].concat(claims.aud);
  if (!aud.includes(clientId)) throw new ResultError(`aud ${JSON.stringify(claims.aud)} is not this app's client ID`);
  if (!Number.isInteger(claims.exp)) throw new ResultError('exp missing');
  if (claims.exp + CLOCK_SKEW < Math.floor(Date.now() / 1000)) throw new ResultError('expired');
  if (typeof claims.sub !== 'string' || typeof claims.status !== 'string') throw new ResultError('sub or status missing');
  return claims;
}

// Header and claims of a JWT, for display only.
export function peek(token) {
  try {
    const [h, p] = String(token).split('.');
    return { header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(p, 'base64url')) };
  } catch {
    return null;
  }
}

// ---------- CloakTail testing endpoints ----------

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!json) throw new Error(`CloakTail answered HTTP ${res.status} without JSON.`);
  return { httpStatus: res.status, body: json };
}

export const check = (request) => post(CLOAKTAIL.checkUrl, { request });
export const simulate = (request, status) => post(CLOAKTAIL.simulateUrl, { request, status });
// Whether CloakTail migrated the request's user; with a signed already_migrated result when it did.
export const status = (request) => post(CLOAKTAIL.statusUrl, { request });

// ---------- event log (in memory, for the Migration page; never holds a token) ----------

const events = [];
export function logEvent(kind, { user, status, detail } = {}) {
  events.unshift({ at: new Date().toISOString(), kind, user: user ?? null, status: status ?? null, detail: detail ?? null });
  events.length = Math.min(events.length, 30);
  console.log(`[migration] ${kind}${user ? ` user=${user}` : ''}${status ? ` status=${status}` : ''}${detail ? ` (${detail})` : ''}`);
}
export const listEvents = () => events;
