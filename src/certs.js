// The SP's own key pairs: one for signing AuthnRequests / LogoutRequests, one for decrypting
// assertions. Self-signed is fine; Keycloak only pins the certificate pasted into the client.
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import selfsigned from 'selfsigned';
import { config } from './config.js';

export const KEY_SIZES = [2048, 3072, 4096];
export const VALIDITY_YEARS = [1, 2, 5, 10];

const KEY_USAGE = {
  signing: { digitalSignature: true, nonRepudiation: true },
  encryption: { keyEncipherment: true, dataEncipherment: true },
};

export function isKind(kind) {
  return Object.hasOwn(config.keyFiles, kind);
}

// Base64 body of a PEM certificate, as Keycloak's certificate fields expect it.
export const certBase64 = (pem) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

export function certInfo(pem) {
  const x = new X509Certificate(pem);
  const validTo = new Date(x.validTo);
  return {
    subject: x.subject.replace(/\n/g, ', '),
    validFrom: new Date(x.validFrom).toISOString(),
    validTo: validTo.toISOString(),
    expired: validTo < new Date(),
    keySize: x.publicKey.asymmetricKeyDetails?.modulusLength,
    fingerprint256: x.fingerprint256,
  };
}

// Returns { key, cert, info }, or null when the files don't exist yet.
// Throws when they exist but are unreadable or don't belong together.
export function loadKeyPair(kind) {
  const files = config.keyFiles[kind];
  if (!fs.existsSync(files.key) || !fs.existsSync(files.cert)) return null;
  const key = fs.readFileSync(files.key, 'utf8');
  const cert = fs.readFileSync(files.cert, 'utf8');
  if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))) {
    throw new Error(`${files.cert} does not match ${files.key}. Generate a new ${kind} key pair.`);
  }
  return { key, cert, info: certInfo(cert) };
}

export async function generateKeyPair(kind, { commonName, keySize = 2048, years = 10 }) {
  if (!isKind(kind)) throw new Error(`Unknown key pair "${kind}"`);
  if (!KEY_SIZES.includes(keySize)) throw new Error(`Key size must be one of ${KEY_SIZES.join(', ')}`);
  if (!VALIDITY_YEARS.includes(years)) throw new Error(`Validity must be one of ${VALIDITY_YEARS.join(', ')} years`);

  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + years);
  const pems = await selfsigned.generate([{ name: 'commonName', value: commonName }], {
    keySize,
    algorithm: 'sha256',
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', ...KEY_USAGE[kind], critical: true },
    ],
  });

  const files = config.keyFiles[kind];
  for (const file of [files.key, files.cert]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(files.key, pems.private, { mode: 0o600 });
  fs.writeFileSync(files.cert, pems.cert);
  return loadKeyPair(kind);
}
