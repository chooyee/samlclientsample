// Customer documents: files a signed-in customer uploads, kept in S3. Two upload methods, side by
// side for comparison (both from factory/s3):
//
//   proxied    browser -> this app -> S3. The request body is streamed on to S3 as it arrives
//              (createStreamUploader): nothing touches the disk, every byte passes through here.
//   presigned  browser -> S3. This app signs URLs and checks the result (createPresignedUploader);
//              the bytes skip it. Needs the bucket's CORS (npm run s3:setup).
//
// This module decides who may do what and keeps the list of each customer's files in
// config.filesFile. S3 holds only the bytes. A presigned upload is 'uploading' from begin until S3
// confirms it, then 'ready'; a proxied one is recorded only once S3 holds all of it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { userKey } from './users.js';
import {
  createS3Storage, createStreamUploader, createPresignedUploader, defineUploadPolicy, objectKey, safeFilename,
  StorageError, UploadRejectedError,
} from './factory/s3/index.js';

export const METHODS = ['proxied', 'presigned'];
// Proxied uploads hold a connection and some memory each; presigned ones a record. Cap both.
const MAX_UPLOADS_PER_OWNER = { proxied: 3, presigned: 10 };
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_URL_TTL_SECONDS = 60; // the browser follows the redirect at once
const ID = /^[0-9a-f-]{36}$/;

// status: the HTTP status for the client.
export class FileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// The HTTP status for an error from this module, or null when it is a bug.
export function statusFor(err) {
  if (err instanceof FileError) return err.status;
  if (err instanceof UploadRejectedError) return err.code === 'too_large' ? 413 : 400;
  if (err instanceof StorageError) return 502;
  return null;
}

// ---------- storage ----------

const policy = defineUploadPolicy({ maxBytes: config.uploads.maxBytes, allowedTypes: config.uploads.allowedTypes });
let storage = null;
let uploaders = null; // { proxied, presigned }

// Tests pass their own storage; otherwise it is S3, when a bucket is set.
export function useStorage(next) {
  storage = next;
  uploaders = next && {
    proxied: createStreamUploader({ storage: next, policy }),
    presigned: createPresignedUploader({ storage: next, policy, urlTtlSeconds: config.s3.urlTtlSeconds }),
  };
}

if (config.s3.bucket) {
  useStorage(createS3Storage({ bucket: config.s3.bucket, region: config.s3.region, urlTtlSeconds: config.s3.urlTtlSeconds }));
}

export const isEnabled = () => Boolean(uploaders);

// What the page shows about the limits and the setup. Never credentials.
export const settingsView = () => ({
  enabled: isEnabled(),
  bucket: storage?.bucket ?? '',
  maxBytes: policy.maxBytes,
  allowedTypes: policy.allowedTypes,
});

function requireEnabled() {
  if (!uploaders) throw new FileError('Document uploads are not set up.', 503);
}

// ---------- records ----------

function load() {
  if (!fs.existsSync(config.filesFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(config.filesFile, 'utf8'));
  } catch (err) {
    console.warn(`Ignoring ${config.filesFile}: ${err.message}`);
    return {};
  }
}

let files = load();

function persist() {
  fs.mkdirSync(path.dirname(config.filesFile), { recursive: true });
  fs.writeFileSync(config.filesFile, `${JSON.stringify(files, null, 2)}\n`);
}

// Who owns a file: the same key as the local profile, and the legacy user id for legacy sign-ins.
const ownerOf = (user) => (user.protocol === 'legacy' ? `legacy|${user.id}` : userKey(user));

// Object keys carry no personal data: the owner appears as a hash.
const ownerHash = (owner) => crypto.createHash('sha256').update(owner).digest('hex').slice(0, 32);
const newKey = (owner, id, filename) => objectKey(config.s3.keyPrefix, 'documents', ownerHash(owner), id, safeFilename(filename));

// What the page and the client see: never the object key or the upload session.
const view = ({ id, name, contentType, size, method, uploadedAt }) => ({ id, name, contentType, size, method, uploadedAt });

// The user's file, or a 404: someone else's file looks the same as a missing one.
function ownFile(user, id, status = 'ready') {
  const file = ID.test(String(id)) ? files[id] : null;
  if (!file || file.owner !== ownerOf(user) || file.status !== status) throw new FileError('No such file.', 404);
  return file;
}

function ready(file, object) {
  Object.assign(file, { status: 'ready', size: object.size, contentType: object.contentType, uploadedAt: new Date().toISOString() });
  delete file.session;
  files[file.id] = file;
  persist();
  return view(file);
}

// Uploads in progress, per owner and method: proxied ones in memory (they live as long as their
// request), presigned ones from the records (they span several requests).
const proxiedActive = new Map();

function checkCapacity(owner, method) {
  const active = method === 'proxied'
    ? proxiedActive.get(owner) ?? 0
    : Object.values(files).filter((f) => f.owner === owner && f.status === 'uploading').length;
  const max = MAX_UPLOADS_PER_OWNER[method];
  if (active >= max) throw new FileError(`Up to ${max} ${method} uploads at a time. Wait for one to finish.`, 429);
}

// ---------- proxied: browser -> app -> S3 ----------

// Streams body (the request) to S3. file: { filename, contentType, size, body, signal }, where size
// is the request's Content-Length and signal aborts when the browser goes away. Returns the file.
export async function uploadProxied(user, { filename, contentType, size, body, signal }) {
  requireEnabled();
  const owner = ownerOf(user);
  checkCapacity(owner, 'proxied');
  const id = crypto.randomUUID();
  const key = newKey(owner, id, filename);
  proxiedActive.set(owner, (proxiedActive.get(owner) ?? 0) + 1);
  try {
    const object = await uploaders.proxied.receive({ key, filename, contentType, size, body, signal });
    return ready({ id, owner, name: String(filename).trim(), key, method: 'proxied' }, object);
  } finally {
    const left = proxiedActive.get(owner) - 1;
    if (left) proxiedActive.set(owner, left);
    else proxiedActive.delete(owner);
  }
}

// ---------- presigned: browser -> S3 ----------

// Aborts presigned uploads nobody finished. S3 calls are best effort: the record goes either way.
function pruneStale() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  const stale = Object.values(files).filter((f) => f.status === 'uploading' && Date.parse(f.createdAt) < cutoff);
  if (!stale.length) return;
  for (const f of stale) {
    delete files[f.id];
    uploaders.presigned.abort(f.session).catch((err) => console.warn(`Abandoned upload ${f.id} not aborted: ${err.message}`));
  }
  persist();
}

// input: { filename, contentType, size }. Returns { id, ...upload }, where upload is a presigned
// PUT ({ mode: 'single', url, headers }) or a multipart plan ({ mode: 'multipart', partSize, partCount }).
export async function startPresigned(user, input) {
  requireEnabled();
  pruneStale();
  const owner = ownerOf(user);
  checkCapacity(owner, 'presigned');
  const id = crypto.randomUUID();
  const { filename, contentType, size } = input ?? {};
  const key = newKey(owner, id, filename);
  const { session, upload } = await uploaders.presigned.begin({ key, filename, contentType, size });
  files[id] = {
    id, owner, name: String(filename).trim(), key, contentType: session.contentType, size: session.size,
    method: 'presigned', status: 'uploading', session, createdAt: new Date().toISOString(),
  };
  persist();
  return { id, ...upload };
}

// Presigned URLs for some parts of a multipart upload: [{ partNumber, url, method, headers, expiresAt }].
export async function signParts(user, id, partNumbers) {
  requireEnabled();
  return uploaders.presigned.signParts(ownFile(user, id, 'uploading').session, partNumbers);
}

// parts: [{ partNumber, etag }] for a multipart upload. Returns the file, now ready.
export async function completePresigned(user, id, parts) {
  requireEnabled();
  const file = ownFile(user, id, 'uploading');
  try {
    return ready(file, await uploaders.presigned.finish(file.session, { parts }));
  } catch (err) {
    // The object was removed: the upload can't be finished later, so forget it.
    if (err instanceof UploadRejectedError && err.code === 'size_mismatch') {
      delete files[id];
      persist();
    }
    throw err;
  }
}

export async function abortPresigned(user, id) {
  requireEnabled();
  const file = ownFile(user, id, 'uploading');
  delete files[id];
  persist();
  await uploaders.presigned.abort(file.session);
}

// ---------- files ----------

// The user's uploaded files, newest first.
export const listFiles = (user) => Object.values(files)
  .filter((f) => f.owner === ownerOf(user) && f.status === 'ready')
  .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
  .map(view);

// A short-lived URL that downloads the file from S3 under its original name.
export async function downloadUrl(user, id) {
  requireEnabled();
  const file = ownFile(user, id);
  const { url } = await storage.presignGet({ key: file.key, downloadName: file.name, contentType: file.contentType, expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  return url;
}

// Returns the deleted file.
export async function deleteFile(user, id) {
  requireEnabled();
  const file = ownFile(user, id);
  await storage.remove(file.key);
  delete files[id];
  persist();
  return view(file);
}
