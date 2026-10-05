// The admin console's "How the AI assistant works" page: the registration assistant's design, in two
// views. Overview is for anyone deciding whether to use or extend it; Engineering is for whoever
// changes the code (assistant.js, workflow/registration.js, workflow/definitions.js,
// apiCredentials.js and the routes in server.js).
import { icon, layout, pageHead, card, badge, tabs, kv, code } from './ui.js';

const style = `<style>
.arch-diagram { overflow-x: auto; margin: 4px 0 8px; }
.arch-diagram svg { display: block; width: 100%; min-width: 640px; height: auto; }
.dg-box { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.2; }
.dg-group { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1.2; }
.dg-accent { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 1.2; }
.dg-ext { fill: var(--oidc-soft); stroke: var(--oidc); stroke-width: 1.2; }
.dg-ct { fill: var(--saml-soft); stroke: var(--saml); stroke-width: 1.2; }
.dg-title { fill: var(--fg); font-weight: 600; font-size: 13px; }
.dg-sub { fill: var(--muted); font-size: 11px; }
.dg-mono { fill: var(--muted); font-size: 10.5px; font-family: var(--mono); }
.dg-line { stroke: var(--muted); stroke-width: 1.3; fill: none; }
.dg-head { fill: var(--muted); }
.dg-label { fill: var(--fg); font-size: 10.5px; }
.dg-boundary { fill: none; stroke: var(--warn); stroke-width: 1.3; stroke-dasharray: 5 4; }
.dg-warn { fill: var(--warn); font-size: 10.5px; font-weight: 600; }
.arch-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
.arch-tile { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: var(--surface); }
.arch-tile h4 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 14px; }
.arch-tile p { margin: 0; color: var(--muted); }
.arch-tile .icon { color: var(--accent); }
.arch-section + .arch-section { margin-top: 28px; }
.arch-section > h3 { margin: 0 0 4px; font-size: 15px; }
.arch-section > p.lead { margin: 0 0 14px; color: var(--muted); }
.arch-steps { margin: 0; padding-left: 20px; }
.arch-steps li { padding: 4px 0; }
.arch-steps li::marker { color: var(--accent); font-weight: 600; }
.arch-table { width: 100%; border-collapse: collapse; }
.arch-table th, .arch-table td { text-align: left; vertical-align: top; padding: 8px 10px; border-top: 1px solid var(--line); }
.arch-table th { color: var(--muted); font-weight: 500; font-size: 12.5px; border-top: 0; }
.arch-wrap { overflow-x: auto; }
.arch-table td:first-child { white-space: nowrap; }
</style>`;

const section = (title, lead, body) => `<section class="arch-section"><h3>${title}</h3>${lead ? `<p class="lead">${lead}</p>` : ''}${body}</section>`;
const tiles = (items) => `<div class="arch-grid">${items.map(([ic, title, text]) => `<div class="arch-tile"><h4>${icon(ic)}${title}</h4><p>${text}</p></div>`).join('')}</div>`;
const table = (head, rows) => `<div class="arch-wrap"><table class="arch-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

// Which side is which, for the requirements sections of both views.
const SIDES = `<p style="margin:0 0 14px"><strong>Server side</strong>: the system that holds the registrations and is being set up (here, CloakTail). <strong>Client side</strong>: the app that runs the assistant and is being registered (here, this app).</p>`;

// A box with a title and up to three lines under it.
function box(x, y, w, h, cls, title, lines = [], { mono = false } = {}) {
  const cx = x + w / 2;
  const top = y + h / 2 - (lines.length * 15) / 2 + 4;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" class="${cls}"/>
    <text x="${cx}" y="${top}" text-anchor="middle" class="dg-title">${title}</text>
    ${lines.map((l, i) => `<text x="${cx}" y="${top + 16 + i * 15}" text-anchor="middle" class="${mono ? 'dg-mono' : 'dg-sub'}">${l}</text>`).join('')}`;
}
const arrowDefs = (id) => `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M0,0 L10,5 L0,10 z" class="dg-head"/></marker></defs>`;
const line = (id, d, { both = false } = {}) => `<path d="${d}" class="dg-line" marker-end="url(#${id})"${both ? ` marker-start="url(#${id})"` : ''}/>`;
const label = (x, y, text, anchor = 'middle') => `<text x="${x}" y="${y}" text-anchor="${anchor}" class="dg-label">${text}</text>`;

// ---------- Overview ----------

const overviewDiagram = () => {
  const a = 'ov-arrow';
  return `<div class="arch-diagram"><svg viewBox="0 0 780 290" role="img" aria-labelledby="ov-title ov-desc">
    <title id="ov-title">How the assistant is connected</title>
    <desc id="ov-desc">The admin talks to this app. This app sends the AI model only redacted information and gets back a suggested next step. This app makes the calls to CloakTail, and only after the admin approves any change.</desc>
    ${arrowDefs(a)}
    ${box(20, 100, 150, 80, 'dg-box', 'Admin', ['asks in plain words', 'approves each change'])}
    ${box(250, 80, 230, 120, 'dg-accent', 'This app', ['holds the credential and secrets', 'checks every step', 'makes every call'])}
    ${box(580, 20, 180, 90, 'dg-ext', 'AI model (Gemini)', ['reads the docs', 'suggests the next step'])}
    ${box(580, 180, 180, 90, 'dg-ct', 'CloakTail', ['registration API', 'and its documentation'])}
    <rect x="566" y="8" width="208" height="114" rx="12" class="dg-boundary"/>
    <text x="670" y="140" text-anchor="middle" class="dg-warn">never sees passwords or keys</text>
    ${line(a, 'M170,140 L250,140', { both: true })}
    ${label(210, 132, 'chat')}
    ${line(a, 'M480,90 L580,90')}
    ${label(523, 83, 'redacted facts')}
    ${line(a, 'M580,104 L480,104')}
    ${label(523, 119, 'next step')}
    ${line(a, 'M480,175 L580,222', { both: true })}
    ${label(520, 214, 'approved calls only', 'end')}
  </svg></div>`;
};

function overviewView({ model }) {
  return `
    ${section('In one sentence', '', `<p style="margin:0;font-size:15px">An AI assistant registers this app in CloakTail for SAML 2.0 or OpenID Connect, copies what CloakTail returns into this app's settings, and sets up user migration. A person approves every change, and the AI never sees a password or key.</p>`)}

    ${section('The problem it solves', 'Registering an app by hand is four steps across two consoles, and most failures are copy-paste mistakes.', tiles([
      ['shield', 'Many exact values', 'An ACS URL, entity ID, redirect URI, certificates and signing switches must match on both sides, character for character.'],
      ['copy', 'Copying back and forth', 'Values go from this app into CloakTail, and CloakTail\'s answer (issuer, client ID, secrets, migration URL) comes back by hand.'],
      ['warn', 'Errors show up late', 'A typo is usually found only when a test sign-in fails, and the error rarely says which value was wrong.'],
    ]))}

    ${section('How it works', 'What the admin sees, start to finish.', `
      ${overviewDiagram()}
      <ol class="arch-steps">
        <li><strong>Save the API credential once</strong> on <a href="/admin/api">API credentials</a>. This app checks it by getting an access token.</li>
        <li><strong>Connect</strong> on the SAML or OpenID Connect page, and click <em>Register this app</em> or type a request.</li>
        <li><strong>The assistant reads CloakTail's own guide</strong> to learn the API, then reads this app's values (URLs, IDs, certificates).</li>
        <li><strong>It works in six phases</strong>, in order: read the reference, register the app in CloakTail, save the sign-in settings here, set up user migration in CloakTail, save the migration settings here, check user migration. A strip above the chat shows where it is.</li>
        <li><strong>It asks before every change.</strong> Each registration call and each settings change waits for <em>Approve</em>, showing exactly what will be sent.</li>
        <li><strong>This app checks each phase's result</strong> before the next one starts. For example, the sign-in settings must be complete before user migration is set up.</li>
        <li><strong>Progress is saved.</strong> A restart, or an approval left for days, picks up where it stopped. Every run is listed on <a href="/admin/workflows">Workflows</a>.</li>
      </ol>`)}

    ${section('How the values get into this app', 'Registering in CloakTail is half the job. The other half is the values CloakTail gives back, which this app needs before anyone can sign in.', `
      <ol class="arch-steps">
        <li><strong>CloakTail answers the registration</strong> with the values this app needs: where to send users to sign in, how to check their identity, and any secrets.</li>
        <li><strong>The assistant proposes a settings change.</strong> The admin sees a <em>Change this app's settings</em> request listing every value, with secrets shown as placeholders.</li>
        <li><strong>The admin approves.</strong> Nothing is saved before that.</li>
        <li><strong>This app swaps the placeholders for the real secrets</strong> and checks every value exactly as if it had been typed into the settings form. A wrong value is refused and the assistant is told why.</li>
        <li><strong>The settings apply at once</strong>, with no restart. The app reads Keycloak's metadata or discovery document to confirm the values work, and the settings form on the page updates.</li>
      </ol>
      ${table(['What is saved', 'SAML 2.0', 'OpenID Connect'], [
        ['Where users sign in', 'Single sign-on and logout URLs', 'Issuer (the endpoints are discovered from it)'],
        ['Who this app is', 'This app\'s entity ID, as registered', 'Client ID'],
        ['How identity is checked', 'IdP entity ID, metadata URL or signing certificate, signature switches', 'Client secret (confidential clients), PKCE, scopes'],
        ['User migration', 'CloakTail\'s migration URL, the migration secret, how requests are signed', 'The same'],
      ])}`)}

    ${section('Why it is safe', 'The AI decides what to do next; this app decides what is allowed.', tiles([
      ['lock', 'Never sees secrets', 'The API credential, the access token, client secrets and migration secrets stay in this app. The AI sees placeholders such as <code>[secret:1]</code>.'],
      ['globe', 'Talks only to CloakTail', 'Every call goes to the CloakTail server the credential was saved for. Anything else is refused.'],
      ['check', 'A person approves changes', 'Reading is automatic. Creating, changing or deleting in CloakTail, and saving settings here, wait for the admin.'],
      ['code', 'Learns from the docs', 'The assistant reads CloakTail\'s published guide instead of having the API built in, so it follows the API as it changes.'],
    ]))}

    ${section('What exists today', '', `${kv([
      ['Built', 'SAML 2.0 and OpenID Connect registration, settings filled from CloakTail, user migration setup and check, run as a durable workflow that survives restarts.'],
      ['AI model', `Google Gemini (${model ? code(model) : 'set <code>GEMINI_MODEL</code>'}). Any model that can call tools would work.`],
      ['Where', 'This test app only. It has no admin sign-in, so it runs on localhost or a trusted network.'],
    ])}`)}

    ${section('Where this could go', 'The same pattern (docs in, credential held by the app, a person approving changes) fits other setup and maintenance work. None of these is built yet.', tiles([
      ['users', 'Self-service onboarding', 'App teams register their own apps from CloakTail\'s guide, without a ticket to the identity team.'],
      ['refresh', 'Secret and certificate rotation', 'Renew an expiring SAML certificate or rotate an OIDC secret, and update both CloakTail and the app in one approved flow.'],
      ['info', 'Drift checks', 'Compare what an app runs with what CloakTail has registered, and explain any difference before it breaks sign-in.'],
      ['arrow', 'Promote between environments', 'Copy a working registration from development to staging and production, with each environment\'s own URLs.'],
      ['bad', 'Troubleshooting', 'Read a failed sign-in\'s test run and the app\'s settings, name the mismatched value, and propose the fix.'],
      ['globe', 'Other systems', 'Any API with a published spec: user provisioning (SCIM), other identity providers, API gateways.'],
    ]))}

    ${section('Requirements to use this mechanism', 'This works because both sides provide a few things. Any new use needs the same.', `
      ${SIDES}
      <h4 style="margin:0 0 8px">Server side needs</h4>
      ${tiles([
        ['globe', 'A REST API for the task', 'Everything a person does in its console, available as a REST API: create, read, change and delete. If a step is only possible by clicking, the assistant can\'t do it.'],
        ['key', 'Machine credentials', 'Credentials for a program rather than a person, limited to what the task needs, with an expiry, and revocable at any time.'],
        ['code', 'Documentation a program can read', 'A published API description and a short guide saying which calls to make, in what order, and how to choose values.'],
        ['info', 'A way to look before changing', 'Search or list existing items, so the assistant updates what is there instead of creating duplicates.'],
        ['warn', 'Clear error messages', 'Errors that say what was wrong and how to fix it, so the assistant can correct itself instead of guessing.'],
        ['check', 'A safe way to test', 'A sandbox, or check-only calls that change nothing, so the result can be verified before real users depend on it.'],
      ])}
      <h4 style="margin:20px 0 8px">Client side needs</h4>
      ${tiles([
        ['lock', 'Its own backend', 'A backend, not just a browser page, to keep the credential and secrets and to make the calls. The AI only ever talks to this backend.'],
        ['refresh', 'Somewhere to save progress', 'A database for the workflow\'s steps (here, Postgres through DBOS), so a run can wait for a person and survive restarts.'],
        ['sparkle', 'An AI model that can call functions', 'A model (Gemini, Claude, GPT and others) that answers with structured function calls for the backend to run, and an API key for it.'],
        ['sliders', 'Settings it can change safely', 'A way to save its own settings that checks every value, the same way its settings form does.'],
        ['users', 'A description of itself', 'Its own values to register (URLs, IDs, certificates), so the assistant registers exactly what the app will check.'],
        ['check', 'An approval step', 'A screen where a person sees each change before it happens, and can say no.'],
      ])}
      <h4 style="margin:20px 0 8px">And the people need</h4>
      ${tiles([
        ['users', 'An approver who knows the values', 'Approving is the main safeguard, so the approver must understand what each change does.'],
        ['shield', 'Agreement to use an AI service', 'The AI provider sees the documentation, this app\'s public values and the conversation. That must be acceptable for the data involved.'],
      ])}`)}

    ${section('Before using it beyond testing', '', `<ul class="arch-steps" style="list-style:disc">
      <li>Admin sign-in, so only authorised people can approve changes.</li>
      <li>Who approved each change. The workflow already keeps every call and approval, but not who made it.</li>
      <li>Credentials per person or team, with the fewest scopes the task needs.</li>
      <li>Secrets encrypted at rest instead of a file on disk.</li>
      <li>Repeatable test runs of the assistant against a sandbox CloakTail.</li>
    </ul>`)}`;
}

// ---------- Engineering ----------

const engineeringDiagram = () => {
  const a = 'en-arrow';
  return `<div class="arch-diagram"><svg viewBox="0 0 880 420" role="img" aria-labelledby="en-title en-desc">
    <title id="en-title">Components and data flow</title>
    <desc id="en-desc">The browser posts to the Express routes, which start a workflow run or send it a message. The workflow run sends redacted context to the Gemini API and runs the tool calls it returns, saving every model turn and tool call as a step in Postgres through DBOS. API calls pass through redaction to CloakTail with a Bearer token from the credential module, which gets tokens from CloakTail's token endpoint with HTTP Basic. Revealed secrets go into app settings on disk.</desc>
    ${arrowDefs(a)}
    ${box(20, 60, 150, 60, 'dg-box', 'Admin\'s browser', ['forms, chat, approve'])}
    ${box(20, 300, 150, 90, 'dg-box', 'Postgres (DBOS)', ['each step and result', 'run state, messages', 'secrets sealed'])}
    <rect x="220" y="20" width="400" height="390" rx="12" class="dg-group"/>
    <text x="236" y="42" class="dg-title">Test SP server (Express)</text>
    ${box(240, 60, 170, 60, 'dg-box', 'Routes and views', ['server.js, views/'], { mono: true })}
    ${box(430, 60, 170, 100, 'dg-accent', 'Workflow run', ['workflow/registration.js', 'phases, approval gate', 'tools in assistant.js'])}
    ${box(430, 180, 170, 70, 'dg-box', 'Redact / reveal', ['[secret:N] ↔ value', 'conn.secrets (in the run)'])}
    ${box(430, 290, 170, 100, 'dg-box', 'Credential and token', ['apiCredentials.js', 'token in memory', 'renewed 30 s early'])}
    ${box(240, 180, 170, 70, 'dg-box', 'App settings', ['settings.js'])}
    ${box(240, 300, 170, 90, 'dg-box', 'On disk (data/)', ['settings.json', 'api-credentials.json'], { mono: true })}
    ${box(680, 50, 180, 110, 'dg-ext', 'Gemini API', ['generateContent', 'function calling', 'thought summaries'])}
    <rect x="668" y="36" width="204" height="138" rx="12" class="dg-boundary"/>
    <text x="770" y="192" text-anchor="middle" class="dg-warn">no credential, token or secret</text>
    <rect x="680" y="220" width="180" height="180" rx="8" class="dg-ct"/>
    <text x="770" y="244" text-anchor="middle" class="dg-title">CloakTail</text>
    <text x="770" y="276" text-anchor="middle" class="dg-mono">/api/v1/agent.md</text>
    <text x="770" y="291" text-anchor="middle" class="dg-mono">/api/v1/openapi.json</text>
    <text x="770" y="322" text-anchor="middle" class="dg-mono">/api/v1/apps/…</text>
    <text x="770" y="364" text-anchor="middle" class="dg-mono">/api/v1/oauth/token</text>
    ${line(a, 'M170,90 L240,90', { both: true })}
    ${line(a, 'M410,90 L430,90', { both: true })}
    ${line(a, 'M600,92 L680,92')}
    ${label(640, 84, 'context')}
    ${line(a, 'M680,128 L600,128')}
    ${label(640, 144, 'tool calls')}
    ${line(a, 'M515,160 L515,180', { both: true })}
    ${line(a, 'M600,215 L680,300')}
    ${label(636, 266, 'fetch, API', 'end')}
    ${label(636, 279, '+ Bearer', 'end')}
    ${line(a, 'M515,290 L515,250')}
    ${label(522, 274, 'token', 'start')}
    ${line(a, 'M600,360 L680,360')}
    ${label(640, 352, 'Basic')}
    ${line(a, 'M430,215 L410,215')}
    ${line(a, 'M325,250 L325,300')}
    ${line(a, 'M430,340 L410,340')}
    ${line(a, 'M220,345 L170,345', { both: true })}
    ${label(195, 337, 'steps')}
  </svg></div>`;
};

const TOOLS = [
  ['<code>fetch_reference</code>', 'GET a document on the CloakTail origin: the reference, or one it links to.', 'No', 'JSON bodies are redacted; documents with <code>$ref</code> go as text (Gemini rejects <code>$ref</code> objects); truncated at 200,000 characters.'],
  ['<code>get_access_token</code>', 'No arguments. Calls <code>getAccessToken({ force: true })</code>.', 'No', 'Returns only <code>{ ok, expires_in, scope }</code>.'],
  ['<code>http_request</code>', 'Calls the CloakTail API with the current token attached.', '<code>POST</code>, <code>PUT</code>, <code>PATCH</code>, <code>DELETE</code>', 'Origin-pinned; <code>[secret:N]</code> in <code>json_body</code> revealed just before sending; writes carry an <code>idempotency-key</code> unique to the step; response redacted.'],
  ['<code>get_this_app</code>', 'This app\'s values for the protocol and its current settings.', 'No', 'Current secrets are reported as <code>set</code>, never their value.'],
  ['<code>update_this_app_settings</code>', 'Saves values into the protocol\'s or migration settings.', 'Yes', 'Only keys in <code>SETTING_DOCS</code>; handles revealed; saved through the normal settings validation.'],
  ['<code>check_user_migration</code>', 'Builds a migration request for the first legacy user and sends it to <code>/migrate/check</code>.', 'No', 'Creates no users.'],
  ['<code>finish_phase</code>', 'Says the phase is <code>done</code>, <code>skipped</code> or <code>blocked</code>, with a summary.', 'No', 'Handled by the workflow, not <code>runTool</code>. <code>done</code> runs the phase\'s check; only optional phases can be skipped; <code>blocked</code> waits for the admin.'],
];

function engineeringView() {
  return `
    ${section('Components', 'One Express process and a Postgres database. The model plans; the server holds every secret and enforces every rule.', engineeringDiagram())}

    ${section('The workflow', 'One durable DBOS workflow per conversation (<code>registrationWorkflow</code>), running the <code>REGISTRATION</code> definition phase by phase.', `
      <ol class="arch-steps">
        <li>The first <code>POST /assistant/:protocol/message</code> calls <code>registration.start()</code>, which validates the definition and starts a run with its own copy of it. Later messages and <code>POST …/decide</code> reach the run as DBOS messages (<code>engine.send</code>); the route waits up to 90 s for the run to go idle, then redirects.</li>
        <li>Each phase starts with a brief (<code>phaseBrief()</code>): its goal, its tools and its check. The model gets only that phase's tools plus <code>finish_phase</code>; a call to any other tool is refused.</li>
        <li>Each model turn (<code>callModel</code>, retried up to 3 times) and each tool call (<code>runTool</code>) is a DBOS step. Its result is saved in Postgres, so after a restart DBOS replays it instead of calling Gemini or CloakTail again.</li>
        <li>For each function call: if the phase's approval is <code>changes</code> and <code>isChange(call)</code>, it is held; otherwise it runs at once.</li>
        <li>Held calls: the run publishes <code>waiting_approval</code> with <code>describeCall()</code> (method, URL and body with handles, not real values) and sleeps in <code>DBOS.recv</code>. Approve runs every held call; decline sends the admin's note back as <code>admin_instead</code>.</li>
        <li>A text answer with no call is a question or report: the run waits for the admin's reply (<code>waiting_input</code>).</li>
        <li><code>finish_phase</code> with <code>done</code> runs the phase's check (<code>host.check</code>, also a step). A failed check goes back to the model as an error and the phase continues; a passed one starts the next phase.</li>
        <li>After the last phase the model writes a final summary and the run ends as <code>done</code>.</li>
      </ol>
      <p class="hint">After every change the run publishes its state as the DBOS event <code>state</code>; the assistant card and the <a href="/admin/workflows">Workflows</a> pages read it. <strong>New conversation</strong> cancels the run.</p>`)}

    ${section('Phases', 'From <code>REGISTRATION</code> in <code>workflow/definitions.js</code>. Definitions are plain JSON, checked by <code>validate()</code> against <code>CATALOG</code>.', table(['Phase', 'Does', 'Check when done'], [
      ['<code>discover</code>', 'Reads the reference and this app\'s values, and looks for an existing registration. Changes nothing.', '—'],
      ['<code>register</code>', 'Creates the application in CloakTail, or updates the existing one.', '—'],
      ['<code>configure</code>', 'Saves what CloakTail returned into this app\'s sign-in settings.', '<code>signin_configured</code>'],
      ['<code>migration_setup</code> (optional)', 'Turns on user migration for the application in CloakTail.', '—'],
      ['<code>migration_settings</code> (optional)', 'Saves the migration URL, secret and signing into this app.', '<code>migration_configured</code>'],
      ['<code>migration_check</code> (optional)', 'Sends a test migration request to CloakTail.', '<code>migration_check_passed</code>'],
    ]))}

    ${section('Tools and guard rails', 'The only actions the model can take, and what limits each one. Declarations are in <code>declarations(protocol, names)</code>, limited to the phase\'s tools; implementations in <code>tools</code>.', `
      ${table(['Tool', 'Does', 'Approval', 'Guard'], TOOLS)}
      <div style="margin-top:16px">${tiles([
        ['globe', 'Origin pinning', '<code>connect()</code> refuses a reference that isn\'t on the saved CloakTail origin. <code>onReferenceOrigin()</code> resolves every URL the model gives and refuses any other origin. Redirects are not followed.'],
        ['key', 'Token by function', 'The token endpoint and client authentication are fixed in <code>apiCredentials.js</code>, so the model can\'t choose where the credential goes. The tool takes no arguments.'],
        ['lock', 'Secrets never in the prompt', 'The API credential, the access token and saved secrets never reach the model. Secrets in API responses become <code>[secret:N]</code> through <code>redact()</code> (matched by key name); <code>reveal()</code> swaps them back only in request bodies and saved settings.'],
        ['check', 'Approval gate', '<code>isChange()</code>: every write method and every settings change, in every phase with approval <code>changes</code> (all of them today). Declining sends the admin\'s note to the model.'],
        ['sliders', 'Allow-listed settings', '<code>update_this_app_settings</code> takes only keys in <code>SETTING_DOCS</code>, and saving runs the same validation as the settings forms.'],
        ['info', 'Phase scoping and checks', 'Each phase gets only its own tools. Code, not the model, decides when a phase is done: a phase with a check can\'t finish until it passes.'],
        ['lock', 'Secrets sealed at rest', 'Step results are stored in Postgres. The values behind <code>[secret:N]</code> handles are stored sealed with a key derived from <code>SESSION_SECRET</code>, never in the clear.'],
        ['warn', 'Bounded work', '15 model calls per phase before the run asks the admin whether to go on, 20 s per HTTP call, 200,000 characters per document. An unanswered question or approval ends the run after 7 days.'],
      ])}</div>`)}

    ${section('Saving into this app', 'How CloakTail\'s answer becomes this app\'s settings.', `<ol class="arch-steps">
      <li><strong>The model maps the fields.</strong> No mapping is hard-coded: each key in <code>SETTING_DOCS</code> says which CloakTail value goes there, and secrets are passed as <code>[secret:N]</code> handles.</li>
      <li><strong>On approval</strong>, the server reveals the handles and saves through <code>saveSettings()</code>, with the same validation as the settings forms. A rejected value goes back to the model to correct.</li>
      <li><strong>The settings apply at once</strong>: sign-in is rebuilt, the IdP metadata or discovery document is read, and any warnings go back to the model.</li>
      <li><strong>Code checks the result</strong> when the model finishes the phase: <code>signin_configured</code> and <code>migration_configured</code> confirm the settings are complete.</li>
      <li><strong>The model verifies</strong> with <code>check_user_migration</code>, a real request to CloakTail's <code>/migrate/check</code>, and <code>migration_check_passed</code> confirms CloakTail accepted it.</li>
    </ol>`)}

    ${section('Known limits', 'Worth knowing before reusing the pattern.', `<ul class="arch-steps" style="list-style:disc">
      <li><strong>Redaction is by key name.</strong> A secret under an unexpected field name, or in free text, would reach the model. CloakTail's names (<code>client_secret</code>, <code>migration_secret</code>) are covered.</li>
      <li><strong>Prompt injection from the reference.</strong> The model follows the documents it reads. Origin pinning and the approval gate bound the damage, but an approver must read what they approve.</li>
      <li><strong>No admin authentication.</strong> Anyone who can reach <code>/admin</code> can approve. Cross-site posts are refused (<code>sameOrigin</code>).</li>
      <li><strong>Credential in plain text on disk.</strong> Mode 600 has no effect on Windows. The token is shared by all admin sessions.</li>
      <li><strong>No record of who approved.</strong> Every run's transcript, calls and approvals are kept in Postgres (see <a href="/admin/workflows">Workflows</a>), but without admin sign-in there is no name to attach.</li>
      <li><strong>Needs Postgres.</strong> Without <code>DBOS_SYSTEM_DATABASE_URL</code> the assistant is unavailable. Changing <code>SESSION_SECRET</code> changes the key that seals secrets in saved steps.</li>
    </ul>`)}`;
}

export function architecturePage(data) {
  return layout({
    ...data,
    title: 'How the AI assistant works',
    body: `${style}
      ${pageHead(`How the AI assistant works ${data.enabled ? badge('On', 'ok') : badge('Off')}`,
        'The registration assistant on the <a href="/admin/saml#assistant">SAML</a> and <a href="/admin/oidc#assistant">OpenID Connect</a> pages: what it does, how it is built, and where the pattern could go next.',
        `<a class="btn" href="/admin/api">${icon('key')}API credentials</a>`)}
      ${card({
        bodyClass: '',
        body: tabs('Views', [
          { id: 'overview', label: `${icon('info')}Overview`, content: overviewView(data) },
          { id: 'engineering', label: `${icon('code')}Engineering`, content: engineeringView() },
        ]),
      })}`,
  });
}

