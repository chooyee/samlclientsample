// The CloakTail API credential, saved on the API credentials page, and the access token got with it.
//
// How to get a token is built in, as CloakTail documents it: POST <CloakTail URL>/api/v1/oauth/token
// with grant_type=client_credentials and the credential in HTTP Basic (client_secret_basic). The
// token carries every scope the credential has. The registration assistant asks for a token
// through getAccessToken(); neither the credential nor the token ever reaches the model.
//
// The credential is saved to config.apiCredentialsFile so it survives a restart. The token is kept
// in memory only.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const TOKEN_PATH = '/api/v1/oauth/token';
export const AGENT_GUIDE_PATH = '/api/v1/agent.md';
const TIMEOUT_MS = 20_000;
const EXPIRY_SKEW_MS = 30_000; // renew a little before the token expires

// fields: { field: message } for the form.
export class CredentialsError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.fields = fields;
  }
}

const text = (v) => String(v ?? '').trim();
const isHttpUrl = (v) => {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};

function load() {
  if (!fs.existsSync(config.apiCredentialsFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(config.apiCredentialsFile, 'utf8'));
  } catch (err) {
    console.warn(`Ignoring ${config.apiCredentialsFile}: ${err.message}`);
    return null;
  }
}

let saved = load();
let token = null; // { value, expiresAt, scope, obtainedAt }

export const hasCredentials = () => Boolean(saved);
export const cloaktailUrl = () => saved?.cloaktailUrl ?? '';
export const tokenUrl = () => (saved ? `${saved.cloaktailUrl}${TOKEN_PATH}` : '');

// What pages may show: never the secret or the token.
export function credentialsView() {
  return {
    saved: Boolean(saved),
    cloaktailUrl: saved?.cloaktailUrl || config.cloaktail.url,
    clientId: saved?.clientId ?? '',
    tokenUrl: tokenUrl(),
    updatedAt: saved?.updatedAt ?? null,
    token: token && { expiresAt: token.expiresAt, scope: token.scope, obtainedAt: token.obtainedAt },
  };
}

// An empty secret keeps the saved one, so the form never has to show it.
export function saveCredentials(raw) {
  const url = text(raw.cloaktailUrl).replace(/\/+$/, '');
  const clientId = text(raw.clientId);
  const clientSecret = text(raw.clientSecret) || saved?.clientSecret || '';
  const fields = {};
  if (!isHttpUrl(url) || /[?#]/.test(url)) fields.cloaktailUrl = 'CloakTail URL must be an http(s) URL without a query, e.g. http://localhost:3000.';
  if (!clientId || /\s/.test(clientId)) fields.clientId = 'Client ID is required and must not contain spaces.';
  if (!clientSecret) fields.clientSecret = 'Client secret is required.';
  else if (/\s/.test(clientSecret)) fields.clientSecret = 'Client secret must not contain spaces.';
  if (Object.keys(fields).length) throw new CredentialsError('The API credential was not saved.', fields);

  const next = { cloaktailUrl: url, clientId, clientSecret, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(config.apiCredentialsFile), { recursive: true });
  fs.writeFileSync(config.apiCredentialsFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  saved = next;
  token = null; // obtained with the old credential
  return credentialsView();
}

export function deleteCredentials() {
  fs.rmSync(config.apiCredentialsFile, { force: true });
  saved = null;
  token = null;
}

const isFresh = (t) => t && (!t.expiresAt || t.expiresAt - EXPIRY_SKEW_MS > Date.now());

// Gets an access token with the saved credential. Returns the cached one while it is valid,
// unless force is set. Throws CredentialsError.
export async function getAccessToken({ force = false } = {}) {
  if (!saved) throw new CredentialsError('No API credential saved. Save one on the API credentials page (/admin/api).');
  if (!force && isFresh(token)) return token;

  const basic = Buffer.from(`${encodeURIComponent(saved.clientId)}:${encodeURIComponent(saved.clientSecret)}`).toString('base64');
  let res;
  let json = null;
  try {
    res = await fetch(tokenUrl(), {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    json = JSON.parse(await res.text());
  } catch (err) {
    if (!res) throw new CredentialsError(`Could not reach ${tokenUrl()}: ${err.cause?.message || err.message}`);
  }
  if (res.status !== 200 || !json?.access_token) {
    token = null;
    // CloakTail's OAuth error code and description name the problem without echoing the secret.
    const reason = [json?.error, json?.error_description].filter(Boolean).join(': ');
    throw new CredentialsError(`CloakTail answered ${res.status}${reason ? ` (${reason})` : ''}: no access token.`);
  }
  const expiresIn = Number(json.expires_in) || null;
  token = {
    value: json.access_token,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    scope: json.scope ?? null,
    obtainedAt: Date.now(),
  };
  return token;
}

// The token to attach to an API call: the cached one (renewed if it expired), or none if no
// token has been asked for yet.
export const currentToken = async () => (token ? getAccessToken() : null);
