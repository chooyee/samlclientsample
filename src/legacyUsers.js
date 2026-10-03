// The "legacy" user store: accounts with their own password, as an application has them before
// it moves to Keycloak. Each user carries the migration flag the CloakTail protocol asks for
// (migratedAt + keycloakId); migrated users sign in with Keycloak only.
// Saved to config.legacyUsersFile; seeded with demo users the first time.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

export const DEMO_PASSWORD = 'Legacy#2024';

const SEED = [
  { id: '1001', username: 'alice', email: 'alice@example.com', firstName: 'Alice', lastName: 'Tan' },
  { id: '1002', username: 'bob', email: 'bob@example.com', firstName: 'Bob', lastName: 'Lim' },
  { id: '1003', username: 'carol', email: 'carol@example.com', firstName: 'Carol', lastName: 'Wong' },
];

// scrypt$<salt>$<hash>, both base64url.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${crypto.scryptSync(password, salt, 32).toString('base64url')}`;
}

function passwordMatches(stored, password) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Compared against when the username is unknown, so a miss costs as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomUUID());

const fresh = (u) => ({
  ...u,
  passwordHash: hashPassword(DEMO_PASSWORD),
  createdAt: new Date().toISOString(),
  lastLegacySignInAt: null,
  migrationStartedAt: null,
  migratedAt: null,
  keycloakId: null,
  keycloakUsername: null,
  firstKeycloakSignInAt: null,
  conflict: null,
});

function load() {
  if (fs.existsSync(config.legacyUsersFile)) {
    try {
      return JSON.parse(fs.readFileSync(config.legacyUsersFile, 'utf8'));
    } catch (err) {
      console.warn(`Ignoring ${config.legacyUsersFile}: ${err.message}`);
    }
  }
  return Object.fromEntries(SEED.map((u) => [u.id, fresh(u)]));
}

let users = load();

function persist() {
  fs.mkdirSync(path.dirname(config.legacyUsersFile), { recursive: true });
  fs.writeFileSync(config.legacyUsersFile, `${JSON.stringify(users, null, 2)}\n`);
}
if (!fs.existsSync(config.legacyUsersFile)) persist();

const withoutHash = ({ passwordHash, ...u }) => u;

export const isMigrated = (u) => Boolean(u?.migratedAt && u?.keycloakId);

export const getLegacyUser = (id) => (users[id] ? withoutHash(users[id]) : null);

export const findByUsername = (username) => {
  const name = String(username ?? '').trim().toLowerCase();
  const u = Object.values(users).find((x) => x.username.toLowerCase() === name);
  return u ? withoutHash(u) : null;
};

export const listLegacyUsers = () => Object.values(users).map(withoutHash)
  .sort((a, b) => a.username.localeCompare(b.username));

// Checks the old password. Returns the user, or null. Never used for a migrated user.
export function checkPassword(username, password) {
  const name = String(username ?? '').trim().toLowerCase();
  const u = Object.values(users).find((x) => x.username.toLowerCase() === name);
  if (!passwordMatches(u?.passwordHash ?? DUMMY_HASH, password) || !u) return null;
  return withoutHash(u);
}

function update(id, changes) {
  if (!users[id]) return null;
  users[id] = { ...users[id], ...changes };
  persist();
  return withoutHash(users[id]);
}

export const recordLegacySignIn = (id) => update(id, { lastLegacySignInAt: new Date().toISOString() });

// Set when the user is sent to CloakTail, so a lost result can be recovered at the next sign-in.
export const recordMigrationStarted = (id) => update(id, { migrationStartedAt: new Date().toISOString() });

// Idempotent: already_migrated can arrive for a user marked before. Keeps the first migratedAt.
export function markMigrated(id, { keycloakId, keycloakUsername }) {
  const u = users[id];
  if (!u) return null;
  return update(id, {
    migratedAt: u.migratedAt ?? new Date().toISOString(),
    keycloakId,
    keycloakUsername: keycloakUsername ?? u.keycloakUsername,
    conflict: null,
  });
}

export const markConflict = (id, detail) => update(id, { conflict: { at: new Date().toISOString(), detail: detail ?? null } });

// Forgets the migration so the user is asked again. The Keycloak account (if any) is untouched.
export const resetMigration = (id) => update(id, {
  migrationStartedAt: null, migratedAt: null, keycloakId: null, keycloakUsername: null, firstKeycloakSignInAt: null, conflict: null,
});

// resetMigration for every migrated or conflicted user. Returns how many were reset.
export function resetAllMigrations() {
  const ids = Object.values(users).filter((u) => isMigrated(u) || u.conflict || u.migrationStartedAt).map((u) => u.id);
  ids.forEach(resetMigration);
  return ids.length;
}

// The migrated legacy user a Keycloak sign-in belongs to, or null. OIDC: sub is the Keycloak
// user id. SAML: the Name ID is the username or email, depending on the Name ID format.
export function findByKeycloakUser(user) {
  const candidates = user.protocol === 'oidc'
    ? [user.subject, user.username, user.email]
    : [user.nameID, user.email];
  const values = candidates.filter(Boolean).map((v) => String(v).toLowerCase());
  const u = Object.values(users).find((x) => isMigrated(x) && [x.keycloakId, x.keycloakUsername, x.email]
    .filter(Boolean).some((v) => values.includes(String(v).toLowerCase())));
  return u ? withoutHash(u) : null;
}

// Marks the first Keycloak sign-in after migration. Returns true the first time.
export function recordKeycloakSignIn(id) {
  if (!users[id] || users[id].firstKeycloakSignInAt) return false;
  update(id, { firstKeycloakSignInAt: new Date().toISOString() });
  return true;
}

export class LegacyUserError extends Error {}

export function addLegacyUser({ username, email, firstName, lastName, password }) {
  const name = String(username ?? '').trim();
  if (!/^[^\s\x00-\x1f\x7f]{1,255}$/.test(name)) throw new LegacyUserError('Username is required: no spaces or control characters.');
  if (findByUsername(name)) throw new LegacyUserError(`There is already a user "${name}".`);
  const mail = String(email ?? '').trim();
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new LegacyUserError('That email address doesn\'t look right.');
  if (String(password ?? '').length < 8) throw new LegacyUserError('Password must have at least 8 characters.');
  const id = String(Math.max(1000, ...Object.keys(users).map(Number).filter(Number.isFinite)) + 1);
  users[id] = {
    ...fresh({ id, username: name, email: mail || null, firstName: String(firstName ?? '').trim().slice(0, 100) || null, lastName: String(lastName ?? '').trim().slice(0, 100) || null }),
    passwordHash: hashPassword(password),
  };
  persist();
  return withoutHash(users[id]);
}

export function resetLegacyUsers() {
  users = Object.fromEntries(SEED.map((u) => [u.id, fresh(u)]));
  persist();
}
