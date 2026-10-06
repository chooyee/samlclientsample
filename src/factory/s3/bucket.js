// Bucket-level operations: whether the bucket is reachable, and the two settings browser uploads
// depend on (CORS, and a lifecycle rule that cleans up abandoned multipart uploads).
// Usually run from a setup script or an admin page, not on every request.
import {
  HeadBucketCommand, ListBucketsCommand, GetBucketCorsCommand, PutBucketCorsCommand, DeleteBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import { send, sendOr } from './client.js';

export const BROWSER_UPLOADS_RULE_ID = 'browser-uploads';
export const ABORT_INCOMPLETE_RULE_ID = 'abort-incomplete-multipart-uploads';

// S3's CORS shape <-> plain objects.
const toCorsRule = (r) => ({
  ID: r.id,
  AllowedOrigins: r.allowedOrigins,
  AllowedMethods: r.allowedMethods,
  AllowedHeaders: r.allowedHeaders,
  ExposeHeaders: r.exposeHeaders,
  MaxAgeSeconds: r.maxAgeSeconds,
});
const fromCorsRule = (r) => ({
  id: r.ID ?? null,
  allowedOrigins: r.AllowedOrigins ?? [],
  allowedMethods: r.AllowedMethods ?? [],
  allowedHeaders: r.AllowedHeaders ?? [],
  exposeHeaders: r.ExposeHeaders ?? [],
  maxAgeSeconds: r.MaxAgeSeconds ?? null,
});

// Every bucket the credentials can see, across regions: [{ name, createdAt }].
export async function listBuckets(s3) {
  const r = await send(s3, new ListBucketsCommand({}), 'ListBuckets');
  return (r.Buckets ?? []).map((b) => ({ name: b.Name, createdAt: b.CreationDate ?? null }));
}

export function bucketOperations({ s3, bucket }) {
  async function getCors() {
    const r = await sendOr(s3, new GetBucketCorsCommand({ Bucket: bucket }), 'GetBucketCors', null);
    return (r?.CORSRules ?? []).map(fromCorsRule);
  }

  async function setCors(rules) {
    if (!rules.length) {
      await send(s3, new DeleteBucketCorsCommand({ Bucket: bucket }), 'DeleteBucketCors');
      return;
    }
    await send(s3, new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: rules.map(toCorsRule) } }), 'PutBucketCors');
  }

  return {
    // { name, region } when the bucket exists and the credentials may use it; null when it doesn't
    // exist. Throws a StorageError (code 'Forbidden') when it exists but access is denied.
    async getBucket() {
      const r = await sendOr(s3, new HeadBucketCommand({ Bucket: bucket }), 'HeadBucket', null);
      return r && { name: bucket, region: r.BucketRegion ?? null };
    },

    // [{ id, allowedOrigins, allowedMethods, allowedHeaders, exposeHeaders, maxAgeSeconds }]; [] when none.
    getCors,

    // Replaces every CORS rule. [] removes them all.
    setCors,

    // The CORS rule presigned browser uploads and downloads need: PUT, GET and HEAD from these
    // origins, any request header, and the ETag exposed (multipart uploads read it). Replaces an
    // earlier rule of the same id and keeps the bucket's other rules. Returns every rule now set.
    async allowBrowserUploads(origins, { maxAgeSeconds = 3000 } = {}) {
      const rule = {
        id: BROWSER_UPLOADS_RULE_ID,
        allowedOrigins: [...new Set(origins.map((o) => new URL(o).origin))],
        allowedMethods: ['PUT', 'GET', 'HEAD'],
        allowedHeaders: ['*'],
        exposeHeaders: ['ETag'],
        maxAgeSeconds,
      };
      const rules = [...(await getCors()).filter((r) => r.id !== BROWSER_UPLOADS_RULE_ID), rule];
      await setCors(rules);
      return rules;
    },

    // Adds (or updates) a lifecycle rule that aborts multipart uploads left unfinished for this many
    // days, so their parts stop costing storage. Keeps the bucket's other lifecycle rules.
    async abortIncompleteUploadsAfter(days, { prefix = '' } = {}) {
      if (!Number.isInteger(days) || days < 1) throw new RangeError('days must be a whole number of at least 1.');
      const current = await sendOr(s3, new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }), 'GetBucketLifecycleConfiguration', null);
      const Rules = [
        ...(current?.Rules ?? []).filter((r) => r.ID !== ABORT_INCOMPLETE_RULE_ID),
        { ID: ABORT_INCOMPLETE_RULE_ID, Status: 'Enabled', Filter: { Prefix: prefix }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: days } },
      ];
      await send(s3, new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: { Rules } }), 'PutBucketLifecycleConfiguration');
    },
  };
}
