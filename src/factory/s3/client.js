// The S3 client, and the error handling every operation shares.
import { S3Client } from '@aws-sdk/client-s3';
import { StorageError } from './errors.js';

// The SDK adds a CRC32 checksum of the (empty) body to presigned URLs by default, which makes S3
// refuse every upload from a browser. Checksums are sent only when an operation requires one.
// options: any other S3Client option (maxAttempts, endpoint for tests, ...).
export function createS3Client({ region, credentials, ...options } = {}) {
  if (!region) throw new StorageError('An S3 region is required.');
  return new S3Client({
    ...options,
    region,
    credentials,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export const isNotFound = (err) => ['NotFound', 'NoSuchKey', 'NoSuchBucket'].includes(err?.name) || err?.$metadata?.httpStatusCode === 404;

// Sends a command, rethrowing any failure as a StorageError named after the action.
export async function send(s3, command, action) {
  try {
    return await s3.send(command);
  } catch (err) {
    throw new StorageError(`S3 ${action} failed: ${err.message}`, { cause: err });
  }
}

// Like send, but resolves to fallback when S3 says the thing isn't there.
export async function sendOr(s3, command, action, fallback) {
  try {
    return await s3.send(command);
  } catch (err) {
    if (isNotFound(err)) return fallback;
    throw new StorageError(`S3 ${action} failed: ${err.message}`, { cause: err });
  }
}
