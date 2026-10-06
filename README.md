# Test SP for CloakTail

A small app that plays "a developer's app" outside CloakTail, as a SAML service provider and an OpenID Connect relying party. Register it in [CloakTail](../cloaktail) and sign in to it through the sandbox realm, to test the portal end to end: client creation, the settings the portal applies, IdP- and SP-initiated login, attributes and claims, signing, encryption, PKCE, token refresh and logout.

**It knows only what CloakTail tells a developer.** Every setting comes from the application page (`/apps/<id>`, e.g. http://localhost:3000/apps/1). The app doesn't build Keycloak URLs from a server URL and realm name, and doesn't call the Keycloak Admin API. If a test only passes with information the page doesn't show, the page is missing something.

## Run

```bash
npm install
cp .env.example .env    # set SESSION_SECRET
docker compose up -d postgres   # optional: Postgres for the workflows (see "Workflows")
npm run dev             # http://localhost:4000
```

The app has two sides:

**Customer site: "Acme Bank"**, a pretend bank in a banking theme. This is where you sign in, as a customer would.

| Page | What it's for |
|---|---|
| **Sign in** (`/`) | What the app is, how sign-in works, and the sign-in card: choose OpenID Connect or SAML 2.0 (`/?via=oidc` / `/?via=saml`), *Sign in securely*, *Open an account*, and tester options (force login form, IdP-initiated). Once signed in: the accounts page (demo data), sign-out options, the local profile, and a collapsible **Developer view** with the attributes / claims, tokens and XML |
| **Legacy sign-in** (`/legacy`) | The app before Keycloak: old passwords, migrating each user through CloakTail |
| **Documents** (`/documents`) | Signed-in customers upload files to S3, through the app or directly with presigned URLs, then download or delete them (see [Customer documents](#customer-documents-s3)) |

**Admin console** (`/admin`), with the setup sidebar. Customers never need it.

| Page | What it's for |
|---|---|
| **Overview** (`/admin`) | What the app is, setup status for each part, and what to test |
| **SAML 2.0** (`/admin/saml`) | Step 1: base URL. Step 2: values to register in CloakTail. Step 3: paste the portal's example. Step 4: settings |
| **OpenID Connect** (`/admin/oidc`) | The same four steps, plus a connection check of the discovery document |
| **API credentials** (`/admin/api`) | The CloakTail API credential the AI assistant uses, and a **Get access token** button to check it |
| **How it works** (`/admin/architecture`) | The AI assistant's design in two views: **Overview** (what it does, why it is safe, future uses) and **Engineering** (components, the agent loop, tools and guard rails, saving into this app, known limits) |
| **Migration setup** (`/admin/migrate`) | User migration setup, JWKS, check / simulate, legacy users and activity |
| **Workflows** (`/admin/workflows`) | The durable workflows: each one's phases, its runs, and one run's progress, transcript and saved steps |
| **Certificates** (`/admin/certs`) | SAML signing and encryption key pairs |
| **Local profiles** (`/admin/users`) | Profiles created by JIT provisioning |

The old admin addresses (`/saml`, `/oidc`, `/certs`, `/users`, `/migrate`) redirect to `/admin/...`. Protocol endpoints registered in CloakTail (`/saml/acs`, `/saml/slo`, `/saml/metadata`, `/oidc/callback`, `/migrate/return`, `/migrate/jwks.json`, ...) are unchanged.

## Run with Docker

```bash
docker build -t samlclient-testsp .
docker run --rm -p 4000:4000 \
  -e SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  -e BASE_URL=http://localhost:4000 \
  -v testsp-data:/app/data -v testsp-certs:/app/certs \
  samlclient-testsp
```

Or pass your `.env` with `--env-file .env`. Settings, profiles, legacy users and key pairs live in the two volumes, so they survive restarts.

- The base URL must be the address the **browser** uses; it sets the entity ID, ACS and redirect URIs. `BASE_URL` is its default; change it in step 1 (**Base URL**) of the SAML or OpenID Connect page (switching between http and https needs a restart, for the session cookie).
- From inside the container, `localhost` is the container itself. If Keycloak or CloakTail run on the host, use `http://host.docker.internal:<port>` for URLs the app fetches server-side (IdP metadata, OIDC issuer, CloakTail's migration URL); on Linux add `--add-host=host.docker.internal:host-gateway`. The OIDC issuer must still match what Keycloak puts in its tokens, so set Keycloak's hostname accordingly.
- The image sets `NODE_ENV=production`, so simulated migration results are refused unless you set `MIGRATION_ACCEPT_SIMULATED=true`.

Settings and key pairs change without editing `.env` or restarting. Invalid input is flagged next to its field and kept in the form.

## SAML settings

**SAML 2.0 → Settings** takes the values on the application page:

| Application page | Setting | `.env` default |
|---|---|---|
| Keycloak (IdP) details → IdP metadata URL | IdP metadata URL | `IDP_METADATA_URL` |
| → IdP entity ID (issuer) | IdP entity ID | `IDP_ENTITY_ID` |
| → Single sign-on URL | Single sign-on URL | `IDP_SSO_URL` |
| → Single logout URL | Single logout URL (empty: local sign-out only) | `IDP_SLO_URL` |
| → IdP-initiated login | IdP-initiated login (optional) | `IDP_INITIATED_URL` |
| → Signing certificate | Signing certificate (optional; empty reads the metadata URL) | `IDP_CERT` |
| (step 1 of the page; shared with OpenID Connect) | Base URL | `BASE_URL` |
| Your app (SP) settings → Entity ID | Entity ID | `SP_ENTITY_ID` |
| → Name ID format | Name ID format (the URN under it) | `NAME_ID_FORMAT` |
| → Attributes | Expected attributes (missing ones are flagged after sign-in) | `EXPECTED_ATTRIBUTES` |
| → Signed | Require signed response / assertion | `WANT_RESPONSE_SIGNED`, `WANT_ASSERTIONS_SIGNED` |
| → Signed requests | Sign requests | `SIGN_REQUESTS` |
| → Encryption | Decrypt assertions | `DECRYPT_ASSERTIONS` |

**Paste the example** fills most of them at once from the page's *Example: Node.js (@node-saml/passport-saml)* block: SSO and logout URLs, both entity IDs, Name ID format and the signing / encryption switches. Copy the metadata URL, IdP-initiated link and attributes by hand.

`.env` supplies the defaults; saved values go to `data/settings.json` (`SETTINGS_FILE`) and apply immediately. SAML and OIDC are saved separately, so one can be set up without the other. On save the app reads the IdP metadata (or OIDC discovery document) and warns if it can't. **Reset to .env values** deletes the file (both protocols). Settings saved by older versions (Keycloak URL + realm) are converted on start.

The settings and key-pair forms have no login: anyone who can reach the app can change them. Run it on localhost or a trusted network only.

## OpenID Connect

The app uses [openid-client](https://github.com/panva/openid-client) v6, as the portal's Node.js example does, and is given only what an OpenID Connect application page shows:

| Application page | Setting | `.env` default |
|---|---|---|
| Keycloak (OpenID provider) details → Issuer | Issuer (the discovery document URL also works) | `OIDC_ISSUER` |
| Client credentials → Client ID | Client ID | `OIDC_CLIENT_ID` |
| Client credentials → Client secret | Client secret (empty: public client) | `OIDC_CLIENT_SECRET` |
| Your app (client) settings → PKCE | Use PKCE (S256) | `OIDC_USE_PKCE=true` |
| Example code (scope) | Scopes | `OIDC_SCOPES=openid profile email` |
| — | Expected claims (missing ones are flagged after sign-in) | `OIDC_EXPECTED_CLAIMS` |

Every endpoint comes from the discovery document. **Paste the example** reads the page's *Example code → Node.js* block: issuer, client ID, client type, scopes and PKCE; copy the secret by hand.

Register the client in CloakTail (**Applications → New application → OpenID Connect**) with:

| Portal field | Value |
|---|---|
| Redirect URIs | `http://localhost:4000/oidc/callback` |
| Post-logout redirect URIs | `http://localhost:4000/oidc/logged-out` |
| Web origins | `http://localhost:4000` |
| Home URL | `http://localhost:4000/` |

Sign-in runs the authorization code flow with `state`, `nonce` and (unless turned off) PKCE; the ID token is verified against the provider's JWKS and the userinfo endpoint is called. **Sign out** ends the local session, then redirects to the end session endpoint with `id_token_hint`. To test logout started from Keycloak, set the client's *Front-channel logout URL* to `http://localhost:4000/oidc/frontchannel-logout` in the Keycloak admin console (the portal doesn't set it).

## SP certificates

**Certificates** shows the signing and encryption key pairs (subject, validity, SHA-256 fingerprint) and links to the certificate as PEM, as base64 (what Keycloak's certificate fields take) and as a download. **Generate / Regenerate key pair** creates a self-signed RSA pair (2048–4096 bit, 1–10 years) in `certs/`. OpenID Connect doesn't use them. Turning on *Sign requests* or *Decrypt assertions* generates a missing pair automatically.

After regenerating a pair that is in use, paste the new certificate into the portal; until then Keycloak rejects signed requests or encrypts to the old key.

The CLI does the same: `npm run gen:certs` (`-- --force --key-size=3072 --years=5` to replace).

## Register it in CloakTail

In CloakTail, **Applications → New application**, either:

- **Import metadata:** paste the XML from `http://localhost:4000/saml/metadata`, or
- **Fill the form:**

  | Portal field | Value |
  |---|---|
  | Entity ID | `http://localhost:4000/saml/metadata` (or `SP_ENTITY_ID`) |
  | ACS URL | `http://localhost:4000/saml/acs` |
  | Logout URL | `http://localhost:4000/saml/slo` |
  | Home URL | `http://localhost:4000/` |

Then copy the application page's values into **SAML 2.0 → Settings** (above), create a test user under **Test users** in CloakTail, and sign in to this app as that user.

### Or let the AI assistant do it

The SAML 2.0 and OpenID Connect pages have a **Shortcut: register with the AI assistant** card, just below step 1: a Google Gemini agent that registers this app through CloakTail's developer API, fills that page's settings from the result, then sets up and checks user migration.

1. Set `GEMINI_API_KEY` and `GEMINI_MODEL` (e.g. `gemini-flash-latest`) in `.env` and restart.
2. On **API credentials** (`/admin/api`), enter the **CloakTail URL** and an **API client ID and secret** from CloakTail's API credentials page, then **Save and get access token** to check them. This app gets tokens itself (`POST <CloakTail URL>/api/v1/oauth/token`, client credentials, HTTP Basic).
3. On the card, enter the **CloakTail reference URL** (the API guide or OpenAPI spec the agent should work from; it defaults to `<CloakTail URL>/api/v1/agent.md`).
4. Click **Connect**, then **Register this app** (shown while the conversation is empty), or type a request and **Send** (e.g. "check the existing registration").

The agent works through these tools; the transcript shows each call:

| Tool | Transcript | What it does | Approval |
|---|---|---|---|
| `fetch_reference` | `Fetch` | Reads the reference, or a document it links to (e.g. the OpenAPI spec) | No |
| `get_access_token` | `GetToken` | Asks this app for a token with the saved credential. No arguments; returns only the expiry and scopes | No |
| `http_request` | `Request` | Calls the CloakTail API with the token attached | `GET` no; `POST`/`PUT`/`PATCH`/`DELETE` yes |
| `get_this_app` | `ReadApp` | This app's values to register (URLs, entity or client ID, certificates) and current settings | No |
| `update_this_app_settings` | `SaveSettings` | Saves what CloakTail returned into this app's SAML, OIDC or migration settings | Yes |
| `check_user_migration` | `CheckMigration` | Sends a migration request for a legacy test user to CloakTail's `/migrate/check` | No |

The agent has no CloakTail knowledge built in: it reads the reference and takes the paths and fields from it, so it follows whatever the reference documents. The code only fixes the guard rails:

- The reference must be on the saved CloakTail server, and the agent can call only that server, so the token can't be sent elsewhere.
- The agent gets a token by calling `get_access_token`, which takes no arguments: the API credential and the token never reach Gemini. The credential is saved in `data/api-credentials.json` (git-ignored); the token is kept in memory and renewed when it expires. Secrets in API responses reach the model as `[secret:N]` handles; the server puts the real value back when the agent saves it here.
- Requests that change something (POST, PUT, PATCH, DELETE) and changes to this app's settings wait for **Approve**.

**How it works** (`/admin/architecture`) explains the design, with an Overview tab for stakeholders and an Engineering tab for developers.

The assistant runs as a durable **workflow** (see [Workflows](#workflows)), so it needs `DBOS_SYSTEM_DATABASE_URL` too. It works through six phases in order: read the reference, register the app in CloakTail, save the sign-in settings here, set up user migration in CloakTail, save the migration settings here, check user migration. In each phase the agent gets only that phase's tools, and says when it is done (`finish_phase`); code then checks the phase's result (for example, that the sign-in settings are complete) before the next phase starts. The strip above the transcript shows where it is.

**New conversation** stops the current run and starts over. **Disconnect** forgets the reference URL in this browser session; a run already started keeps going, and its card comes back after a restart. The saved API credential is kept until you delete it on the API credentials page.

## Match the portal settings (SAML)

The SP settings (home page, or `.env` defaults) must agree with the application's settings in CloakTail.

| Portal setting | Home page | `.env` default |
|---|---|---|
| Sign response | Require signed response | `WANT_RESPONSE_SIGNED=true` |
| Sign assertion | Require signed assertion | `WANT_ASSERTIONS_SIGNED=true` |
| Require signed requests (paste the signing cert, at `/certs/signing`) | Sign requests | `SIGN_REQUESTS=true` |
| Encrypt assertions (paste the encryption cert, at `/certs/encryption`) | Decrypt assertions | `DECRYPT_ASSERTIONS=true` |
| Name ID format | Name ID format (the URN; Username = `...:1.1:nameid-format:unspecified`) | `NAME_ID_FORMAT` (empty = accept any) |

Requiring a signature the portal doesn't turn on is a good negative test: sign-in should fail with a signature error, shown on the home page.

## What to test

| Scenario | How |
|---|---|
| SP-initiated login | **Sign in with SAML** / **Sign in with OpenID Connect** |
| Force login form | **Force login form**: sends `ForceAuthn` (SAML) or `prompt=login` (OIDC) |
| Self-registration | **Sign up**: forces Keycloak's form; choose *Register* there (needs *User registration* on in the realm). The new user signs straight in |
| JIT provisioning | The first sign-in creates a local profile (`data/users.json`, `USERS_FILE`); later ones update it. Listed under **Local profiles**; **Clear local profiles** resets them. Not done for a transient Name ID. OIDC profiles are keyed by issuer and `sub` |
| IdP-initiated login | **Sign in from Keycloak**, once the IdP-initiated link from the application page is in the settings |
| Attributes and Name ID | Shown after sign-in, with the assertion and full response XML; expected attributes that didn't arrive are flagged |
| SP-initiated logout | **Sign out**: SAML sends a LogoutRequest; OIDC redirects to the end session endpoint |
| Claims and tokens (OIDC) | ID token claims, userinfo, and the decoded access, ID and refresh tokens are shown after sign-in; expected claims that didn't arrive are flagged |
| Token refresh (OIDC) | **Refresh tokens** uses the refresh token |
| PKCE (OIDC) | Turn *Use PKCE* off while the portal requires it: Keycloak should refuse the sign-in |
| IdP-initiated logout | Sign in, then end the session from Keycloak (sign out of another app in the sandbox realm in the same browser). OIDC needs the front-channel logout URL above |
| Signed requests | Turn on *Sign requests* here and *Require signed requests* in the portal |
| Encrypted assertions | Turn on *Decrypt assertions* here and *Encrypt assertions* in the portal |
| Key rotation | Regenerate a key pair; sign-in fails until the new certificate is in the portal |

## User migration (legacy users → Keycloak)

The app also plays an application *before* Keycloak: its own user table with passwords (**Legacy sign-in**, `/legacy`), moving each user into Keycloak through CloakTail as they sign in, per the [user migration protocol](http://localhost:3000/migrate/spec.md).

1. The user enters their username. A migrated user goes straight to Keycloak (OIDC with `login_hint`, or SAML); the old password is never asked again.
2. Otherwise they enter the old password. If it is right, no session starts: the app keeps `state` and the user id in a pre-login session and auto-posts a signed request to `/migrate/start`.
3. CloakTail asks for a new password and creates the Keycloak account.
4. `/migrate/return` verifies the result (HS256 with the migration secret, `iss`, `aud`, `exp`, single-use `state`, `sub`), and marks the user migrated (`migratedAt`, `keycloakId`). After `created` the user is signed in at once (they proved the old password moments ago and just chose the new one), and every later sign-in uses Keycloak; this departs from the spec, which asks for a Keycloak sign-in here. After `already_migrated` the Keycloak sign-in starts. `conflict`, `cancelled`, `expired` and `error` sign the user in the old way.
5. If a user was sent to CloakTail before but never came back, or was in `conflict`, the next correct old password first asks CloakTail from the server (`POST /migrate/status`). If CloakTail migrated them (or the developer has since linked their existing Keycloak account), they are marked migrated and go to Keycloak; otherwise they continue as above.

Seeded users `alice`, `bob` and `carol` (password `Legacy#2024`) are in `data/legacy-users.json`.

**Register it** in CloakTail, *Applications → (this app) → User migration*, with the values on the **Migration** page (`/migrate`):

| Portal field | Value |
|---|---|
| Return URL | `http://localhost:4000/migrate/return` |
| Request signing | JWKS URL: `http://localhost:4000/migrate/jwks.json` (RS256; `kid` is the key's RFC 7638 thumbprint) |

Then enter CloakTail's **migration URL** (its request audience and result issuer, e.g. `http://localhost:3000/migrate`) and the **migration secret** under **Settings → From CloakTail** on the Migration page; no restart. They are not read from `.env` (the secret's `.env` default, `CLOAKTAIL_MIGRATION_SECRET`, still works). The **registration assistant** does all of this after registering the app: it sets up migration on the same CloakTail application with this app's return URL and JWKS URL, saves the migration URL and secret here, and checks a request with `/migrate/check`. The client ID (`iss`) is the SAML entity ID or OIDC client ID, depending on the protocol chosen on the Migration page. **Check request** and **Simulate result** there call `/migrate/check` and `/migrate/simulate`; a simulated result is opened at the return URL to test each status. **Rotate key** replaces the signing key; CloakTail fetches the JWKS again when it sees a new `kid`.

## Workflows

The registration assistant and user migration run as durable workflows on [DBOS](https://docs.dbos.dev), a library that saves every step in Postgres. Nothing else to run: no workflow server, no Postgres extension. Set a database URL and restart:

```bash
DBOS_SYSTEM_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/testsp_dbos
```

DBOS creates that database and its tables on first start (the user needs permission to create a database, or create it beforehand and make the user its owner). `docker compose up -d postgres` starts a local Postgres with these credentials. Without the URL the app works as before, except that the assistant is off and user migrations aren't tracked. If the database can't be reached (say, Postgres is still starting), the app starts anyway and keeps retrying every 15 seconds; the pages say workflows are paused until it connects.

What being durable changes:

- **Restarts.** Every model turn and every tool call is a saved step. After a restart (or a crash) DBOS resumes unfinished runs from the last saved step: saved model turns and CloakTail requests are replayed from the database, not sent again. A run waiting for an approval keeps waiting.
- **Long waits.** A run waiting for an approval or an answer sleeps in Postgres, for up to 7 days, at no cost. Approve from the assistant card or from the run's page.
- **No duplicates.** A change CloakTail already received is never sent again on replay. Write requests also carry an `Idempotency-Key` header (`<run id>:<call number>`) for servers that honour it.
- **Secrets.** Step results are stored in Postgres. The values behind `[secret:N]` handles are stored encrypted (AES-256-GCM, key derived from `SESSION_SECRET`); the model's view, the transcript and the run's published state only ever hold the handles. Changing `SESSION_SECRET` leaves old runs' handles unresolved.

**Workflows** (`/admin/workflows`) starts with the runs **waiting for you** (an approval or an answer), also counted on the sidebar on every admin page. Then each workflow's recent runs, and how it works: its steps in plain words, what you approve, and the check that ends each step (the agent's own instructions fold away under each step). A run's page shows its phases, transcript, cost (model calls and tokens), and the steps DBOS saved; **Stop** cancels a run and **Resume** carries a stopped or failed run on from its last saved step.

### The registration workflow is data

The phases are a JSON definition (`src/workflow/definitions.js`), interpreted by `src/workflow/registration.js`. A definition can only use the tools, checks and approval rules in the catalog next to it; `validate()` rejects anything else. A run copies the definition it started with. This is the ground work for the next step: changing the workflow by describing the change ("skip user migration", "ask me before every request"), with an AI editing the JSON, `validate()` checking it, and the admin approving the new version. The Workflows page shows where that will go.

### User migration runs

Each legacy sign-in that sends a user to CloakTail starts a run (also **Simulate result** on the Migration page). The browser path is unchanged: `/migrate/return` still verifies the result and signs the user in, and tells the run what happened. If the user never comes back, the run asks CloakTail's `/migrate/status` after 40 minutes and marks the user migrated if CloakTail did migrate them, instead of waiting for their next sign-in.

### Tests

`npm run test:workflow` drives real runs on Postgres against a fake CloakTail and a scripted model (no Gemini): every phase with approvals, a restart while waiting for approval (nothing is called or sent twice), declining with instructions, secrets never stored in the clear, and both user migration endings. Set `TEST_DBOS_DATABASE_URL` (e.g. `postgresql://postgres:postgres@localhost:5432/testsp_test_dbos`); without it those tests are skipped.

### Versions

A run resumes only on the application version it started on: `DBOS_APP_VERSION` (default `testsp-workflows-1`). If a change alters the order of a workflow's steps, bump it, and let old runs finish or stop them first.

## Customer documents (S3)

Any signed-in customer (SAML, OpenID Connect or legacy) can upload files on **Documents** (`/documents`, linked from the accounts page), then download or delete them. Each customer sees only their own files.

The page has **two upload buttons, one per method**, so you can compare them. Each upload shows its time and throughput, and each file shows the method it came by:

| | **Upload through the app** (proxied) | **Upload direct to S3** (presigned) |
|---|---|---|
| Path of the bytes | browser → app → S3 | browser → S3 |
| Requests | `POST /documents/proxied`: the raw file (`application/octet-stream`), name and type in `X-File-Name` / `X-File-Type` | `POST /documents/presigned` → a URL; multipart: `/:id/parts`; then `/:id/complete` (or `/:id/abort`) |
| How | The app streams the request body to S3 as it arrives, in 5 MB parts, 4 in flight: about 20 MB of memory per upload, nothing on disk | The app signs a PUT URL with the size and type bound in. Over 32 MB: a multipart upload whose part URLs are signed on demand; the browser sends 4 parts at once and retries a failed part |
| The app sees the bytes | Yes (it could scan or transform them) | No |
| App bandwidth and connections | Every byte in and out; one connection per upload for its whole length (3 at a time per customer) | Only small JSON calls |
| Bucket CORS | Not needed | Needed (`npm run s3:setup`) |
| Limits checked | Before the body is read (refused with `Connection: close`), as it streams, and on the stored object | Before signing, by S3 (signed size), and on the stored object |

Either way, a file is listed only once S3 holds all of it at the declared size, and a cancelled or failed upload leaves nothing behind. **Download** redirects to a GET URL that lasts a minute, as an attachment under the original name.

The list of files (owner, name, size, method, object key) is kept in `data/files.json` (`FILES_FILE`). Object keys hold no personal data: `<S3_KEY_PREFIX>/documents/<owner hash>/<file id>/<safe name>`.

### Set up

```bash
# .env: AWS_S3_BUCKET, AWS_REGION, and AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or AWS_PROFILE, or a role)
npm run s3:setup                             # CORS for BASE_URL (presigned), and a rule aborting abandoned uploads after a day
npm run s3:setup -- https://other.origin     # other origins
```

The CORS rule allows `PUT`, `GET` and `HEAD` from the app's origin with any header, and exposes `ETag` (multipart uploads read it). The bucket's other rules are kept. Proxied uploads hold the request open for the whole upload, so the server's request timeout is `UPLOAD_TIMEOUT_SECONDS` (default an hour, for every request) instead of Node's 5 minutes.

### The S3 factory (`src/factory/s3`)

All the S3 code lives here, generic enough for any other feature. `createS3Storage({ bucket, region })` returns one object per bucket:

| Group | Operations |
|---|---|
| Presigned URLs | `presignPut`, `presignGet`, `presignUploadPart` |
| Download | `getObject` (a stream, with optional byte range), `getObjectBytes`, `getObjectText`, `downloadToFile` |
| Upload from the server | `upload` (Buffer, string or stream of any size, even unknown; in parts when large; progress and cancel) |
| Objects | `head`, `exists`, `list` (pages), `listAll` (async iterator), `copy`, `move`, `remove`, `removeMany`, `removePrefix` |
| Multipart | `createMultipartUpload`, `completeMultipartUpload`, `abortMultipartUpload`, `listMultipartUploads` |
| Bucket | `getBucket`, `getCors`, `setCors`, `allowBrowserUploads`, `abortIncompleteUploadsAfter`; `listBuckets(client)` for the account |

Two ways to take uploads from clients sit on top of it, both checked against a policy from `defineUploadPolicy({ maxBytes, allowedTypes })`:

- `createStreamUploader({ storage, policy })`: `receive({ key, filename, contentType, size, body, signal })` streams any Readable (an HTTP request) to S3 and stops it if it runs past the declared size.
- `createPresignedUploader({ storage, policy })`: `begin`, `signParts`, `finish`, `abort`. It is stateless: the caller keeps the session server-side.

`objectKey` and `safeFilename` build keys. Every S3 failure is a `StorageError`, and every refused upload an `UploadRejectedError` with a `code`. `src/files.js` uses both uploaders.

`npm run test:files` runs the factory and the documents feature with the real AWS SDK against a fake S3 endpoint.

## Running more than one

To test several applications at once, copy the folder or run with different settings, e.g.:

```bash
PORT=4001 BASE_URL=http://localhost:4001 npm start
```

Each instance has its own entity ID derived from its base URL, unless one is set. Give each its own `SETTINGS_FILE`, `API_CREDENTIALS_FILE` and key files, or they share them.

## Notes

- Sessions are in memory; restarting signs everyone out. Workflow runs, including the assistant's conversations, are in Postgres and survive it. The saved API credential is kept; the access token is fetched again when needed.
- Keycloak's signing certificate is read from the IdP metadata URL and cached for an hour. Paste the one from the application page into the settings (or set `IDP_CERT`) to pin it. Saving the settings clears the cache.
- `package.json` overrides `xml-encryption` to 6.x: the 3.x that `@node-saml/node-saml` 5.1 pulls in cannot decrypt assertions Keycloak encrypts with `http://www.w3.org/2009/xmlenc11#rsa-oaep` (its default key transport). Drop the override once node-saml depends on 6.x.
