// Server-side object operations: upload, download, list, copy, delete. For a browser to send or
// fetch an object itself, use presigned URLs (presign.js) instead: the bytes then skip the server.
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  HeadObjectCommand, GetObjectCommand, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { StorageError } from './errors.js';
import { send, sendOr } from './client.js';

const MAX_KEYS_PER_DELETE = 1000; // S3's limit for DeleteObjects

// The object's details, from a HeadObject or GetObject response.
const details = (key, r) => ({
  key,
  size: r.ContentLength,
  contentType: r.ContentType ?? null,
  etag: r.ETag ?? null,
  lastModified: r.LastModified ?? null,
  metadata: r.Metadata ?? {},
});

const listed = (o) => ({ key: o.Key, size: o.Size, etag: o.ETag ?? null, lastModified: o.LastModified ?? null });

// { start, end } (inclusive; end optional) -> 'bytes=start-end'.
const rangeHeader = (range) => (range ? `bytes=${range.start ?? 0}-${range.end ?? ''}` : undefined);

// CopySource is '<bucket>/<key>', URL-encoded, with the '/' in the key kept.
const copySource = (bucket, key) => `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

export function objectOperations({ s3, bucket }) {
  async function head(key) {
    const r = await sendOr(s3, new HeadObjectCommand({ Bucket: bucket, Key: key }), 'HeadObject', null);
    return r && details(key, r);
  }

  async function remove(key) {
    await send(s3, new DeleteObjectCommand({ Bucket: bucket, Key: key }), 'DeleteObject');
  }

  async function copy({ from, to, fromBucket = bucket }) {
    const r = await send(s3, new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: copySource(fromBucket, from) }), 'CopyObject');
    return { key: to, etag: r.CopyObjectResult?.ETag ?? null };
  }

  async function getObject(key, { range } = {}) {
    const r = await sendOr(s3, new GetObjectCommand({ Bucket: bucket, Key: key, Range: rangeHeader(range) }), 'GetObject', null);
    return r && { ...details(key, r), body: r.Body };
  }

  async function removeMany(keys) {
    const unique = [...new Set(keys)];
    let deleted = 0;
    const failed = [];
    for (let i = 0; i < unique.length; i += MAX_KEYS_PER_DELETE) {
      const batch = unique.slice(i, i + MAX_KEYS_PER_DELETE);
      const r = await send(s3, new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }), 'DeleteObjects');
      const errors = (r.Errors ?? []).map((e) => ({ key: e.Key, code: e.Code, message: e.Message }));
      failed.push(...errors);
      deleted += batch.length - errors.length;
    }
    return { deleted, failed };
  }

  async function list({ prefix, delimiter, maxKeys, cursor } = {}) {
    const r = await send(s3, new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, Delimiter: delimiter, MaxKeys: maxKeys, ContinuationToken: cursor,
    }), 'ListObjectsV2');
    return {
      objects: (r.Contents ?? []).map(listed),
      prefixes: (r.CommonPrefixes ?? []).map((p) => p.Prefix),
      cursor: r.IsTruncated ? r.NextContinuationToken : null,
    };
  }

  // Every object under the prefix, a page at a time behind the scenes.
  async function* listAll({ prefix } = {}) {
    let cursor;
    do {
      const page = await list({ prefix, cursor });
      yield* page.objects;
      cursor = page.cursor;
    } while (cursor);
  }

  return {
    // ---------- read ----------

    // { key, size, contentType, etag, lastModified, metadata }, or null when there is no such object.
    head,

    async exists(key) {
      return Boolean(await head(key));
    },

    // Download as a stream: { ...details, body } where body is a Node Readable. null when missing.
    // range: { start, end } for part of the object (bytes, inclusive).
    getObject,

    // Download into memory, as a Buffer. For small objects; stream large ones. null when missing.
    async getObjectBytes(key, options) {
      const object = await getObject(key, options);
      return object && Buffer.from(await object.body.transformToByteArray());
    },

    async getObjectText(key, { encoding = 'utf-8', ...options } = {}) {
      const object = await getObject(key, options);
      return object && object.body.transformToString(encoding);
    },

    // Download to a file, streamed. Returns the object's details, or null (no file) when missing.
    async downloadToFile(key, filePath, options) {
      const object = await getObject(key, options);
      if (!object) return null;
      const { body, ...rest } = object;
      try {
        await pipeline(body, fs.createWriteStream(filePath));
      } catch (err) {
        fs.rmSync(filePath, { force: true });
        throw new StorageError(`Downloading ${key} failed: ${err.message}`, { cause: err });
      }
      return rest;
    },

    // ---------- write ----------

    // Uploads from the server: body is a Buffer, string, Blob or Readable of any size, even unknown.
    // Large bodies go up in parts of partSize, queueSize at a time, without being held in memory.
    // onProgress({ loaded, total }); signal: an AbortSignal that cancels the upload.
    async upload({ key, body, contentType, metadata, cacheControl, partSize, queueSize, onProgress, signal }) {
      const upload = new Upload({
        client: s3,
        params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType, Metadata: metadata, CacheControl: cacheControl },
        partSize,
        queueSize,
        leavePartsOnError: false,
      });
      if (onProgress) upload.on('httpUploadProgress', (p) => onProgress({ loaded: p.loaded, total: p.total }));
      const cancel = () => upload.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        const r = await upload.done();
        return { key, etag: r.ETag ?? null };
      } catch (err) {
        throw new StorageError(`Uploading ${key} failed: ${err.message}`, { cause: err });
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },

    // Copies within the bucket, or from fromBucket. Keeps the object's type and metadata.
    copy,

    // S3 has no rename: copy, then delete the original.
    async move({ from, to }) {
      const copied = await copy({ from, to });
      await remove(from);
      return copied;
    },

    // ---------- delete ----------

    // Deleting a missing object succeeds, as in S3.
    remove,

    // Deletes up to any number of keys, 1,000 per request. Returns { deleted, failed: [{ key, code, message }] }.
    removeMany,

    // Deletes everything under the prefix. An empty prefix is refused: it would empty the bucket.
    async removePrefix(prefix) {
      if (!String(prefix ?? '').trim()) throw new StorageError('removePrefix needs a prefix.');
      const total = { deleted: 0, failed: [] };
      let batch = [];
      const flush = async () => {
        const r = await removeMany(batch);
        total.deleted += r.deleted;
        total.failed.push(...r.failed);
        batch = [];
      };
      for await (const object of listAll({ prefix })) {
        batch.push(object.key);
        if (batch.length === MAX_KEYS_PER_DELETE) await flush();
      }
      if (batch.length) await flush();
      return total;
    },

    // ---------- list ----------

    // One page: { objects: [{ key, size, etag, lastModified }], prefixes, cursor }. Pass cursor back
    // for the next page; null when there is none. delimiter '/' lists one "folder" level.
    list,
    listAll,
  };
}
