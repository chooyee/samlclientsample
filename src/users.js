// Just-in-time provisioning: the first sign-in (SAML or OpenID Connect) creates a local profile.
// Keycloak still owns the account and credentials; this store holds only what the app adds.
// Saved to config.usersFile so profiles survive a restart.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';

function load() {
  if (!fs.existsSync(config.usersFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(config.usersFile, 'utf8'));
  } catch (err) {
    console.warn(`Ignoring ${config.usersFile}: ${err.message}`);
    return {};
  }
}

let users = load();

function persist() {
  fs.mkdirSync(path.dirname(config.usersFile), { recursive: true });
  fs.writeFileSync(config.usersFile, `${JSON.stringify(users, null, 2)}\n`);
}

// A transient Name ID changes on every sign-in, so it can't identify a returning user.
export const canProvision = (user) => user.protocol === 'oidc' || user.nameIDFormat !== TRANSIENT;

// Profiles are keyed by IdP and subject: the same Name ID from another IdP is another person.
// An OIDC sub is not a SAML Name ID, even from the same realm, so it gets its own prefix.
export const userKey = (user) => (user.protocol === 'oidc'
  ? `oidc|${user.issuer}|${user.subject}`
  : `${user.issuer}|${user.nameID}`);

const first = (v) => (Array.isArray(v) ? v[0] : v);

function identity(user) {
  if (user.protocol === 'oidc') {
    const c = { ...user.userinfo, ...user.claims };
    return {
      protocol: 'oidc',
      issuer: user.issuer,
      subject: user.subject,
      username: c.preferred_username ?? null,
      email: c.email ?? null,
      firstName: c.given_name ?? null,
      lastName: c.family_name ?? null,
    };
  }
  return {
    protocol: 'saml',
    issuer: user.issuer,
    nameID: user.nameID,
    nameIDFormat: user.nameIDFormat,
    email: user.email,
    firstName: first(user.attributes.firstName) || null,
    lastName: first(user.attributes.lastName) || null,
  };
}

// Creates the profile on first sign-in, or refreshes it. Returns { profile, created }, or null
// when the Name ID is transient.
export function provision(user) {
  if (!canProvision(user)) return null;
  const key = userKey(user);
  const now = new Date().toISOString();
  const existing = users[key];
  const profile = {
    ...identity(user),
    createdAt: existing?.createdAt ?? now,
    lastSignInAt: now,
    signInCount: (existing?.signInCount ?? 0) + 1,
  };
  users[key] = profile;
  persist();
  return { profile, created: !existing };
}

export const getProfile = (user) => (user ? users[userKey(user)] ?? null : null);
// Profiles saved before OIDC support have no protocol: they are SAML.
export const listProfiles = () => Object.values(users)
  .map((p) => ({ protocol: 'saml', ...p }))
  .sort((a, b) => b.lastSignInAt.localeCompare(a.lastSignInAt));

export function clearProfiles() {
  users = {};
  fs.rmSync(config.usersFile, { force: true });
}
