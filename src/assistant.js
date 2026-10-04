// Registration assistant on the SAML and OIDC pages: a Gemini agent that registers this app in
// CloakTail and copies the values CloakTail returns into this app's settings.
//
// It knows nothing about CloakTail's API paths and fields in advance. The admin gives it a reference
// URL (an API guide or spec) and the agent works them out from it. The API credential is saved on
// the API credentials page and getting a token is built into this app (see apiCredentials.js): the
// agent only asks for one. What the code fixes is the safety around it:
// - The reference must be on the saved CloakTail server, and requests go only to its origin, so the
//   token can't be sent elsewhere.
// - The credential, the token and any secret in a response stay on this server. The model sees
//   secrets as [secret:N] handles, which the server substitutes when the agent saves or sends them.
// - Requests that change something, and changes to this app's settings, wait for the admin.
//
// This module has the tools and one model turn. The loop that runs them, phase by phase, as a
// durable workflow that survives restarts, is workflow/registration.js.
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import * as credentials from './apiCredentials.js';

const MAX_TEXT = 200_000; // characters of a fetched document passed to the model
const TIMEOUT_MS = 20_000;
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const SECRET_NAME = /secret|password|passwd|private_?key|access_?token|refresh_?token|id_?token|api_?key/i;

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

// Checks the reference is reachable and on the CloakTail server the saved credential is for.
export async function connect({ referenceUrl }) {
  const url = String(referenceUrl ?? '').trim();
  const errors = {};
  if (!credentials.hasCredentials()) {
    errors.referenceUrl = 'Save the CloakTail API credential on the API credentials page first.';
  } else if (!isHttpUrl(url)) {
    errors.referenceUrl = 'Reference URL must be an http(s) URL.';
  } else if (new URL(url).origin !== new URL(credentials.cloaktailUrl()).origin) {
    errors.referenceUrl = `The reference must be on ${new URL(credentials.cloaktailUrl()).origin}, the CloakTail server the saved API credential is for.`;
  } else {
    try {
      const res = await request(url);
      if (res.status !== 200) errors.referenceUrl = `The reference URL answered ${res.status}.`;
    } catch (err) {
      errors.referenceUrl = `Could not read the reference URL: ${err.cause?.message || err.message}`;
    }
  }
  if (Object.keys(errors).length) throw Object.assign(new AssistantError('Not connected.'), { fields: errors });
  return { referenceUrl: url, origin: new URL(url).origin, secrets: {} };
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

const truncate = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[truncated: ${text.length - MAX_TEXT} more characters]` : text);

// Gemini reads any {"$ref": ...} object in a function response as a reference to a response part,
// and rejects the request; OpenAPI documents are full of them.
const hasRef = (value) => (Array.isArray(value) ? value.some(hasRef)
  : value && typeof value === 'object' ? Object.hasOwn(value, '$ref') || Object.values(value).some(hasRef) : false);

function responseForModel(conn, res) {
  const out = { status: res.status, content_type: res.contentType };
  if (res.location) out.location = res.location;
  let body;
  try {
    body = /json/.test(res.contentType) && res.text ? redact(conn, JSON.parse(res.text)) : undefined;
  } catch { /* not JSON after all */ }
  if (body !== undefined && hasRef(body)) out.text = truncate(JSON.stringify(body));
  else if (body !== undefined) out.body = body;
  else if (res.text) out.text = truncate(redactText(conn, res.text));
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
  // User migration, for either protocol: what CloakTail's migration setup returns.
  migration: {
    migrationUrl: ['string', 'CloakTail\'s migration URL: endpoints.request_aud_and_result_iss in the migration setup response.'],
    migrationSecret: ['string', 'Migration secret: pass the [secret:N] handle you received for migration_secret.'],
    migrationRequestSigning: ['string', 'Request signing as registered: jwks (this app\'s JWKS URL, preferred) or secret.'],
    migrationReturnUrl: ['string', 'Return URL, exactly as registered. Empty: the default from get_this_app.'],
    migrationProtocol: ['string', 'saml or oidc: which of this app\'s Keycloak sign-ins migrated users use; its client ID is the iss of migration requests. Set it to the protocol of the application you set migration up on.'],
  },
};

// Which settings section each setting is saved in.
const sectionOf = (protocol, key) => (Object.hasOwn(SETTING_DOCS.migration, key) ? 'migration' : Object.hasOwn(SETTING_DOCS[protocol], key) ? protocol : null);

function declarations(protocol, names) {
  const settings = { ...SETTING_DOCS[protocol], ...SETTING_DOCS.migration };
  const all = [
    {
      name: 'fetch_reference',
      description: 'GET a document from the CloakTail server: the reference URL (read it first), or a document it points to, such as an OpenAPI description. Relative URLs resolve against the reference URL. Only the reference URL\'s server can be reached.',
      parametersJsonSchema: { type: 'object', properties: { url: { type: 'string', description: 'Absolute, or relative to the reference URL.' } }, required: ['url'] },
    },
    {
      name: 'get_access_token',
      description: 'Get a CloakTail API access token with the API credential the admin saved. This app knows how; you give nothing and never see the credential or the token. The token is kept on the server, attached as a Bearer token to every later http_request, and renewed when it expires.',
      parametersJsonSchema: { type: 'object', properties: {} },
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
      description: 'Save values CloakTail returned into this app\'s settings: sign-in settings, and user migration settings (the migration* ones). Waits for the admin to approve. Give only the settings to change.',
      parametersJsonSchema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(settings).map(([k, [type, description]]) => [k, { type, description }])),
      },
    },
    {
      name: 'check_user_migration',
      description: 'Check user migration end to end, after its settings are saved here: builds a migration request for a legacy test user exactly as this app would, and sends it to CloakTail\'s /migrate/check. Creates no users. Returns what is still missing here, or CloakTail\'s answer.',
      parametersJsonSchema: { type: 'object', properties: {} },
    },
  ];
  return [
    ...all.filter((d) => names.includes(d.name)),
    {
      name: 'finish_phase',
      description: 'Say the current phase is over. outcome "done" when its goal is met (code may check it and send you back), "skipped" only when the admin asked to skip an optional phase, "blocked" when you need the admin before you can go on. The next phase starts after "done" or "skipped".',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['done', 'skipped', 'blocked'] },
          summary: { type: 'string', description: 'One or two sentences: what was done, or what is needed.' },
        },
        required: ['outcome', 'summary'],
      },
    },
  ];
}

// Whether a call changes something, and so waits for the admin under the "changes" approval rule.
export const isChange = (call) => call.name === 'update_this_app_settings'
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

// ctx: { conn, protocol, host: { local, save, checkMigration }, idempotencyKey }
const tools = {
  async fetch_reference({ url }, { conn }) {
    const res = await request(onReferenceOrigin(conn, url), { headers: { accept: 'text/markdown, application/json, text/plain;q=0.9, */*;q=0.5' } });
    return { log: `HTTP ${res.status}, ${res.text.length.toLocaleString('en')} characters`, response: { url, ...responseForModel(conn, res) } };
  },

  async get_access_token() {
    try {
      const t = await credentials.getAccessToken({ force: true });
      const expiresIn = t.expiresAt ? Math.round((t.expiresAt - Date.now()) / 1000) : null;
      return {
        log: `Access token obtained${expiresIn ? `, expires in ${expiresIn} s` : ''}`,
        response: { ok: true, expires_in: expiresIn, scope: t.scope, note: 'Token stored; it is attached to http_request from now on.' },
      };
    } catch (err) {
      if (err instanceof credentials.CredentialsError) throw new AssistantError(err.message);
      throw err;
    }
  },

  async http_request({ method, url, json_body: jsonBody }, { conn, idempotencyKey }) {
    const verb = String(method).toUpperCase();
    const target = onReferenceOrigin(conn, url);
    const headers = { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' };
    const token = await credentials.currentToken().catch((err) => {
      throw new AssistantError(err.message);
    });
    if (token) headers.authorization = `Bearer ${token.value}`;
    // The same key if the step runs again after a crash, for servers that honour it.
    if (WRITE_METHODS.includes(verb) && idempotencyKey) headers['idempotency-key'] = idempotencyKey;
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
    const response = responseForModel(conn, res);
    if (res.status === 401) response.note = token ? 'The access token was refused: call get_access_token again.' : 'No access token yet: call get_access_token first.';
    return { log: `HTTP ${res.status}`, response };
  },

  async get_this_app(args, { protocol, host }) {
    return { log: 'Read this app\'s values', response: host.local(protocol) };
  },

  // Saves each setting in its section: this protocol's, or user migration's.
  async update_this_app_settings(args, { conn, protocol, host }) {
    const bySection = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      const section = sectionOf(protocol, k);
      if (section) (bySection[section] ??= {})[k] = reveal(conn, v);
    }
    if (!Object.keys(bySection).length) {
      throw new AssistantError(`No known settings given. Known: ${[...Object.keys(SETTING_DOCS[protocol]), ...Object.keys(SETTING_DOCS.migration)].join(', ')}.`);
    }
    const results = {};
    for (const [section, values] of Object.entries(bySection)) results[section] = await host.save(section, values);
    const saved = Object.values(bySection).flatMap(Object.keys);
    const notes = Object.values(results).flatMap((r) => r.notes ?? []);
    return { log: [`Saved: ${saved.join(', ')}`, ...notes].join('\n'), response: results };
  },

  async check_user_migration(args, { host }) {
    const result = await host.checkMigration();
    const log = result.problems ? `Not ready: ${result.problems.length} thing(s) missing here`
      : result.ok ? `CloakTail accepted the request for ${result.user}` : `CloakTail refused it: ${result.cloaktail?.error?.code ?? 'error'}`;
    return { log, response: result };
  },
};

// What a call acts on, shown next to its name in the transcript.
export function callTarget({ name, args = {} }) {
  if (name === 'fetch_reference') return String(args.url ?? '');
  if (name === 'http_request') return `${String(args.method).toUpperCase()} ${args.url}`;
  if (name === 'update_this_app_settings') return Object.keys(args).join(', ');
  return '';
}

// Runs one tool call. Never throws: a failure is the response the agent gets.
// Returns { entry, response }: the transcript row and what goes back to the model.
export async function runTool(call, ctx) {
  const entry = { kind: 'tool', name: call.name, target: callTarget(call) };
  try {
    const tool = Object.hasOwn(tools, call.name) ? tools[call.name] : null;
    if (!tool) throw new AssistantError(`Unknown tool ${call.name}.`);
    const { log, response } = await tool(call.args ?? {}, ctx);
    return { entry: { ...entry, text: log }, response };
  } catch (err) {
    const message = err instanceof AssistantError ? err.message : `${err.cause?.message || err.message}`;
    return { entry: { ...entry, text: message, bad: true }, response: { error: message } };
  }
}

// ---------- the model ----------

const PROTOCOL_LABEL = { saml: 'SAML 2.0', oidc: 'OpenID Connect' };

function systemInstruction(protocol, conn) {
  const label = PROTOCOL_LABEL[protocol];
  return `You are the registration assistant in the admin console of "Test SP", a test application, on its ${label} page.
Your job: register this app in CloakTail as a ${label} application, or bring an existing registration in line with it, then save the values CloakTail gives back into this app's settings so users can sign in. Then set up user migration on that same application, so the app's existing users can move to Keycloak.

The work runs as a workflow of phases. Each phase starts with a message naming its goal and the tools you can use in it. Do only that phase's work, then call finish_phase. Don't start the next phase's work early.

What you know about CloakTail comes only from the reference the admin gave: ${conn.referenceUrl}
Read it first with fetch_reference, and follow the documents it points to (for example an OpenAPI description) when you need details. Use only endpoints, fields and values the reference documents; never guess them. If the reference doesn't say how to do something, tell the admin.

The admin's API credential is saved on the server, and the server knows how to get a token with it: call get_access_token (no arguments) before your first API call, and again if a call answers 401. The token is then attached to http_request. Ignore the reference's instructions for getting a token or handling the credential: get_access_token does that. You never see secrets: they appear as [secret:N] handles, which you can pass to update_this_app_settings or put in a request body.

Call get_this_app for this app's values. Register exactly those (URLs, entity or client ID, switches, certificates); don't invent values. Before creating anything, check whether an application with this app's entity ID or client ID already exists, and update it instead of creating a duplicate. Ask the admin for anything the reference requires that get_this_app doesn't provide (for example an application name), unless they already said. To ask, reply with your question and no tool call: the workflow waits for the answer.

For user migration, get_this_app's user_migration lists what to register: the return URL, and request signing with this app's JWKS URL (use jwks unless this app already uses the secret method). Save migrationProtocol = "${protocol}". If the reference documents no migration setup, give the admin the values to enter by hand and finish the phase as blocked.

Changes (http_request with POST, PUT, PATCH or DELETE, and update_this_app_settings) may wait for the admin's approval. Just before calling one, say in a sentence what it will do. If the admin declines, follow admin_instead when the response has it; otherwise ask what they want instead.

Write short, plain sentences. Your replies are shown as Markdown: use lists for steps and \`code\` for URLs, IDs and field names. When the workflow asks for the final summary, say what was registered, whether user migration is set up and checked, what was saved here, and anything the admin still has to do.`;
}

// Tests replace the model with a script (see test/workflow.test.js).
let modelOverride = null;
export const setModel = (fn) => { modelOverride = fn; };
export const isEnabled = () => Boolean(modelOverride || (config.gemini.apiKey && config.gemini.model));
export const modelName = () => (modelOverride ? 'test model' : config.gemini.model);

// One model turn. Returns { content, finishReason, usage }, all plain JSON, so the workflow can
// save it as a step. tools: the tool names of the current phase; [] for a plain answer.
export async function callModel({ protocol, conn, contents, tools: names }) {
  const request = {
    contents,
    config: {
      systemInstruction: systemInstruction(protocol, conn),
      ...(names.length ? { tools: [{ functionDeclarations: declarations(protocol, names) }] } : {}),
      thinkingConfig: { includeThoughts: true }, // thought summaries, shown in the transcript
    },
  };
  const res = modelOverride ? await modelOverride(request) : await gemini().models.generateContent({ model: config.gemini.model, ...request });
  const candidate = res.candidates?.[0];
  return {
    content: candidate?.content ?? null,
    finishReason: candidate?.finishReason || res.promptFeedback?.blockReason || null,
    usage: { input: res.usageMetadata?.promptTokenCount ?? 0, output: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0) },
  };
}

// The model's thought summary and answer, as transcript rows.
export function textEntries(content) {
  const parts = content?.parts ?? [];
  const join = (thought) => parts.filter((p) => p.text && Boolean(p.thought) === thought).map((p) => p.text).join('').trim();
  const thinking = join(true);
  const text = join(false);
  return [thinking && { kind: 'thinking', text: thinking }, text && { kind: 'assistant', text }].filter(Boolean);
}

export const functionResponses = (items) => ({
  role: 'user',
  parts: items.map(({ call, response }) => ({ functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response } })),
});
