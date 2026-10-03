// Generates the SP's signing and encryption key pairs. Paste the certificates into the portal
// when "Require signed requests" or "Encrypt assertions" is turned on for the application.
// The home page can do the same (Certificates section).
//   npm run gen:certs [-- --force] [--key-size=3072] [--years=5]
import { config } from '../src/config.js';
import { generateKeyPair, loadKeyPair } from '../src/certs.js';
import { resolve } from '../src/settings.js';

const arg = (name, fallback) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const force = process.argv.includes('--force');
const keySize = arg('key-size', 2048);
const years = arg('years', 10);
const { entityId } = resolve().sp;

for (const kind of Object.keys(config.keyFiles)) {
  const files = config.keyFiles[kind];
  if (loadKeyPair(kind) && !force) {
    console.log(`${files.key} already exists. Use --force to replace it (then update the certificate in the portal).`);
    continue;
  }
  const { info } = await generateKeyPair(kind, { commonName: `${entityId} ${kind}`, keySize, years });
  console.log(`Wrote ${files.key} and ${files.cert} (SHA-256 ${info.fingerprint256}).`);
}
