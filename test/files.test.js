// Customer documents and the S3 factory (factory/s3), against a fake S3 endpoint: the real AWS SDK
// and presigner, with the uploads a browser would make sent through fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testsp-files-'));
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.FILES_FILE = path.join(tmp, 'files.json');
process.env.UPLOAD_MAX_BYTES = String(1024 * 1024);
process.env.AWS_S3_BUCKET = ''; // the tests give files.js its storage

const s3 = await import('../src/factory/s3/index.js');
const files = await import('../src/files.js');

// ---------- fake S3 (path-style: /<bucket>/<key>) ----------

const objects = new Map(); // key -> { body, contentType }
const multipart = new Map(); // uploadId -> { key, contentType, parts: Map(partNumber -> body) }
const requests = [];
const etagOf = (body) => `"${crypto.createHash('md5').update(body).digest('hex')}"`;
const xml = (res, status, body) => res.writeHead(status, { 'content-type': 'application/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
const s3Error = (res, status, code) => xml(res, status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
const escXml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LAST_MODIFIED = '2026-01-01T00:00:00.000Z';
const bucketConfig = { cors: null, lifecycle: null };

// ListObjectsV2, with prefix, delimiter and pages (the token is the index of the next key).
function listObjects(res, q) {
  const prefix = q.get('prefix') ?? '';
  const delimiter = q.get('delimiter');
  const maxKeys = Number(q.get('max-keys') ?? 1000);
  const start = Number(q.get('continuation-token') ?? 0);
  const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  const prefixes = new Set();
  const contents = [];
  for (const k of keys) {
    const cut = delimiter ? k.indexOf(delimiter, prefix.length) : -1;
    if (cut >= 0) prefixes.add(k.slice(0, cut + 1));
    else contents.push(k);
  }
  const page = contents.slice(start, start + maxKeys);
  const truncated = start + maxKeys < contents.length;
  return xml(res, 200, `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + maxKeys}</NextContinuationToken>` : ''}${
    page.map((k) => `<Contents><Key>${escXml(k)}</Key><Size>${objects.get(k).body.length}</Size><ETag>${escXml(etagOf(objects.get(k).body))}</ETag><LastModified>${LAST_MODIFIED}</LastModified></Contents>`).join('')}${
    [...prefixes].map((p) => `<CommonPrefixes><Prefix>${escXml(p)}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`);
}

// Requests on the bucket itself (or, for ListBuckets, on the service).
function bucketRequest(req, res, name, q, body) {
  if (!name) return xml(res, 200, `<ListAllMyBucketsResult><Buckets><Bucket><Name>b</Name><CreationDate>${LAST_MODIFIED}</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>`);
  if (name !== 'b') return req.method === 'HEAD' ? res.writeHead(404).end() : s3Error(res, 404, 'NoSuchBucket');
  if (req.method === 'HEAD') return res.writeHead(200, { 'x-amz-bucket-region': 'us-east-1' }).end();
  for (const setting of ['cors', 'lifecycle']) {
    if (!q.has(setting)) continue;
    if (req.method === 'PUT') bucketConfig[setting] = body.toString();
    if (req.method === 'DELETE') bucketConfig[setting] = null;
    if (req.method !== 'GET') return res.writeHead(req.method === 'DELETE' ? 204 : 200).end();
    if (!bucketConfig[setting]) return s3Error(res, 404, setting === 'cors' ? 'NoSuchCORSConfiguration' : 'NoSuchLifecycleConfiguration');
    return xml(res, 200, bucketConfig[setting].replace(/^<\?xml[^>]*>/, ''));
  }
  if (q.has('delete')) {
    for (const [, k] of body.toString().matchAll(/<Key>(.*?)<\/Key>/g)) objects.delete(k.replace(/&amp;/g, '&'));
    return xml(res, 200, '<DeleteResult></DeleteResult>');
  }
  if (q.has('uploads')) {
    return xml(res, 200, `<ListMultipartUploadsResult>${[...multipart].filter(([, u]) => u.key.startsWith(q.get('prefix') ?? ''))
      .map(([id, u]) => `<Upload><Key>${escXml(u.key)}</Key><UploadId>${id}</UploadId><Initiated>${LAST_MODIFIED}</Initiated></Upload>`).join('')}</ListMultipartUploadsResult>`);
  }
  if (q.get('list-type') === '2') return listObjects(res, q);
  return s3Error(res, 400, 'NotImplemented');
}

const fakeS3 = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://s3');
    const [, bucketName, ...keyPath] = url.pathname.split('/');
    const key = decodeURIComponent(keyPath.join('/'));
    const q = url.searchParams;
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method, url, headers: req.headers });
    if (!key) return bucketRequest(req, res, bucketName, q, body);
    if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
      const from = decodeURIComponent(req.headers['x-amz-copy-source'].replace(/^\/?b\//, ''));
      if (!objects.has(from)) return s3Error(res, 404, 'NoSuchKey');
      objects.set(key, { ...objects.get(from) });
      return xml(res, 200, `<CopyObjectResult><ETag>${escXml(etagOf(objects.get(key).body))}</ETag><LastModified>${LAST_MODIFIED}</LastModified></CopyObjectResult>`);
    }

    if (req.method === 'POST' && q.has('uploads')) {
      const uploadId = crypto.randomUUID();
      multipart.set(uploadId, { key, contentType: req.headers['content-type'], parts: new Map() });
      return xml(res, 200, `<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (q.has('uploadId')) {
      const upload = multipart.get(q.get('uploadId'));
      if (!upload) return s3Error(res, 404, 'NoSuchUpload');
      if (req.method === 'PUT') {
        upload.parts.set(Number(q.get('partNumber')), body);
        return res.writeHead(200, { etag: etagOf(body) }).end();
      }
      if (req.method === 'DELETE') {
        multipart.delete(q.get('uploadId'));
        return res.writeHead(204).end();
      }
      const listed = [...body.toString().matchAll(/<Part>(.*?)<\/Part>/gs)].map(([, part]) => [
        Number(part.match(/<PartNumber>(\d+)<\/PartNumber>/)[1]),
        part.match(/<ETag>(.*?)<\/ETag>/)[1].replace(/&quot;/g, '"'),
      ]);
      if (listed.length !== upload.parts.size || listed.some(([n, e]) => !upload.parts.has(n) || etagOf(upload.parts.get(n)) !== e)) return s3Error(res, 400, 'InvalidPart');
      objects.set(upload.key, { body: Buffer.concat(listed.map(([n]) => upload.parts.get(n))), contentType: upload.contentType });
      multipart.delete(q.get('uploadId'));
      return xml(res, 200, `<CompleteMultipartUploadResult><Key>${upload.key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`);
    }
    if (req.method === 'PUT') {
      objects.set(key, { body, contentType: req.headers['content-type'] });
      return res.writeHead(200, { etag: etagOf(body) }).end();
    }
    const object = objects.get(key);
    if (req.method === 'DELETE') {
      objects.delete(key);
      return res.writeHead(204).end();
    }
    if (!object) return req.method === 'HEAD' ? res.writeHead(404).end() : s3Error(res, 404, 'NoSuchKey');
    const headers = { 'content-length': object.body.length, 'content-type': object.contentType, etag: etagOf(object.body) };
    if (req.method === 'HEAD') return res.writeHead(200, headers).end();
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const end = range[2] ? Number(range[2]) : object.body.length - 1;
      const part = object.body.subarray(Number(range[1]), end + 1);
      return res.writeHead(206, { ...headers, 'content-length': part.length, 'content-range': `bytes ${range[1]}-${end}/${object.body.length}` }).end(part);
    }
    res.writeHead(200, { ...headers, 'content-disposition': q.get('response-content-disposition') ?? '' }).end(object.body);
  });
});

let storage;

before(async () => {
  await new Promise((resolve) => fakeS3.listen(0, '127.0.0.1', resolve));
  const client = s3.createS3Client({
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${fakeS3.address().port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' },
  });
  storage = s3.createS3Storage({ bucket: 'b', client });
  files.useStorage(storage);
});

after(() => {
  fakeS3.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// What the browser does with a presigned URL.
async function browserPut(target, body) {
  const res = await fetch(target.url, { method: target.method, headers: target.headers, body });
  assert.equal(res.status, 200);
  return res.headers.get('etag');
}

const MiB = 1024 ** 2;

// ---------- factory: names and policy ----------

test('safeFilename keeps keys tidy and objectKey drops traversal', () => {
  assert.equal(s3.safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(s3.safeFilename('Résumé final (v2).pdf'), 'Resume-final-_v2_.pdf');
  assert.equal(s3.safeFilename('.env'), 'env');
  assert.equal(s3.safeFilename('报告.pdf'), 'file.pdf');
  assert.equal(s3.safeFilename(''), 'file');
  assert.ok(s3.safeFilename(`${'a'.repeat(300)}.pdf`).endsWith('.pdf'));
  assert.equal(s3.objectKey('prefix/', '..', 'a', '', './b', 'c.txt'), 'prefix/a/b/c.txt');
});

test('contentDisposition keeps a non-ASCII name and has an ASCII fallback', () => {
  assert.equal(s3.contentDisposition('报告 "1".pdf'), 'attachment; filename="__ _1_.pdf"; filename*=UTF-8\'\'%E6%8A%A5%E5%91%8A%20%221%22.pdf');
  assert.match(s3.contentDisposition('a.png', { inline: true }), /^inline; /);
});

test('the upload policy checks size and type', () => {
  const policy = s3.defineUploadPolicy({ maxBytes: 100, allowedTypes: ['image/*', 'application/pdf'] });
  assert.deepEqual(policy.check({ filename: ' a.png ', contentType: 'IMAGE/PNG; x=y', size: 5 }), { filename: 'a.png', contentType: 'image/png', size: 5 });
  const rejects = (file, code) => assert.throws(() => policy.check(file), (err) => err instanceof s3.UploadRejectedError && err.code === code);
  rejects({ filename: 'a.pdf', contentType: 'application/pdf', size: 101 }, 'too_large');
  rejects({ filename: 'a.pdf', contentType: 'application/pdf', size: 0 }, 'empty');
  rejects({ filename: 'a.pdf', contentType: 'application/pdf', size: '5' }, 'invalid_size');
  rejects({ filename: 'a.zip', contentType: 'application/zip', size: 5 }, 'type_not_allowed');
  rejects({ filename: 'a.bin', contentType: 'text/html\r\nx: y', size: 5 }, 'invalid_type');
  rejects({ filename: '', size: 5 }, 'missing_filename');
  assert.equal(s3.defineUploadPolicy().check({ filename: 'x', size: 1 }).contentType, 'application/octet-stream');
});

// ---------- factory: storage and the presigned uploader ----------

test('a presigned PUT binds size and type, and carries no checksum', async () => {
  const put = await storage.presignPut({ key: 'k/a.txt', contentType: 'text/plain', contentLength: 5 });
  const url = new URL(put.url);
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host');
  assert.ok(![...url.searchParams.keys()].some((k) => k.startsWith('x-amz-checksum') || k === 'x-amz-sdk-checksum-algorithm'));
  assert.deepEqual(put.headers, { 'Content-Type': 'text/plain' });
  assert.ok(Date.parse(put.expiresAt) > Date.now());
});

test('small files: one presigned PUT, then finish checks the object', async () => {
  const uploader = s3.createPresignedUploader({ storage });
  const { session, upload } = await uploader.begin({ key: 'single/a.txt', filename: 'a.txt', contentType: 'text/plain', size: 5 });
  assert.equal(upload.mode, 'single');
  assert.equal(upload.method, 'PUT');
  await assert.rejects(uploader.finish(session), { code: 'not_uploaded' });
  await browserPut(upload, 'hello');
  const object = await uploader.finish(session);
  assert.deepEqual({ key: object.key, size: object.size, contentType: object.contentType }, { key: 'single/a.txt', size: 5, contentType: 'text/plain' });
});

test('finish deletes an object of the wrong size', async () => {
  const uploader = s3.createPresignedUploader({ storage });
  const { session, upload } = await uploader.begin({ key: 'single/short.txt', filename: 'short.txt', size: 10 });
  await browserPut(upload, 'short'); // real S3 refuses this already: the length is signed
  await assert.rejects(uploader.finish(session), { code: 'size_mismatch' });
  assert.equal(await storage.head('single/short.txt'), null);
});

test('large files: multipart, each part signed with its own size', async () => {
  const uploader = s3.createPresignedUploader({ storage, multipartThreshold: 6 * MiB, partSize: 5 * MiB });
  const data = crypto.randomBytes(12 * MiB + 7);
  const { session, upload } = await uploader.begin({ key: 'multi/big.bin', filename: 'big.bin', contentType: 'application/octet-stream', size: data.length });
  assert.deepEqual({ mode: upload.mode, partSize: upload.partSize, partCount: upload.partCount }, { mode: 'multipart', partSize: 5 * MiB, partCount: 3 });

  await assert.rejects(uploader.signParts(session, [0]), { code: 'invalid_parts' });
  await assert.rejects(uploader.signParts(session, [4]), { code: 'invalid_parts' });
  const signed = await uploader.signParts(session, [3, 1, 2]);
  assert.deepEqual(signed.map((p) => p.partNumber), [3, 1, 2]);
  assert.equal(new URL(signed[0].url).searchParams.get('X-Amz-SignedHeaders'), 'content-length;host');

  const parts = await Promise.all(signed.map(async (p) => ({
    partNumber: p.partNumber,
    etag: await browserPut(p, data.subarray((p.partNumber - 1) * 5 * MiB, p.partNumber * 5 * MiB)),
  })));
  await assert.rejects(uploader.finish(session, { parts: parts.slice(1) }), { code: 'invalid_parts' });
  await assert.rejects(uploader.finish(session, { parts: parts.map((p) => ({ ...p, etag: '"wrong"' })) }), { code: 'incomplete_upload' });
  const object = await uploader.finish(session, { parts });
  assert.equal(object.size, data.length);
  assert.ok(objects.get('multi/big.bin').body.equals(data));
});

test('part size grows to stay within 10,000 parts', async () => {
  const fake = { createMultipartUpload: async () => ({ uploadId: 'u' }) };
  const uploader = s3.createPresignedUploader({ storage: fake, partSize: 5 * MiB });
  const { upload } = await uploader.begin({ key: 'k', filename: 'huge', size: 100 * 1024 ** 3 });
  assert.ok(upload.partCount <= 10_000);
  assert.equal(upload.partSize % MiB, 0);
});

test('abort frees a multipart upload', async () => {
  const uploader = s3.createPresignedUploader({ storage, multipartThreshold: 0 });
  const { session } = await uploader.begin({ key: 'multi/gone.bin', filename: 'gone.bin', size: 10 });
  assert.ok(multipart.has(session.uploadId));
  await uploader.abort(session);
  assert.ok(!multipart.has(session.uploadId));
  await uploader.abort(session); // already gone: still fine
});

test('S3 failures are StorageErrors', async () => {
  const broken = s3.createS3Storage({
    bucket: 'b',
    client: s3.createS3Client({ region: 'us-east-1', endpoint: 'http://127.0.0.1:1', forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: 'a', secretAccessKey: 'b' } }),
  });
  await assert.rejects(broken.remove('x'), s3.StorageError);
});

// ---------- factory: the stream uploader (proxied) ----------

const { Readable } = await import('node:stream');
// A request-like body: the data in 1 MiB chunks.
const bodyOf = (data) => Readable.from((function* chunks() { for (let i = 0; i < data.length; i += MiB) yield data.subarray(i, i + MiB); })());

test('stream uploader: small and large bodies reach S3 whole', async () => {
  const uploader = s3.createStreamUploader({ storage });
  const small = await uploader.receive({ key: 'stream/a.txt', filename: 'a.txt', contentType: 'text/plain', size: 5, body: bodyOf(Buffer.from('hello')) });
  assert.deepEqual({ size: small.size, contentType: small.contentType }, { size: 5, contentType: 'text/plain' });

  const data = crypto.randomBytes(12 * MiB + 3);
  const before = requests.length;
  const big = await uploader.receive({ key: 'stream/big.bin', filename: 'big.bin', size: data.length, body: bodyOf(data) });
  assert.equal(big.size, data.length);
  assert.ok(objects.get('stream/big.bin').body.equals(data));
  assert.ok(requests.slice(before).some((r) => r.url.searchParams.has('partNumber')), 'went up in parts');
});

test('stream uploader: refuses before reading, and when the body is not the declared size', async () => {
  const uploader = s3.createStreamUploader({ storage, policy: s3.defineUploadPolicy({ maxBytes: 10 }) });
  let read = false;
  const untouched = new Readable({ read() { read = true; this.push(null); } });
  await assert.rejects(uploader.receive({ key: 'stream/x', filename: 'x', size: 11, body: untouched }), { code: 'too_large' });
  assert.equal(read, false, 'the policy is checked before the body is read');

  await assert.rejects(uploader.receive({ key: 'stream/long', filename: 'long', size: 3, body: bodyOf(Buffer.from('12345')) }), { code: 'size_mismatch' });
  await assert.rejects(uploader.receive({ key: 'stream/short', filename: 'short', size: 9, body: bodyOf(Buffer.from('12345')) }), { code: 'incomplete_upload' });
  assert.equal(await storage.exists('stream/long'), false);
  assert.equal(await storage.exists('stream/short'), false);
});

test('stream uploader: a cancelled upload leaves nothing in S3', async () => {
  const uploader = s3.createStreamUploader({ storage });
  const cancel = new AbortController();
  const body = new Readable({ read() {} }); // a client that sends a little, then stalls
  body.push(crypto.randomBytes(MiB));
  setTimeout(() => cancel.abort(), 50);
  await assert.rejects(uploader.receive({ key: 'stream/gone.bin', filename: 'gone.bin', size: 20 * MiB, body, signal: cancel.signal }), { code: 'cancelled' });
  assert.equal(await storage.exists('stream/gone.bin'), false);
  assert.deepEqual(await storage.listMultipartUploads({ prefix: 'stream/' }), []);
});

// ---------- factory: server-side objects and the bucket ----------

test('server-side upload and download: buffer, text, range, stream to file', async () => {
  await storage.upload({ key: 'ops/hello.txt', body: 'hello world', contentType: 'text/plain', metadata: { owner: 'test' } });
  assert.equal(await storage.exists('ops/hello.txt'), true);
  assert.equal(await storage.exists('ops/nope.txt'), false);
  assert.equal(await storage.getObjectText('ops/hello.txt'), 'hello world');
  assert.equal((await storage.getObjectBytes('ops/hello.txt', { range: { start: 6 } })).toString(), 'world');
  assert.equal(await storage.getObjectBytes('ops/nope.txt'), null);

  const object = await storage.getObject('ops/hello.txt', { range: { start: 0, end: 4 } });
  assert.equal(object.contentType, 'text/plain');
  assert.equal(Buffer.from(await object.body.transformToByteArray()).toString(), 'hello');

  const target = path.join(tmp, 'hello.txt');
  const saved = await storage.downloadToFile('ops/hello.txt', target);
  assert.equal(saved.size, 11);
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello world');
  assert.equal(await storage.downloadToFile('ops/nope.txt', path.join(tmp, 'nope.txt')), null);
  assert.ok(!fs.existsSync(path.join(tmp, 'nope.txt')));
});

test('server-side upload streams a large body of unknown length in parts', async () => {
  const { Readable } = await import('node:stream');
  const data = crypto.randomBytes(11 * MiB);
  const chunks = function* chunked() { for (let i = 0; i < data.length; i += MiB) yield data.subarray(i, i + MiB); };
  const progress = [];
  const before = requests.length;
  await storage.upload({ key: 'ops/stream.bin', body: Readable.from(chunks()), partSize: 5 * MiB, onProgress: (p) => progress.push(p.loaded) });
  assert.ok(objects.get('ops/stream.bin').body.equals(data));
  assert.ok(requests.slice(before).some((r) => r.url.searchParams.has('partNumber')), 'went up in parts');
  assert.ok(progress.length && progress.at(-1) === data.length);
});

test('list, listAll, copy, move, removeMany and removePrefix', async () => {
  for (const k of ['tree/a.txt', 'tree/b.txt', 'tree/sub/c.txt', 'tree/sub/d.txt']) await storage.upload({ key: k, body: k });

  const top = await storage.list({ prefix: 'tree/', delimiter: '/' });
  assert.deepEqual(top.objects.map((o) => o.key), ['tree/a.txt', 'tree/b.txt']);
  assert.deepEqual(top.prefixes, ['tree/sub/']);
  assert.equal(top.cursor, null);

  const first = await storage.list({ prefix: 'tree/', maxKeys: 3 });
  assert.equal(first.objects.length, 3);
  assert.ok(first.cursor);
  const all = [];
  for await (const o of storage.listAll({ prefix: 'tree/' })) all.push(o.key);
  assert.equal(all.length, 4);

  await storage.copy({ from: 'tree/a.txt', to: 'tree/copy of a.txt' });
  assert.equal(await storage.getObjectText('tree/copy of a.txt'), 'tree/a.txt');
  await storage.move({ from: 'tree/b.txt', to: 'tree/moved.txt' });
  assert.equal(await storage.exists('tree/b.txt'), false);
  assert.equal(await storage.getObjectText('tree/moved.txt'), 'tree/b.txt');

  assert.deepEqual(await storage.removeMany(['tree/a.txt', 'tree/a.txt', 'tree/moved.txt']), { deleted: 2, failed: [] });
  await assert.rejects(storage.removePrefix(''), s3.StorageError);
  assert.equal((await storage.removePrefix('tree/')).deleted, 3);
  assert.equal((await storage.list({ prefix: 'tree/' })).objects.length, 0);
});

test('bucket: details, buckets, CORS for browser uploads, lifecycle', async () => {
  assert.deepEqual(await storage.getBucket(), { name: 'b', region: 'us-east-1' });
  assert.equal(await s3.createS3Storage({ bucket: 'missing', client: storage.client }).getBucket(), null);
  assert.deepEqual((await s3.listBuckets(storage.client)).map((b) => b.name), ['b']);

  assert.deepEqual(await storage.getCors(), []);
  await storage.setCors([{ id: 'other', allowedOrigins: ['*'], allowedMethods: ['GET'] }]);
  const rules = await storage.allowBrowserUploads(['https://bank.example/some/page', 'https://bank.example']);
  assert.deepEqual(rules.map((r) => r.id), ['other', s3.BROWSER_UPLOADS_RULE_ID]);
  const upload = (await storage.getCors()).find((r) => r.id === s3.BROWSER_UPLOADS_RULE_ID);
  assert.deepEqual(upload.allowedOrigins, ['https://bank.example']);
  assert.deepEqual(upload.exposeHeaders, ['ETag']);
  await storage.allowBrowserUploads(['http://localhost:4000']); // replaces its own rule only
  assert.equal((await storage.getCors()).length, 2);
  await storage.setCors([]);
  assert.deepEqual(await storage.getCors(), []);

  await storage.abortIncompleteUploadsAfter(2, { prefix: 'testsp/' });
  assert.match(bucketConfig.lifecycle, /<DaysAfterInitiation>2<\/DaysAfterInitiation>/);
  await assert.rejects(storage.abortIncompleteUploadsAfter(0), RangeError);
});

test('unfinished multipart uploads can be listed', async () => {
  const { uploadId } = await storage.createMultipartUpload({ key: 'pending/x.bin' });
  assert.deepEqual((await storage.listMultipartUploads({ prefix: 'pending/' })).map((u) => u.uploadId), [uploadId]);
  await storage.abortMultipartUpload({ key: 'pending/x.bin', uploadId });
  assert.deepEqual(await storage.listMultipartUploads({ prefix: 'pending/' }), []);
});

// ---------- customer documents (files.js) ----------

const alice = { protocol: 'oidc', issuer: 'https://idp', subject: 'alice' };
const bob = { protocol: 'legacy', id: 'u-bob' };

test('presigned: a customer uploads, lists, downloads and deletes a document', async () => {
  const started = await files.startPresigned(alice, { filename: 'Statement März.pdf', contentType: 'application/pdf', size: 11 });
  assert.equal(started.mode, 'single');
  assert.equal(files.listFiles(alice).length, 0, 'not listed until complete');

  const key = new URL(started.url).pathname.split('/').slice(2).map(decodeURIComponent).join('/');
  assert.match(key, new RegExp(`^testsp/documents/[0-9a-f]{32}/${started.id}/Statement-Marz\\.pdf$`));
  assert.ok(!key.includes('alice'), 'no personal data in the key');

  await browserPut(started, 'hello world');
  const done = await files.completePresigned(alice, started.id);
  assert.deepEqual({ name: done.name, size: done.size, method: done.method }, { name: 'Statement März.pdf', size: 11, method: 'presigned' });
  assert.deepEqual(files.listFiles(alice).map((f) => f.id), [started.id]);
  assert.ok(!('key' in files.listFiles(alice)[0]) && !('session' in files.listFiles(alice)[0]));

  const res = await fetch(await files.downloadUrl(alice, started.id));
  assert.equal(await res.text(), 'hello world');
  assert.match(res.headers.get('content-disposition'), /^attachment; .*filename\*=UTF-8''Statement%20M%C3%A4rz\.pdf$/);

  await files.deleteFile(alice, started.id);
  assert.equal(files.listFiles(alice).length, 0);
  assert.equal(await storage.head(key), null);
});

test('customers only reach their own files', async () => {
  const started = await files.startPresigned(alice, { filename: 'mine.txt', size: 4 });
  await browserPut(started, 'mine');
  await files.completePresigned(alice, started.id);
  const notFound = { status: 404 };
  await assert.rejects(files.downloadUrl(bob, started.id), (err) => files.statusFor(err) === 404);
  await assert.rejects(files.deleteFile(bob, started.id), notFound);
  await assert.rejects(files.completePresigned(bob, started.id), notFound);
  await assert.rejects(files.downloadUrl(alice, '../etc'), notFound);
  assert.equal(files.listFiles(bob).length, 0);
});

test('presigned: bad uploads get a 4xx, and uploads in progress are limited', async () => {
  await assert.rejects(files.startPresigned(bob, { filename: 'big.bin', size: 2 * MiB }), (err) => files.statusFor(err) === 413 && /1 MB/.test(err.message));
  const started = [];
  for (let i = 0; i < 10; i++) started.push(await files.startPresigned(bob, { filename: `f${i}.txt`, size: 1 }));
  await assert.rejects(files.startPresigned(bob, { filename: 'one-more.txt', size: 1 }), { status: 429 });
  await files.abortPresigned(bob, started[0].id);
  await files.startPresigned(bob, { filename: 'now-ok.txt', size: 1 });
  await assert.rejects(files.completePresigned(bob, started[0].id), { status: 404 }); // aborted
});

test('proxied: a customer streams a document through the app', async () => {
  const data = Buffer.from('proxied bytes');
  const file = await files.uploadProxied(alice, { filename: 'Payslip.pdf', contentType: 'application/pdf', size: data.length, body: bodyOf(data) });
  assert.deepEqual({ name: file.name, size: file.size, method: file.method, contentType: file.contentType }, { name: 'Payslip.pdf', size: data.length, method: 'proxied', contentType: 'application/pdf' });
  assert.ok(files.listFiles(alice).some((f) => f.id === file.id && f.method === 'proxied'));
  assert.equal(await (await fetch(await files.downloadUrl(alice, file.id))).text(), 'proxied bytes');
  await assert.rejects(files.downloadUrl(bob, file.id), { status: 404 });
  await files.deleteFile(alice, file.id);
});

test('proxied: bad uploads get a 4xx and are not listed', async () => {
  await assert.rejects(files.uploadProxied(bob, { filename: 'big.bin', size: 2 * MiB, body: bodyOf(Buffer.alloc(1)) }), (err) => files.statusFor(err) === 413);
  await assert.rejects(files.uploadProxied(bob, { filename: 'liar.txt', size: 2, body: bodyOf(Buffer.from('12345')) }), (err) => files.statusFor(err) === 400);
  assert.ok(!files.listFiles(bob).some((f) => ['big.bin', 'liar.txt'].includes(f.name)));
});

test('proxied: at most 3 uploads at a time per customer', async () => {
  const stalled = Array.from({ length: 3 }, () => new Readable({ read() {} }));
  const cancel = new AbortController();
  const running = stalled.map((body, i) => files.uploadProxied(alice, { filename: `s${i}`, size: 10, body, signal: cancel.signal }).catch((err) => err));
  await assert.rejects(files.uploadProxied(alice, { filename: 'fourth', size: 1, body: bodyOf(Buffer.from('x')) }), { status: 429 });
  cancel.abort();
  for (const err of await Promise.all(running)) assert.equal(err.code, 'cancelled');
  const ok = await files.uploadProxied(alice, { filename: 'after', size: 1, body: bodyOf(Buffer.from('x')) });
  assert.equal(ok.method, 'proxied');
});

test('records survive a reload of the store file', () => {
  const saved = JSON.parse(fs.readFileSync(process.env.FILES_FILE, 'utf8'));
  assert.ok(Object.values(saved).some((f) => f.name === 'mine.txt' && f.status === 'ready' && !f.session));
});
