// Errors from the S3 factory. Callers map them to their own responses:
// UploadRejectedError is the uploader's fault (a 4xx), StorageError is S3's or the network's (a 5xx).

// S3 or the network failed. code: the S3 error name when there is one (e.g. 'NoSuchUpload').
export class StorageError extends Error {
  constructor(message, { cause, code } = {}) {
    super(message, { cause });
    this.name = 'StorageError';
    this.code = code ?? cause?.name ?? null;
  }
}

// The upload doesn't meet the policy, or the client did something out of order.
// code: a stable machine-readable reason, e.g. 'too_large', 'type_not_allowed', 'size_mismatch'.
export class UploadRejectedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UploadRejectedError';
    this.code = code;
  }
}
