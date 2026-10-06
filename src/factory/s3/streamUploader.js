// Uploads that pass through the server: the client streams the file to the server, which streams it
// on to S3 as it arrives. Nothing is written to disk and only a few parts are held in memory
// (partSize x queueSize), whatever the file's size.
//
//   const uploader = createStreamUploader({ storage, policy });
//   const object = await uploader.receive({ key, filename, contentType, size, body: req, signal });
//
// body is any Readable (an HTTP request, a file stream). size is what the client declared, e.g. its
// Content-Length: the policy is checked against it before a byte is read, the stream is cut off if
// it runs longer, and the stored object is checked against it afterwards. Compared with
// presignedUploader.js the server sees every byte (it could scan or transform them) and the bucket
// needs no CORS, at the cost of the server's bandwidth and a connection held for the whole upload.
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UploadRejectedError } from './errors.js';
import { defineUploadPolicy } from './policy.js';
import { MIN_PART_BYTES } from './presignedUploader.js';

// Passes the bytes through, failing as soon as there are more than expected, or at the end if fewer.
function exactly(expected) {
  let seen = 0;
  return new Transform({
    transform(chunk, encoding, done) {
      seen += chunk.length;
      done(seen > expected ? new UploadRejectedError('size_mismatch', 'The file is larger than declared.') : null, chunk);
    },
    flush(done) {
      done(seen < expected ? new UploadRejectedError('incomplete_upload', 'The upload stopped before the whole file arrived.') : null);
    },
  });
}

// storage: from createS3Storage. policy: from defineUploadPolicy (default: any type, up to 5 TiB).
// partSize, queueSize: how the stream goes up in parts; memory per upload is about their product.
export function createStreamUploader({ storage, policy = defineUploadPolicy(), partSize = MIN_PART_BYTES, queueSize = 4 } = {}) {
  if (!storage) throw new TypeError('createStreamUploader needs a storage: see createS3Storage.');
  if (!Number.isSafeInteger(partSize) || partSize < MIN_PART_BYTES) throw new RangeError(`partSize must be at least ${MIN_PART_BYTES} bytes.`);

  return Object.freeze({
    policy,

    // file: { key, filename, contentType, size, body, signal, onProgress }. key is where the object
    // goes: build it with objectKey() and never take it from the client. signal: an AbortSignal,
    // e.g. aborted when the client disconnects. Returns { key, size, contentType, etag }.
    // Throws UploadRejectedError when the file breaks the policy, isn't the declared size, or the
    // upload is cancelled (nothing is left in S3 then); StorageError when S3 fails.
    async receive({ key, body, signal, onProgress, ...file }) {
      if (!key) throw new TypeError('receive needs the object key.');
      if (!body) throw new TypeError('receive needs the body to upload.');
      const { contentType, size } = policy.check(file);

      // An error in the body (the client went away) or the size check fails the upload; it is kept
      // as it happens, to report the real cause rather than S3's view of it.
      const checked = exactly(size);
      let streamError = null;
      checked.on('error', (err) => { streamError ??= err; });
      pipeline(body, checked).catch(() => {}); // errors are kept above; pipeline cleans up both streams
      try {
        await storage.upload({ key, body: checked, contentType, partSize, queueSize, onProgress, signal });
      } catch (err) {
        checked.destroy(); // S3 failed first: stop reading the body
        if (streamError instanceof UploadRejectedError) throw streamError;
        if (signal?.aborted || streamError) throw new UploadRejectedError('cancelled', 'The upload was cancelled before it finished.');
        throw err;
      }

      const object = await storage.head(key);
      if (!object || object.size !== size) {
        if (object) await storage.remove(key);
        throw new UploadRejectedError('size_mismatch', 'The stored file is not the size that was declared, so it was removed.');
      }
      return { key, size: object.size, contentType: object.contentType ?? contentType, etag: object.etag };
    },
  });
}
