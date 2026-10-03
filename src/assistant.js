// Registration assistant on the SAML and OIDC pages: a Gemini agent that registers this app in
// CloakTail and copies the values CloakTail returns into this app's settings.
//
// It knows nothing about CloakTail's API in advance. The admin gives it a reference URL (an API
// guide or spec) and an API credential; the agent reads the reference and works out the token
// endpoint, the paths and the fields from it. What the code does fix is the safety around it:
// - Requests go only to the reference URL's origin, so the credential can't be sent elsewhere.
// - The credential and any secret in a response stay on this server. The model sees secrets as
//   [secret:N] handles, which the server substitutes when the agent saves or sends them.
// - Requests that change something, and changes to this app's settings, wait for the admin.
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

const MAX_STEPS = 12; // model calls per message or approval
const MAX_TEXT = 200_000; // characters of a fetched document passed to the model
const TIMEOUT_MS = 20_000;
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const SECRET_NAME = /secret|password|passwd|private_?key|access_?token|refresh_?token|id_?token|api_?key/i;

export const isEnabled = () => Boolean(config.gemini.apiKey && config.gemini.model);

let ai = null;
const gemini = () => (ai ??= new GoogleGenAI({ apiKey: config.gemini.apiKey }));

export class AssistantError extends Error {}

const isHttpUrl = (v) => {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};

async function request(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, contentType: res.headers.get('content-type') || '', location: res.headers.get('location'), text: await res.text() };
}

// ---------- connection (held in the admin's session, in memory only) ----------

// Checks the reference is reachable. The credential is only checked when the agent first uses it,
// since where and how to use it is in the reference.
export async function connect({ referenceUrl, clientId, clientSecret }) {
  const url = String(referenceUrl ?? '').trim();
  const id = String(clientId ?? '').trim();
  const secret = String(clientSecret ?? '').trim();
  const errors = {};
  if (!isHttpUrl(url)) errors.referenceUrl = 'Reference URL must be an http(s) URL.';
  if (!id) errors.clientId = 'Client ID is required.';
  if (!secret) errors.clientSecret = 'Client secret is required.';
  if (!errors.referenceUrl) {
    try {
      const res = await request(url);
      if (res.status !== 200) errors.referenceUrl = `The reference URL answered ${res.status}.`;
    } catch (err) {
      errors.referenceUrl = `Could not read the reference URL: ${err.cause?.message || err.message}`;
    }
  }
  if (Object.keys(errors).length) throw Object.assign(new AssistantError('Not connected.'), { fields: errors });
  return { referenceUrl: url, origin: new URL(url).origin, clientId: id, clientSecret: secret, token: null, secrets: {} };
}

// Resolves a URL the model gave against the reference, and keeps it on the reference's origin.
function onReferenceOrigin(conn, value) {
  let url;
  try {
    url = new URL(String(value ?? ''), conn.referenceUrl);
  } catch {
    throw new AssistantError(`Not a URL: ${value}`);
  }
  if (url.origin !== conn.origin) throw new AssistantError(`Only ${conn.origin} can be called (the reference URL's server); ${url.origin} was refused.`);
  return url.href;
}

// ---------- secrets ----------

function hide(conn, value) {
  const existing = Object.entries(conn.secrets).find(([, v]) => v === value)?.[0];
  if (existing) return existing;
  const handle = `[secret:${Object.keys(conn.secrets).length + 1}]`;
  conn.secrets[handle] = value;
  return handle;
}

// Replaces secret-looking values (by key name) with handles, in JSON or dotenv-style text.
function redact(conn, value, key = '') {
  if (Array.isArray(value)) return value.map((v) => redact(conn, v, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(conn, v, k)]));
  if (typeof value === 'string' && value && SECRET_NAME.test(key) && !isHttpUrl(value)) return hide(conn, value);
  return value;
}
const redactText = (conn, text) => text.replace(/^([A-Za-z0-9_.-]*?)(\s*[=:]\s*)(\S.*)$/gm,
  (line, k, sep, v) => (SECRET_NAME.test(k) ? `${k}${sep}${hide(conn, v.trim())}` : line));

function reveal(conn, value) {
  if (Array.isArray(value)) return value.map((v) => reveal(conn, v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reveal(conn, v)]));
  if (typeof value === 'string') return value.replace(/\[secret:\d+\]/g, (h) => conn.secrets[h] ?? h);
  return value;
}

function responseForModel(conn, res) {
  const out = { status: res.status, content_type: res.contentType };
  if (res.location) out.location = res.location;
  let body;
  try {
    body = /json/.test(res.contentType) && res.text ? redact(conn, JSON.parse(res.text)) : undefined;
  } catch { /* not JSON after all */ }
  if (body !== undefined) out.body = body;
  else if (res.text) {
    const text = redactText(conn, res.text);
    out.text = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[truncated: ${text.length - MAX_TEXT} more characters]` : text;
  }
  return out;
}

// ---------- tools ----------

// This app's own settings the agent may fill, per protocol (baseUrl is the admin's to change).
const SETTING_DOCS = {
  saml: {
    idpMetadataUrl: ['string', 'IdP metadata URL (the IdP signing certificate is read from it).'],
    idpEntityId: ['string', 'IdP entity ID (issuer).'],
    idpSsoUrl: ['string', 'IdP single sign-on URL (HTTP-Redirect/POST endpoint).'],
    idpSloUrl: ['string', 'IdP single logout URL; empty for local sign-out only.'],
    idpInitiatedUrl: ['string', 'IdP-initiated login URL, if the registration has one.'],
    idpCert: ['string', 'IdP signing certificate (PEM or base64). Empty: read from the metadata URL. Prefer empty when a metadata URL exists.'],
    entityId: ['string', 'This app\'s SP entity ID, exactly as registered. Empty: the default from get_this_app.'],
    nameIdFormat: ['string', 'Name ID format as a full URN (urn:oasis:names:tc:SAML:...). Empty: accept any.'],
    expectedAttributes: ['string', 'Comma-separated attribute names the IdP sends.'],
    wantResponseSigned: ['boolean', 'Require a signed SAML response.'],
    wantAssertionsSigned: ['boolean', 'Require signed assertions.'],
    signRequests: ['boolean', 'Sign AuthnRequests with this app\'s signing key.'],
    decryptAssertions: ['boolean', 'Expect encrypted assertions (decrypted with this app\'s encryption key).'],
  },
  oidc: {
    oidcIssuer: ['string', 'OpenID provider issuer URL.'],
    oidcClientId: ['string', 'Client ID, exactly as registered.'],
    oidcClientSecret: ['string', 'Client secret: pass the [secret:N] handle you received. Empty for a public client.'],
    oidcScopes: ['string', 'Space-separated scopes; must include openid.'],
    oidcUsePkce: ['boolean', 'Send PKCE (S256).'],
    oidcExpectedClaims: ['string', 'Comma-separated claims expected in the ID token or userinfo.'],
  },
};

function declarations(protocol) {
  const settings = SETTING_DOCS[protocol];
  return [
    {
      name: 'fetch_reference',
      description: 'GET a document from the CloakTail server: the reference URL (read it first), or a document it points to, such as an OpenAPI description. Relative URLs resolve against the reference URL. Only the reference URL\'s server can be reached.',
      parametersJsonSchema: { type: 'object', properties: { url: { type: 'string', description: 'Absolute, or relative to the reference URL.' } }, required: ['url'] },
    },
    {
      name: 'get_access_token',
      description: 'Get an access token with the OAuth 2.0 client credentials grant, using the API credential the admin entered (you never see it). Use the token endpoint and client authentication the reference documents. The token is kept on the server and sent as a Bearer token on every later http_request.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          token_url: { type: 'string', description: 'Token endpoint, from the reference.' },
          client_auth: { type: 'string', enum: ['client_secret_basic', 'client_secret_post'], description: 'How to send the credential, as the reference says. Default client_secret_basic.' },
          scope: { type: 'string', description: 'Space-separated scopes, if the reference says to request specific ones.' },
        },
        required: ['token_url'],
      },
    },
    {
      name: 'http_request',
      description: 'Call the CloakTail API as the reference documents it, with the access token attached. GET runs at once; POST, PUT, PATCH and DELETE wait for the admin to approve. Secrets in responses come back as [secret:N] handles; handles in a body are replaced with the real value before sending.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', ...WRITE_METHODS] },
          url: { type: 'string', description: 'Absolute, or relative to the reference URL. Include any query string.' },
          json_body: { type: 'string', description: 'Request body as JSON text, for methods that take one.' },
        },
        required: ['method', 'url'],
      },
    },
    {
      name: 'get_this_app',
      description: 'This app\'s own values to register (URLs, entity or client ID, switches, certificates) and its current settings. Register exactly these values.',
      parametersJsonSchema: { type: 'object', properties: {} },
    },
    {
      name: 'update_this_app_settings',
      description: 'Save values CloakTail returned into this app\'s settings, so it can sign users in. Waits for the admin to approve. Give only the settings to change.',
      parametersJsonSchema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(settings).map(([k, [type, description]]) => [k, { type, description }])),
      },
    },
  ];
}

const needsApproval = (call) => call.name === 'update_this_app_settings'
  || (call.name === 'http_request' && WRITE_METHODS.includes(String(call.args?.method).toUpperCase()));

// What the admin is asked to approve.
export function describeCall(call) {
  const a = call.args ?? {};
  if (call.name === 'http_request') {
    let body = a.json_body;
    try {
      body = body ? JSON.stringify(JSON.parse(body), null, 2) : '';
    } catch { /* show as given */ }
    return { title: `${String(a.method).toUpperCase()} ${a.url}`, detail: body };
  }
  return { title: 'Change this app\'s settings', detail: Object.entries(a).map(([k, v]) => `${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n') };
}

const tools = {
  async fetch_reference({ url }, { conn }) {
    const res = await request(onReferenceOrigin(conn, url), { headers: { accept: 'text/markdown, application/json, text/plain;q=0.9, */*;q=0.5' } });
    return { log: `Read ${url} → ${res.status}`, response: { url, ...responseForModel(conn, res) } };
  },

  async get_access_token({ token_url: tokenUrl, client_auth: auth = 'client_secret_basic', scope }, { conn }) {
    const url = onReferenceOrigin(conn, tokenUrl);
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (scope) form.set('scope', scope);
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (auth === 'client_secret_post') {
      form.set('client_id', conn.clientId);
      form.set('client_secret', conn.clientSecret);
    } else {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(conn.clientId)}:${encodeURIComponent(conn.clientSecret)}`).toString('base64')}`;
    }
    const res = await request(url, { method: 'POST', headers, body: form });
    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch { /* reported below */ }
    if (res.status === 200 && json?.access_token) {
      conn.token = { value: json.access_token, expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : null, scope: json.scope ?? null };
      const { access_token: _, ...rest } = json;
      return { log: `Got an access token from ${tokenUrl}`, response: { status: 200, ok: true, ...redact(conn, rest), note: 'Token stored; it is attached to http_request from now on.' } };
    }
    return { log: `Token request to ${tokenUrl} → ${res.status}`, response: responseForModel(conn, res) };
  },

  async http_request({ method, url, json_body: jsonBody }, { conn }) {
    const verb = String(method).toUpperCase();
    const target = onReferenceOrigin(conn, url);
    const headers = { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' };
    if (conn.token) headers.authorization = `Bearer ${conn.token.value}`;
    let body;
    if (jsonBody && verb !== 'GET') {
      try {
        body = JSON.stringify(reveal(conn, JSON.parse(jsonBody)));
      } catch {
        throw new AssistantError('json_body is not valid JSON.');
      }
      headers['content-type'] = 'application/json';
    }
    const res = await request(target, { method: verb, headers, body });
    const expired = conn.token?.expiresAt && conn.token.expiresAt < Date.now();
    const response = responseForModel(conn, res);
    if (res.status === 401 && expired) response.note = 'The access token has expired: call get_access_token again.';
    return { log: `${verb} ${url} → ${res.status}`, response };
  },

  async get_this_app(args, { protocol, local }) {
    return { log: 'Read this app\'s values', response: local(protocol) };
  },

  async update_this_app_settings(args, { conn, protocol, save }) {
    const keys = Object.keys(SETTING_DOCS[protocol]);
    const values = Object.fromEntries(Object.entries(args ?? {}).filter(([k]) => keys.includes(k)).map(([k, v]) => [k, reveal(conn, v)]));
    if (!Object.keys(values).length) throw new AssistantError(`No known settings given. Known: ${keys.join(', ')}.`);
    const result = await save(protocol, values);
    return { log: `Saved ${Object.keys(values).join(', ')}`, response: result };
  },
};

async function runTool(call, ctx) {
  try {
    const tool = Object.hasOwn(tools, call.name) ? tools[call.name] : null;
    if (!tool) throw new AssistantError(`Unknown tool ${call.name}.`);
    const { log, response } = await tool(call.args ?? {}, ctx);
    ctx.state.log.push({ kind: 'tool', text: log });
    return response;
  } catch (err) {
    const message = err instanceof AssistantError ? err.message : `${err.cause?.message || err.message}`;
    ctx.state.log.push({ kind: 'tool', text: `${call.name} failed: ${message}`, bad: true });
    return { error: message };
  }
}

// ---------- conversation ----------

export const newConversation = () => ({ contents: [], log: [], pending: null });

const PROTOCOL_LABEL = { saml: 'SAML 2.0', oidc: 'OpenID Connect' };

function systemInstruction(protocol, conn) {
  const label = PROTOCOL_LABEL[protocol];
  return `You are the registration assistant in the admin console of "Test SP", a test application, on its ${label} page.
Your job: register this app in CloakTail as a ${label} application, or bring an existing registration in line with it, then save the values CloakTail gives back into this app's settings so users can sign in.

What you know about CloakTail comes only from the reference the admin gave: ${conn.referenceUrl}
Read it first with fetch_reference, and follow the documents it points to (for example an OpenAPI description) when you need details. Use only endpoints, fields and values the reference documents; never guess them. If the reference doesn't say how to do something, tell the admin.

The admin's API credential is held by the server. Find the token endpoint and client authentication in the reference and call get_access_token; the token is then attached to http_request. You never see secrets: they appear as [secret:N] handles, which you can pass to update_this_app_settings or put in a request body.

Call get_this_app for this app's values. Register exactly those (URLs, entity or client ID, switches, certificates); don't invent values. Before creating anything, check whether an application with this app's entity ID or client ID already exists, and update it instead of creating a duplicate. Ask the admin for anything the reference requires that get_this_app doesn't provide (for example an application name), unless they already said.

http_request calls that change something (POST, PUT, PATCH, DELETE) and update_this_app_settings wait for the admin's approval. Just before calling one, say in a sentence what it will do. If the admin declines, ask what they want instead.

Write short, plain sentences. When you finish, say what was registered, what was saved here, and anything the admin still has to do.`;
}

function addText(state, content) {
  const text = (content?.parts ?? []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
  if (text) state.log.push({ kind: 'assistant', text });
}

// Runs the model until it answers without calling tools, or a call needs approval.
async function advance(ctx) {
  const { state, protocol, conn } = ctx;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    let res;
    try {
      res = await gemini().models.generateContent({
        model: config.gemini.model,
        contents: state.contents,
        config: { systemInstruction: systemInstruction(protocol, conn), tools: [{ functionDeclarations: declarations(protocol) }] },
      });
    } catch (err) {
      state.log.push({ kind: 'error', text: `Gemini: ${err.message}` });
      return;
    }
    const content = res.candidates?.[0]?.content;
    if (!content?.parts?.length) {
      state.log.push({ kind: 'error', text: `Gemini returned no answer (${res.candidates?.[0]?.finishReason || res.promptFeedback?.blockReason || 'unknown reason'}).` });
      return;
    }
    state.contents.push(content);
    addText(state, content);

    const calls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) return;
    const responses = [];
    const waiting = [];
    for (const call of calls) {
      if (needsApproval(call)) waiting.push(call);
      else responses.push({ call, response: await runTool(call, ctx) });
    }
    if (waiting.length) {
      state.pending = { calls: waiting.map((c) => ({ ...c, ...describeCall(c) })), responses };
      return;
    }
    state.contents.push(functionResponses(responses));
  }
  state.log.push({ kind: 'error', text: `Stopped after ${MAX_STEPS} steps. Send a message to continue.` });
}

const functionResponses = (items) => ({
  role: 'user',
  parts: items.map(({ call, response }) => ({ functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response } })),
});

// ctx: { state, protocol, conn, local(protocol), save(protocol, values) }
export async function send(ctx, message) {
  const { state } = ctx;
  if (state.pending) throw new AssistantError('Approve or decline the pending step first.');
  const text = String(message ?? '').trim();
  if (!text) throw new AssistantError('Type a message.');
  state.log.push({ kind: 'user', text });
  state.contents.push({ role: 'user', parts: [{ text }] });
  await advance(ctx);
}

export async function decide(ctx, approved) {
  const { state } = ctx;
  if (!state.pending) return;
  const { calls, responses } = state.pending;
  state.pending = null;
  for (const call of calls) {
    if (approved) {
      state.log.push({ kind: 'approval', text: `Approved: ${call.title}` });
      responses.push({ call, response: await runTool({ id: call.id, name: call.name, args: call.args }, ctx) });
    } else {
      state.log.push({ kind: 'approval', text: `Declined: ${call.title}`, bad: true });
      responses.push({ call, response: { error: 'The admin declined this step.' } });
    }
  }
  state.contents.push(functionResponses(responses));
  await advance(ctx);
}
