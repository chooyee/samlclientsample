// Reads the IdP's SAML signing certificate(s) from its metadata URL, cached for an hour per URL,
// so a Keycloak key rotation is picked up without an app restart.
const cache = new Map(); // metadataUrl -> { certs, fetchedAt }

export const clearIdpCertCache = () => cache.clear();

export async function loadIdpCerts(metadataUrl) {
  const hit = cache.get(metadataUrl);
  if (hit && Date.now() - hit.fetchedAt < 3600_000) return hit.certs;
  const res = await fetch(metadataUrl, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Failed to fetch the IdP metadata ${metadataUrl} (${res.status})`);
  const xml = await res.text();
  const certs = [...xml.matchAll(/<md:KeyDescriptor use="signing">([\s\S]*?)<\/md:KeyDescriptor>/g)]
    .flatMap((m) => [...m[1].matchAll(/<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/g)].map((c) => c[1].trim()));
  if (!certs.length) throw new Error(`No signing certificate found in ${metadataUrl}`);
  cache.set(metadataUrl, { certs, fetchedAt: Date.now() });
  return certs;
}

// node-saml accepts a callback for idpCert; this adapts loadIdpCerts to it.
// (node-saml promisifies it, so it must not itself return a Promise.)
export const idpCertCallback = (metadataUrl) => (callback) => {
  loadIdpCerts(metadataUrl).then((certs) => callback(null, certs), (err) => callback(err));
};
