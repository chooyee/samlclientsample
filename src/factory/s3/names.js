// Object keys, file names and download headers: safe for S3 keys, URLs and Content-Disposition.

const MAX_FILENAME_LENGTH = 120;
const MAX_EXTENSION_LENGTH = 16;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// A file name reduced to letters, digits, '.', '-' and '_', for use inside an object key.
// The extension survives trimming. The original name belongs in your own records.
export function safeFilename(name, fallback = 'file') {
  const base = String(name ?? '')
    .split(/[\\/]/).pop()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // é -> e
    .replace(/\s+/g, '-')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_{2,}/g, '_');
  // Nothing left but an extension ('报告.pdf' -> '_.pdf'): keep the extension on the fallback.
  const onlyExt = base.match(/^[_-]+(\.[\w-]+)$/);
  if (onlyExt && onlyExt[1].length <= MAX_EXTENSION_LENGTH) return fallback + onlyExt[1];
  const trimmed = base.replace(/^[._-]+/, ''); // no hidden files, no '..'
  if (!trimmed) return fallback;
  if (trimmed.length <= MAX_FILENAME_LENGTH) return trimmed;
  const dot = trimmed.lastIndexOf('.');
  const ext = dot > 0 && trimmed.length - dot <= MAX_EXTENSION_LENGTH ? trimmed.slice(dot) : '';
  return trimmed.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
}

// Joins key segments with '/', dropping empty, '.' and '..' segments.
// e.g. objectKey('uploads/', userId, fileId, safeFilename(name))
export function objectKey(...segments) {
  return segments
    .flatMap((s) => String(s ?? '').split('/'))
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

// RFC 5987: percent-encoding for filename*, which encodeURIComponent leaves a few characters out of.
const encodeRfc5987 = (v) => encodeURIComponent(v).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// A Content-Disposition value (RFC 6266) that keeps a non-ASCII name intact in modern browsers,
// with an ASCII fallback for the rest.
export function contentDisposition(filename, { inline = false } = {}) {
  const name = String(filename ?? '').replace(CONTROL_CHARS, '').trim() || 'download';
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

// 1536 -> '1.5 KB'. For messages and pages.
export function formatBytes(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit ? `${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, '')} ${units[unit]}` : `${value} ${value === 1 ? 'byte' : 'bytes'}`;
}
