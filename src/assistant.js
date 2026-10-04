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
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import * as credentials from './apiCredentials.js';

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

function declarations(protocol) {
  const settings = { ...SETTING_DOCS[protocol], ...SETTING_DOCS.migration };
  return [
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

  async http_request({ method, url, json_body: jsonBody }, { conn }) {
    const verb = String(method).toUpperCase();
    const target = onReferenceOrigin(conn, url);
    const headers = { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' };
    const token = await credentials.currentToken().catch((err) => {
      throw new AssistantError(err.message);
    });
    if (token) headers.authorization = `Bearer ${token.value}`;
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

  async get_this_app(args, { protocol, local }) {
    return { log: 'Read this app\'s values', response: local(protocol) };
  },

  // Saves each setting in its section: this protocol's, or user migration's.
  async update_this_app_settings(args, { conn, protocol, save }) {
    const bySection = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      const section = sectionOf(protocol, k);
      if (section) (bySection[section] ??= {})[k] = reveal(conn, v);
    }
    if (!Object.keys(bySection).length) {
      throw new AssistantError(`No known settings given. Known: ${[...Object.keys(SETTING_DOCS[protocol]), ...Object.keys(SETTING_DOCS.migration)].join(', ')}.`);
    }
    const results = {};
    for (const [section, values] of Object.entries(bySection)) results[section] = await save(section, values);
    const saved = Object.values(bySection).flatMap(Object.keys);
    const notes = Object.values(results).flatMap((r) => r.notes ?? []);
    return { log: [`Saved: ${saved.join(', ')}`, ...notes].join('\n'), response: results };
  },

  async check_user_migration(args, { checkMigration }) {
    const result = await checkMigration();
    const log = result.problems ? `Not ready: ${result.problems.length} thing(s) missing here`
      : result.ok ? `CloakTail accepted the request for ${result.user}` : `CloakTail refused it: ${result.cloaktail?.error?.code ?? 'error'}`;
    return { log, response: result };
  },
};

// What a call acts on, shown next to its name in the transcript.
function callTarget({ name, args = {} }) {
  if (name === 'fetch_reference') return String(args.url ?? '');
  if (name === 'http_request') return `${String(args.method).toUpperCase()} ${args.url}`;
  if (name === 'update_this_app_settings') return Object.keys(args).join(', ');
  return '';
}

async function runTool(call, ctx) {
  const entry = { kind: 'tool', name: call.name, target: callTarget(call) };
  try {
    const tool = Object.hasOwn(tools, call.name) ? tools[call.name] : null;
    if (!tool) throw new AssistantError(`Unknown tool ${call.name}.`);
    const { log, response } = await tool(call.args ?? {}, ctx);
    ctx.state.log.push({ ...entry, text: log });
    return response;
  } catch (err) {
    const message = err instanceof AssistantError ? err.message : `${err.cause?.message || err.message}`;
    ctx.state.log.push({ ...entry, text: message, bad: true });
    return { error: message };
  }
}

// ---------- conversation ----------

export const newConversation = () => ({ contents: [], log: [], pending: null });

const PROTOCOL_LABEL = { saml: 'SAML 2.0', oidc: 'OpenID Connect' };

function systemInstruction(protocol, conn) {
  const label = PROTOCOL_LABEL[protocol];
  return `You are the registration assistant in the admin console of "Test SP", a test application, on its ${label} page.
Your job: register this app in CloakTail as a ${label} application, or bring an existing registration in line with it, then save the values CloakTail gives back into this app's settings so users can sign in. Then set up user migration on that same application, so the app's existing users can move to Keycloak.

What you know about CloakTail comes only from the reference the admin gave: ${conn.referenceUrl}
Read it first with fetch_reference, and follow the documents it points to (for example an OpenAPI description) when you need details. Use only endpoints, fields and values the reference documents; never guess them. If the reference doesn't say how to do something, tell the admin.

The admin's API credential is saved on the server, and the server knows how to get a token with it: call get_access_token (no arguments) before your first API call, and again if a call answers 401. The token is then attached to http_request. Ignore the reference's instructions for getting a token or handling the credential: get_access_token does that. You never see secrets: they appear as [secret:N] handles, which you can pass to update_this_app_settings or put in a request body.

Call get_this_app for this app's values. Register exactly those (URLs, entity or client ID, switches, certificates); don't invent values. Before creating anything, check whether an application with this app's entity ID or client ID already exists, and update it instead of creating a duplicate. Ask the admin for anything the reference requires that get_this_app doesn't provide (for example an application name), unless they already said.

User migration comes after the registration and its settings are saved. Follow the reference's user migration instructions, on the application you just registered. get_this_app's user_migration lists what to register: the return URL, and request signing with this app's JWKS URL (use jwks unless this app already uses the secret method). Read the existing migration setup first and keep what matches. Then save into this app, in one update_this_app_settings call: migrationUrl (CloakTail's migration URL from the setup response), migrationSecret (the [secret:N] handle of the migration secret), migrationRequestSigning, migrationReturnUrl if it differs from the default, and migrationProtocol = "${protocol}". Finally call check_user_migration and report the result. If the reference documents no migration setup, give the admin these values to enter by hand.

http_request calls that change something (POST, PUT, PATCH, DELETE) and update_this_app_settings wait for the admin's approval. Just before calling one, say in a sentence what it will do. If the admin declines, follow admin_instead when the response has it; otherwise ask what they want instead.

Write short, plain sentences. Your replies are shown as Markdown: use lists for steps and \`code\` for URLs, IDs and field names. When you finish, say what was registered, whether user migration is set up and checked, what was saved here, and anything the admin still has to do.`;
}

// Adds the model's thought summary, then its answer, to the transcript.
function addText(state, content) {
  const parts = content?.parts ?? [];
  const join = (thought) => parts.filter((p) => p.text && Boolean(p.thought) === thought).map((p) => p.text).join('').trim();
  const thinking = join(true);
  const text = join(false);
  if (thinking) state.log.push({ kind: 'thinking', text: thinking });
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
        config: {
          systemInstruction: systemInstruction(protocol, conn),
          tools: [{ functionDeclarations: declarations(protocol) }],
          thinkingConfig: { includeThoughts: true }, // thought summaries, shown in the transcript
        },
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

// note: when declining, what the admin wants instead (optional); it reaches the model with the refusal.
export async function decide(ctx, approved, note = '') {
  const { state } = ctx;
  if (!state.pending) return;
  const { calls, responses } = state.pending;
  state.pending = null;
  const instead = approved ? '' : String(note ?? '').trim();
  for (const call of calls) {
    if (approved) {
      state.log.push({ kind: 'approval', text: `Approved: ${call.title}` });
      responses.push({ call, response: await runTool({ id: call.id, name: call.name, args: call.args }, ctx) });
    } else {
      state.log.push({ kind: 'approval', text: `Declined: ${call.title}`, bad: true });
      responses.push({ call, response: { error: 'The admin declined this step.', ...(instead ? { admin_instead: instead } : {}) } });
    }
  }
  if (instead) state.log.push({ kind: 'user', text: instead });
  state.contents.push(functionResponses(responses));
  await advance(ctx);
}
