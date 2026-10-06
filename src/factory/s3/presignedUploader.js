// Browser-to-S3 uploads with presigned URLs. The file goes straight from the browser to S3; the
// server only signs and checks. Three calls, which an app exposes to its client:
//
//   begin(file)               small file: one presigned PUT URL
//                             large file: a multipart upload, its parts signed on demand
//   signParts(session, nums)  multipart only: presigned PUT URLs for a batch of parts
//   finish(session, {parts})  completes a multipart upload, then checks that the object S3 holds
//                             is the size that was declared (and deletes it if not)
//   abort(session)            gives up: frees stored parts, or deletes an unconfirmed object
//
// Stateless. begin returns a session, which the caller keeps server-side (with the owner, say) and
// passes back to the other calls; it returns an upload, which is what the client is sent.
import { StorageError, UploadRejectedError } from './errors.js';
import { defineUploadPolicy } from './policy.js';

const MiB = 1024 ** 2;
export const MIN_PART_BYTES = 5 * MiB; // S3's minimum for every part but the last
const MAX_PARTS = 10_000; // S3's maximum
const MAX_PARTS_PER_SIGN = 100;
const MAX_ETAG_LENGTH = 1024;
// S3 errors on completing that mean the client's parts were wrong, not that S3 failed.
const CLIENT_FAULTS = new Set(['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall', 'NoSuchUpload']);

// storage: from createS3Storage. policy: from defineUploadPolicy (default: any type, up to 5 TiB).
// Files up to multipartThreshold go in one PUT; larger ones in parts of partSize (raised as needed
// to stay within 10,000 parts).
export function createPresignedUploader({ storage, policy = defineUploadPolicy(), multipartThreshold = 32 * MiB, partSize = 16 * MiB, urlTtlSeconds } = {}) {
  if (!storage) throw new TypeError('createPresignedUploader needs a storage: see createS3Storage.');
  if (!Number.isSafeInteger(partSize) || partSize < MIN_PART_BYTES) throw new RangeError(`partSize must be at least ${MIN_PART_BYTES} bytes.`);
  if (!Number.isSafeInteger(multipartThreshold) || multipartThreshold < 0) throw new RangeError('multipartThreshold must be a positive number of bytes.');

  const partSizeFor = (size) => Math.max(partSize, Math.ceil(size / MAX_PARTS / MiB) * MiB);
  const partLength = (session, n) => Math.min(session.partSize, session.size - (n - 1) * session.partSize);

  function multipartOnly(session) {
    if (session?.mode !== 'multipart') throw new UploadRejectedError('not_multipart', 'This upload is not in parts.');
  }

  // Every part exactly once, each with the ETag S3 returned for it.
  function checkParts(session, parts) {
    const valid = Array.isArray(parts) && parts.length === session.partCount && parts.every((p) => Number.isInteger(p?.partNumber)
      && p.partNumber >= 1 && p.partNumber <= session.partCount
      && typeof p.etag === 'string' && p.etag && p.etag.length <= MAX_ETAG_LENGTH);
    if (!valid || new Set(parts.map((p) => p.partNumber)).size !== parts.length) {
      throw new UploadRejectedError('invalid_parts', `Send the ETag of each of the ${session.partCount} parts.`);
    }
    return parts.map(({ partNumber, etag }) => ({ partNumber, etag }));
  }

  return Object.freeze({
    policy,

    // file: { key, filename, contentType, size }. key is where the object goes: build it with
    // objectKey() and never take it from the client.
    async begin({ key, ...file }) {
      if (!key) throw new TypeError('begin needs the object key.');
      const { contentType, size } = policy.check(file);
      if (size <= multipartThreshold) {
        const put = await storage.presignPut({ key, contentType, contentLength: size, expiresIn: urlTtlSeconds });
        return { session: { mode: 'single', key, contentType, size }, upload: { mode: 'single', ...put } };
      }
      const sizeOfPart = partSizeFor(size);
      const { uploadId } = await storage.createMultipartUpload({ key, contentType });
      const partCount = Math.ceil(size / sizeOfPart);
      return {
        session: { mode: 'multipart', key, contentType, size, uploadId, partSize: sizeOfPart, partCount },
        upload: { mode: 'multipart', partSize: sizeOfPart, partCount, maxPartsPerRequest: MAX_PARTS_PER_SIGN },
      };
    },

    // [{ partNumber, url, method, headers, expiresAt }]. Each URL binds its part's exact size.
    async signParts(session, partNumbers) {
      multipartOnly(session);
      const numbers = [...new Set(Array.isArray(partNumbers) ? partNumbers : [])];
      if (!numbers.length || numbers.length > MAX_PARTS_PER_SIGN
        || !numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= session.partCount)) {
        throw new UploadRejectedError('invalid_parts', `Ask for 1 to ${MAX_PARTS_PER_SIGN} part numbers from 1 to ${session.partCount}.`);
      }
      const { key, uploadId } = session;
      return Promise.all(numbers.map(async (partNumber) => ({
        partNumber,
        ...(await storage.presignUploadPart({ key, uploadId, partNumber, contentLength: partLength(session, partNumber), expiresIn: urlTtlSeconds })),
      })));
    },

    // Returns { key, size, contentType, etag } once the object is in S3 as declared.
    async finish(session, { parts } = {}) {
      if (session.mode === 'multipart') {
        try {
          await storage.completeMultipartUpload({ key: session.key, uploadId: session.uploadId, parts: checkParts(session, parts) });
        } catch (err) {
          if (err instanceof StorageError && CLIENT_FAULTS.has(err.code)) {
            throw new UploadRejectedError('incomplete_upload', 'Storage did not accept the parts: upload the file again.');
          }
          throw err;
        }
      }
      const object = await storage.head(session.key);
      if (!object) throw new UploadRejectedError('not_uploaded', 'The file has not reached storage.');
      if (object.size !== session.size) {
        await storage.remove(session.key);
        throw new UploadRejectedError('size_mismatch', 'The stored file is not the size that was declared, so it was removed.');
      }
      return { key: session.key, size: object.size, contentType: object.contentType ?? session.contentType, etag: object.etag };
    },

    async abort(session) {
      if (session.mode === 'multipart') await storage.abortMultipartUpload({ key: session.key, uploadId: session.uploadId });
      else await storage.remove(session.key); // the PUT may have landed without finish being called
    },
  });
}
