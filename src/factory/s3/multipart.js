// Multipart uploads driven from outside (a browser with presigned part URLs, see presignedUploader.js).
// For uploading a stream from the server, use upload() in objects.js or streamUploader.js.
import {
  CreateMultipartUploadCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { StorageError } from './errors.js';
import { send, isNotFound } from './client.js';

export function multipartOperations({ s3, bucket }) {
  return {
    async createMultipartUpload({ key, contentType }) {
      const r = await send(s3, new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }), 'CreateMultipartUpload');
      return { uploadId: r.UploadId };
    },

    // parts: [{ partNumber, etag }], in any order.
    async completeMultipartUpload({ key, uploadId, parts }) {
      const Parts = [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag }));
      await send(s3, new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts } }), 'CompleteMultipartUpload');
    },

    // Frees the parts already stored. Aborting an upload that is already gone succeeds.
    async abortMultipartUpload({ key, uploadId }) {
      try {
        await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
      } catch (err) {
        if (err?.name === 'NoSuchUpload' || isNotFound(err)) return;
        throw new StorageError(`S3 AbortMultipartUpload failed: ${err.message}`, { cause: err });
      }
    },

    // Unfinished multipart uploads (they cost storage until aborted): [{ key, uploadId, startedAt }].
    // Up to 1,000; a bucket lifecycle rule (AbortIncompleteMultipartUpload) is the long-term fix.
    async listMultipartUploads({ prefix } = {}) {
      const r = await send(s3, new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }), 'ListMultipartUploads');
      return (r.Uploads ?? []).map((u) => ({ key: u.Key, uploadId: u.UploadId, startedAt: u.Initiated ?? null }));
    },
  };
}
