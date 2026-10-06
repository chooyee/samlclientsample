// Prepares the S3 bucket for customer documents: checks it can be reached, lets the app's origin
// upload directly with presigned URLs (CORS; proxied uploads don't need it), and aborts multipart
// uploads abandoned for a day.
// Run once per bucket, and again when the base URL changes: npm run s3:setup [-- https://other.origin]
import { config, envDefaults } from '../src/config.js';
import { createS3Storage, ABORT_INCOMPLETE_RULE_ID } from '../src/factory/s3/index.js';

if (!config.s3.bucket) {
  console.error('Set AWS_S3_BUCKET and AWS_REGION first (see .env.example).');
  process.exit(1);
}

const storage = createS3Storage({ bucket: config.s3.bucket, region: config.s3.region });
const origins = process.argv.slice(2).length ? process.argv.slice(2) : [envDefaults.baseUrl];

try {
  const bucket = await storage.getBucket();
  if (!bucket) throw new Error(`Bucket ${config.s3.bucket} does not exist.`);
  if (bucket.region && bucket.region !== config.s3.region) console.warn(`Note: the bucket is in ${bucket.region}, AWS_REGION is ${config.s3.region}.`);

  const rules = await storage.allowBrowserUploads(origins);
  console.log(`CORS: ${origins.join(', ')} may upload and download (${rules.length} rule${rules.length === 1 ? '' : 's'} on the bucket).`);

  await storage.abortIncompleteUploadsAfter(1, { prefix: config.s3.keyPrefix });
  console.log(`Lifecycle: unfinished uploads under ${config.s3.keyPrefix}/ are aborted after a day (rule ${ABORT_INCOMPLETE_RULE_ID}).`);
} catch (err) {
  console.error(`S3 setup failed: ${err.message}`);
  process.exit(1);
}
