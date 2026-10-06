// S3 storage for one bucket: every operation this factory offers, behind one object.
// Generic: knows nothing about users or this app.
//
//   const storage = createS3Storage({ bucket: 'my-bucket', region: 'ap-southeast-1' });
//
//   presigned URLs (presign.js)   presignPut, presignGet, presignUploadPart
//   objects (objects.js)          head, exists, getObject, getObjectBytes, getObjectText, downloadToFile,
//                                 upload, copy, move, remove, removeMany, removePrefix, list, listAll
//   multipart (multipart.js)      createMultipartUpload, completeMultipartUpload, abortMultipartUpload,
//                                 listMultipartUploads
//   bucket (bucket.js)            getBucket, getCors, setCors, allowBrowserUploads, abortIncompleteUploadsAfter
//
// Credentials come from the default AWS chain (environment, shared profile, instance or task role)
// unless given. Every failure is rethrown as a StorageError.
import { StorageError } from './errors.js';
import { createS3Client } from './client.js';
import { presignOperations, DEFAULT_URL_TTL_SECONDS } from './presign.js';
import { objectOperations } from './objects.js';
import { multipartOperations } from './multipart.js';
import { bucketOperations } from './bucket.js';

// client: an S3Client to share (several buckets in one account, or tests). Otherwise one is made
// from region and credentials. urlTtlSeconds: how long presigned URLs last unless a call says.
export function createS3Storage({ bucket, region, credentials, client, urlTtlSeconds = DEFAULT_URL_TTL_SECONDS } = {}) {
  if (!bucket) throw new StorageError('An S3 bucket is required.');
  const context = { s3: client ?? createS3Client({ region, credentials }), bucket, urlTtlSeconds };
  return Object.freeze({
    bucket,
    client: context.s3, // for the rare call this factory doesn't cover
    ...presignOperations(context),
    ...objectOperations(context),
    ...multipartOperations(context),
    ...bucketOperations(context),
  });
}
