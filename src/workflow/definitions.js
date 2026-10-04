// Workflow definitions, as data: what each run does, in which order, with which tools, what needs
// the admin's approval and what code checks before a phase counts as done. The engine
// (registration.js) interprets a definition; the pages draw it.
//
// Definitions are plain JSON on purpose. The next step is letting the admin change a workflow by
// describing the change: an AI edits the JSON, validate() checks it against the catalog below, and
// the admin approves the new version. A run keeps the version it started with.

// What a phase may use. A definition can only pick from these: the code behind each one, and its
// safety rules (allowed origin, secret handles, approval of changes), stay in the app.
export const CATALOG = {
  tools: {
    fetch_reference: { label: 'Fetch', description: 'Read the CloakTail reference and the documents it links to.', changes: false },
    get_access_token: { label: 'GetToken', description: 'Get a CloakTail API token with the saved credential.', changes: false },
    http_request: { label: 'Request', description: 'Call the CloakTail API. GET runs at once; POST, PUT, PATCH and DELETE are changes.', changes: 'writes' },
    get_this_app: { label: 'ReadApp', description: 'Read this app\'s values and current settings.', changes: false },
    update_this_app_settings: { label: 'SaveSettings', description: 'Save values into this app\'s settings.', changes: true },
    check_user_migration: { label: 'CheckMigration', description: 'Send a test migration request to CloakTail\'s /migrate/check. Creates no users.', changes: false },
  },
  // Code checks run when the agent says a phase is done. A failed check sends the agent back to work.
  checks: {
    signin_configured: 'This app\'s sign-in settings for the protocol are complete.',
    migration_configured: 'User migration settings are complete here (URL, secret, signing, protocol).',
    migration_check_passed: 'The last migration check was accepted by CloakTail.',
  },
  // The same checks, as the pages name them.
  checkLabels: {
    signin_configured: 'Sign-in settings complete',
    migration_configured: 'Migration settings complete',
    migration_check_passed: 'CloakTail accepts a test request',
  },
  approvals: {
    changes: 'The admin approves every change (API writes and settings saves).',
    none: 'Changes run without asking.',
  },
};

export const REGISTRATION = {
  id: 'registration',
  version: 1,
  title: 'Register in CloakTail and set up user migration',
  description: 'An AI agent registers this app in CloakTail through the developer API, saves the values CloakTail returns, then sets up and checks user migration. Each phase is a durable step: a restart resumes the run where it was.',
  phases: [
    {
      id: 'discover',
      summary: 'Reads the CloakTail guide and this app\'s values, and looks for an existing registration. Changes nothing.',
      title: 'Read the reference',
      goal: 'Read the CloakTail reference (fetch_reference) and this app\'s values (get_this_app). Get an access token. Find out whether an application with this app\'s entity ID or client ID already exists in CloakTail. Change nothing yet.',
      tools: ['fetch_reference', 'get_this_app', 'get_access_token', 'http_request'],
      approval: 'changes',
    },
    {
      id: 'register',
      summary: 'Creates the application in CloakTail, or updates the existing one to match this app.',
      title: 'Register the app in CloakTail',
      goal: 'Create the application in CloakTail with exactly this app\'s values, or update the existing one so it matches. Ask the admin for anything the reference requires that get_this_app doesn\'t provide, such as an application name.',
      tools: ['http_request', 'fetch_reference', 'get_this_app', 'get_access_token'],
      approval: 'changes',
    },
    {
      id: 'configure',
      summary: 'Copies what CloakTail returned (issuer, IDs, secret) into this app\'s sign-in settings.',
      title: 'Save the sign-in settings here',
      goal: 'Save the values CloakTail returned for this application into this app\'s sign-in settings with update_this_app_settings, so users can sign in.',
      tools: ['update_this_app_settings', 'get_this_app', 'http_request', 'fetch_reference', 'get_access_token'],
      approval: 'changes',
      check: 'signin_configured',
    },
    {
      id: 'migration_setup',
      summary: 'Turns on user migration for the application in CloakTail.',
      title: 'Set up user migration in CloakTail',
      goal: 'Follow the reference\'s user migration instructions on the application you registered. Read the existing migration setup first and keep what matches. Register the return URL and request signing from get_this_app\'s user_migration (jwks unless this app already uses the secret method).',
      tools: ['http_request', 'fetch_reference', 'get_this_app', 'get_access_token'],
      approval: 'changes',
      optional: true,
    },
    {
      id: 'migration_settings',
      summary: 'Saves the migration URL and secret into this app.',
      title: 'Save the migration settings here',
      goal: 'Save into this app, in one update_this_app_settings call: migrationUrl (CloakTail\'s migration URL from the setup response), migrationSecret (the [secret:N] handle of the migration secret), migrationRequestSigning, migrationReturnUrl if it differs from the default, and migrationProtocol set to this protocol.',
      tools: ['update_this_app_settings', 'get_this_app', 'http_request', 'get_access_token'],
      approval: 'changes',
      check: 'migration_configured',
      optional: true,
    },
    {
      id: 'migration_check',
      summary: 'Sends a test migration request to CloakTail. Creates no users.',
      title: 'Check user migration',
      goal: 'Call check_user_migration and report the result. If CloakTail refuses the request, say why and what to fix.',
      tools: ['check_user_migration', 'get_this_app'],
      approval: 'changes',
      check: 'migration_check_passed',
      optional: true,
    },
  ],
};

// Not run by an agent: the stages one legacy user goes through (see userMigration.js). Drawn the
// same way, so the pages show both workflows alike.
export const USER_MIGRATION = {
  id: 'user-migration',
  version: 1,
  title: 'Migrate a legacy user',
  description: 'One run per legacy sign-in that starts a migration. It waits for the user to come back from CloakTail; if they never do, it asks CloakTail whether the migration happened (the spec\'s "Recovering a lost result") and records the outcome.',
  phases: [
    { id: 'sent', title: 'Signed request sent', goal: 'The user proved their old password; the app signed a migration request and sent the browser to CloakTail.' },
    { id: 'at_cloaktail', title: 'User at CloakTail', goal: 'The user chooses a new password and adds an authenticator app. Waits up to 40 minutes for them to come back.' },
    { id: 'result', title: 'Result verified', goal: 'The app verified CloakTail\'s signed result (signature, state, user) and recorded it: migrated, conflict, cancelled, expired or error.' },
    { id: 'recovery', title: 'Recover a lost result', goal: 'Only when the user never came back: ask CloakTail\'s /migrate/status whether they were migrated, and mark them if so.', optional: true },
  ],
};

export const DEFINITIONS = { [REGISTRATION.id]: REGISTRATION, [USER_MIGRATION.id]: USER_MIGRATION };

// Problems with an agent workflow definition, as sentences. Empty when it is valid.
export function validate(def) {
  const problems = [];
  if (!def || typeof def !== 'object') return ['The definition is not an object.'];
  if (!Array.isArray(def.phases) || !def.phases.length) problems.push('A workflow needs at least one phase.');
  const ids = new Set();
  for (const [i, p] of (def.phases ?? []).entries()) {
    const at = `Phase ${i + 1}${p?.id ? ` (${p.id})` : ''}`;
    if (!p?.id || !/^[a-z][a-z0-9_]*$/.test(p.id)) problems.push(`${at}: id must be lowercase letters, digits and _.`);
    else if (ids.has(p.id)) problems.push(`${at}: the id is used twice.`);
    ids.add(p?.id);
    if (!p?.title) problems.push(`${at}: give it a title.`);
    if (!p?.goal) problems.push(`${at}: give it a goal for the agent.`);
    if (!Array.isArray(p?.tools) || !p.tools.length) problems.push(`${at}: give it at least one tool.`);
    for (const t of p?.tools ?? []) if (!Object.hasOwn(CATALOG.tools, t)) problems.push(`${at}: unknown tool ${t}.`);
    if (!Object.hasOwn(CATALOG.approvals, p?.approval ?? '')) problems.push(`${at}: approval must be one of ${Object.keys(CATALOG.approvals).join(', ')}.`);
    if (p?.check && !Object.hasOwn(CATALOG.checks, p.check)) problems.push(`${at}: unknown check ${p.check}.`);
  }
  return problems;
}
