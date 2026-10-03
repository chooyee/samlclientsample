// OpenID Connect relying party, built with openid-client v6 as the portal's Node.js example is:
// the issuer, client ID and (for a confidential client) secret are all it is given; everything
// else comes from the discovery document.
import * as client from 'openid-client';

let cached = null; // { key, promise } for the current settings

// The discovered configuration, fetched once per settings change. A failed discovery is not
// cached, so the next sign-in retries.
export function getOidcConfig(oidc) {
  const key = JSON.stringify([oidc.issuer, oidc.clientId, oidc.clientSecret]);
  if (cached?.key === key) return cached.promise;
  const promise = client.discovery(
    new URL(oidc.issuer),
    oidc.clientId,
    oidc.clientSecret || undefined,
    oidc.clientSecret ? undefined : client.None(),
    {
      timeout: 5,
      // Keycloak on http:// in development.
      execute: oidc.issuer.startsWith('http:') ? [client.allowInsecureRequests] : [],
    },
  );
  cached = { key, promise };
  promise.catch(() => { if (cached?.promise === promise) cached = null; });
  return promise;
}

export const clearOidcConfig = () => { cached = null; };

// The endpoints the discovery document lists, for display. Never throws.
export async function discoveryStatus(oidc) {
  if (!oidc.issuer || !oidc.clientId) return { ok: false, error: null };
  try {
    const m = (await getOidcConfig(oidc)).serverMetadata();
    return {
      ok: true,
      endpoints: {
        authorization: m.authorization_endpoint,
        token: m.token_endpoint,
        userinfo: m.userinfo_endpoint,
        jwks: m.jwks_uri,
        endSession: m.end_session_endpoint,
      },
      pkceMethods: m.code_challenge_methods_supported ?? [],
      frontchannelLogout: Boolean(m.frontchannel_logout_supported),
    };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

// Starts a sign-in. Returns { url, pending }; keep pending in the session for the callback.
export async function startSignIn(oidc, { prompt, loginHint } = {}) {
  const config = await getOidcConfig(oidc);
  const pending = { state: client.randomState(), nonce: client.randomNonce(), startedAt: Date.now() };
  const params = {
    redirect_uri: oidc.redirectUri,
    scope: oidc.scopes,
    state: pending.state,
    nonce: pending.nonce,
  };
  if (oidc.usePkce) {
    pending.codeVerifier = client.randomPKCECodeVerifier();
    params.code_challenge = await client.calculatePKCECodeChallenge(pending.codeVerifier);
    params.code_challenge_method = 'S256';
  }
  if (prompt) params.prompt = prompt;
  if (loginHint) params.login_hint = loginHint;
  return { url: client.buildAuthorizationUrl(config, params).href, pending };
}

// Finishes a sign-in at the redirect URI. Returns the session user.
export async function finishSignIn(oidc, currentUrl, pending) {
  const config = await getOidcConfig(oidc);
  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: pending.codeVerifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  let userinfo = null;
  let userinfoError = null;
  try {
    userinfo = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
  } catch (err) {
    userinfoError = describeError(err);
  }
  return {
    protocol: 'oidc',
    subject: claims.sub,
    issuer: claims.iss,
    sid: claims.sid ?? null,
    email: claims.email ?? userinfo?.email ?? null,
    name: claims.name ?? userinfo?.name ?? null,
    username: claims.preferred_username ?? userinfo?.preferred_username ?? null,
    claims: { ...claims },
    userinfo,
    userinfoError,
    tokens: tokenSet(tokens),
    usedPkce: Boolean(pending.codeVerifier),
    flow: 'Authorization code' + (pending.codeVerifier ? ' + PKCE (S256)' : ''),
    signedInAt: new Date().toISOString(),
    refreshedAt: null,
  };
}

// Uses the refresh token. Returns the user with new tokens.
export async function refresh(oidc, user) {
  const config = await getOidcConfig(oidc);
  const tokens = await client.refreshTokenGrant(config, user.tokens.refreshToken);
  const claims = tokens.claims();
  return {
    ...user,
    claims: claims ? { ...claims } : user.claims,
    tokens: tokenSet(tokens, user.tokens),
    refreshedAt: new Date().toISOString(),
  };
}

// RP-initiated logout URL, or null when the provider has no end session endpoint.
export async function endSessionUrl(oidc, user) {
  const config = await getOidcConfig(oidc);
  if (!config.serverMetadata().end_session_endpoint) return null;
  return client.buildEndSessionUrl(config, {
    id_token_hint: user.tokens.idToken,
    post_logout_redirect_uri: oidc.postLogoutRedirectUri,
  }).href;
}

function tokenSet(tokens, previous = {}) {
  return {
    idToken: tokens.id_token ?? previous.idToken ?? null,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous.refreshToken ?? null,
    tokenType: tokens.token_type,
    scope: tokens.scope ?? previous.scope ?? null,
    expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
    refreshExpiresAt: tokens.refresh_expires_in
      ? new Date(Date.now() + tokens.refresh_expires_in * 1000).toISOString()
      : previous.refreshExpiresAt ?? null,
  };
}

// Header and payload of a JWT, for display only: not verified here.
export function decodeJwt(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const part = (p) => JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return { header: part(parts[0]), payload: part(parts[1]) };
  } catch {
    return null;
  }
}

// A readable message for openid-client and Keycloak errors.
export function describeError(err) {
  if (err instanceof client.AuthorizationResponseError || err instanceof client.ResponseBodyError) {
    return `${err.error}${err.error_description ? `: ${err.error_description}` : ''}`;
  }
  const cause = err?.cause?.message || err?.cause?.code;
  return cause && !String(err.message).includes(cause) ? `${err.message} (${cause})` : err?.message ?? String(err);
}
