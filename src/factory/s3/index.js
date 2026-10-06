// S3 for any feature: one storage object per bucket (presigned URLs, upload, download, list, copy,
// delete, bucket setup), and two ways to take uploads from clients on top of it:
//   createStreamUploader     client -> server -> S3: the server streams the request body on to S3
//   createPresignedUploader  client -> S3: the server only signs URLs, the bytes skip it
//
//   import { createS3Storage, createStreamUploader, defineUploadPolicy, objectKey, safeFilename } from './factory/s3/index.js';
//
//   const storage = createS3Storage({ bucket, region });
//
//   // server side
//   await storage.upload({ key: 'reports/2026.csv', body: fs.createReadStream(file), contentType: 'text/csv' });
//   const { body } = await storage.getObject('reports/2026.csv');          // a Node stream
//   for await (const o of storage.listAll({ prefix: 'reports/' })) { ... }
//
//   // an upload from a browser, streamed through this server (in an Express route)
//   const uploader = createStreamUploader({ storage, policy: defineUploadPolicy({ maxBytes: 10 * 1024 ** 2, allowedTypes: ['image/*'] }) });
//   const object = await uploader.receive({
//     key: objectKey('avatars', userId, safeFilename(name)), filename: name, contentType, size: Number(req.get('content-length')), body: req,
//   });
//   const { url } = await storage.presignGet({ key: object.key, downloadName: name });   // a download link
//
// Presigned uploads need the bucket's CORS to allow the browser: storage.allowBrowserUploads([appOrigin]).
export { createS3Storage } from './storage.js';
export { createS3Client } from './client.js';
export { DEFAULT_URL_TTL_SECONDS } from './presign.js';
export { listBuckets, BROWSER_UPLOADS_RULE_ID, ABORT_INCOMPLETE_RULE_ID } from './bucket.js';
export { createStreamUploader } from './streamUploader.js';
export { createPresignedUploader, MIN_PART_BYTES } from './presignedUploader.js';
export { defineUploadPolicy, S3_MAX_OBJECT_BYTES, DEFAULT_CONTENT_TYPE } from './policy.js';
export { objectKey, safeFilename, contentDisposition, formatBytes } from './names.js';
export { StorageError, UploadRejectedError } from './errors.js';
