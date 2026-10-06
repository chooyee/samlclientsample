// Presigned URLs: let a browser (or anyone holding the URL) read or write one object directly,
// for a limited time, without credentials.
import { PutObjectCommand, GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageError } from './errors.js';
import { contentDisposition } from './names.js';

export const DEFAULT_URL_TTL_SECONDS = 15 * 60;
const MAX_URL_TTL_SECONDS = 7 * 24 * 60 * 60; // SigV4's limit

export function presignOperations({ s3, bucket, urlTtlSeconds = DEFAULT_URL_TTL_SECONDS }) {
  // headers: the request headers bound into the signature. The client must send them unchanged.
  async function sign(command, expiresIn, headers = []) {
    const seconds = Math.min(Math.max(Math.trunc(expiresIn ?? urlTtlSeconds), 1), MAX_URL_TTL_SECONDS);
    try {
      const url = await getSignedUrl(s3, command, { expiresIn: seconds, signableHeaders: new Set(headers) });
      return { url, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
    } catch (err) {
      throw new StorageError(`Could not sign the S3 request: ${err.message}`, { cause: err });
    }
  }

  return {
    // A URL to PUT one object with. The size and type are signed: S3 refuses a body that differs.
    // Returns { url, method, headers, expiresAt }; the client sends exactly these headers.
    async presignPut({ key, contentType, contentLength, expiresIn }) {
      const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: contentLength });
      const signed = await sign(command, expiresIn, ['content-type', 'content-length']);
      return { ...signed, method: 'PUT', headers: contentType ? { 'Content-Type': contentType } : {} };
    },

    // A URL to GET one object. downloadName sets Content-Disposition (attachment unless inline).
    async presignGet({ key, expiresIn, downloadName, inline = false, contentType }) {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: downloadName ? contentDisposition(downloadName, { inline }) : undefined,
        ResponseContentType: contentType,
      });
      return { ...(await sign(command, expiresIn)), method: 'GET' };
    },

    // A URL to PUT one part of a multipart upload with. Its size is signed. The response's ETag
    // header identifies the part.
    async presignUploadPart({ key, uploadId, partNumber, contentLength, expiresIn }) {
      const command = new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: contentLength });
      return { ...(await sign(command, expiresIn, ['content-length'])), method: 'PUT', headers: {} };
    },
  };
}
