// What an upload may be: its size and content type. Checked before any URL is signed; the signed
// URL then binds the exact size and type, so S3 refuses a file that differs from what was declared.
import { UploadRejectedError } from './errors.js';
import { formatBytes } from './names.js';

export const S3_MAX_OBJECT_BYTES = 5 * 1024 ** 4; // 5 TiB, S3's limit for one object
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const MAX_FILENAME_CHARS = 255;
const TOKEN = "[a-z0-9!#$&^_.+'-]+";
const MIME = new RegExp(`^${TOKEN}/${TOKEN}$`);

// 'Image/PNG; charset=x' -> 'image/png'. Empty -> application/octet-stream. Anything that isn't a
// media type is refused: the value goes into a signed request header.
function normalizeType(value) {
  const type = String(value ?? '').split(';')[0].trim().toLowerCase();
  if (!type) return DEFAULT_CONTENT_TYPE;
  if (!MIME.test(type)) throw new UploadRejectedError('invalid_type', 'The file type is not a valid media type.');
  return type;
}

// allowedTypes: exact types ('application/pdf') or families ('image/*'). Empty allows any type.
export function defineUploadPolicy({ maxBytes = S3_MAX_OBJECT_BYTES, minBytes = 1, allowedTypes = [] } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > S3_MAX_OBJECT_BYTES) {
    throw new RangeError(`maxBytes must be between 1 and ${S3_MAX_OBJECT_BYTES}.`);
  }
  if (!Number.isSafeInteger(minBytes) || minBytes < 0 || minBytes > maxBytes) {
    throw new RangeError('minBytes must be between 0 and maxBytes.');
  }
  const patterns = Object.freeze(allowedTypes.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  const typeAllowed = (type) => !patterns.length
    || patterns.some((p) => p === type || (p.endsWith('/*') && type.startsWith(p.slice(0, -1))));

  return Object.freeze({
    maxBytes,
    minBytes,
    allowedTypes: patterns,

    // Returns the upload, normalized, or throws UploadRejectedError.
    check({ filename, contentType, size }) {
      const name = String(filename ?? '').trim();
      if (!name) throw new UploadRejectedError('missing_filename', 'The file has no name.');
      if (name.length > MAX_FILENAME_CHARS) throw new UploadRejectedError('filename_too_long', `File names are limited to ${MAX_FILENAME_CHARS} characters.`);
      if (!Number.isSafeInteger(size) || size < 0) throw new UploadRejectedError('invalid_size', 'The file size is missing or invalid.');
      if (size < minBytes) throw new UploadRejectedError(size ? 'too_small' : 'empty', size ? `Files must be at least ${formatBytes(minBytes)}.` : 'The file is empty.');
      if (size > maxBytes) throw new UploadRejectedError('too_large', `Files are limited to ${formatBytes(maxBytes)}.`);
      const type = normalizeType(contentType);
      if (!typeAllowed(type)) throw new UploadRejectedError('type_not_allowed', `Files of type ${type} are not accepted.`);
      return { filename: name, contentType: type, size };
    },
  });
}
