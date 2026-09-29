/**
 * Error codes shared by the Agent and the frontend. Names follow the PRD error
 * catalogue so both devices speak the same language.
 */
export const ErrorCode = {
  NODE_OFFLINE: 'NODE_OFFLINE',
  GPU_UNAVAILABLE: 'GPU_UNAVAILABLE',
  GPU_TOO_HOT: 'GPU_TOO_HOT',
  RENTAL_NOT_FOUND: 'RENTAL_NOT_FOUND',
  RENTAL_NOT_ACTIVE: 'RENTAL_NOT_ACTIVE',
  RENTAL_EXPIRED: 'RENTAL_EXPIRED',
  RESERVATION_NOT_READY: 'RESERVATION_NOT_READY',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  INVALID_SESSION: 'INVALID_SESSION',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED',
  CHALLENGE_NOT_FOUND: 'CHALLENGE_NOT_FOUND',
  CHALLENGE_MISMATCH: 'CHALLENGE_MISMATCH',
  RENTER_MISMATCH: 'RENTER_MISMATCH',
  NODE_MISMATCH: 'NODE_MISMATCH',
  AUDIENCE_MISMATCH: 'AUDIENCE_MISMATCH',
  SESSION_RENTER_MISMATCH: 'SESSION_RENTER_MISMATCH',
  EOA_REQUIRED: 'EOA_REQUIRED',
  CONFIG_UNAVAILABLE: 'CONFIG_UNAVAILABLE',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  CHALLENGE_REPLAYED: 'CHALLENGE_REPLAYED',
  MODEL_NOT_ALLOWED: 'MODEL_NOT_ALLOWED',
  ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
  RATE_LIMITED: 'RATE_LIMITED',
  CONCURRENCY_LIMIT: 'CONCURRENCY_LIMIT',
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',
  INFERENCE_FAILED: 'INFERENCE_FAILED',
  ABORTED_AT_EXPIRY: 'ABORTED_AT_EXPIRY',
  RPC_UNAVAILABLE: 'RPC_UNAVAILABLE',
  /** Body sent with a content type this API does not accept; 415. */
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  /** Body that claimed JSON but did not parse as a JSON object; 400. */
  INVALID_BODY: 'INVALID_BODY',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Single protocol catalogue. Messages intentionally contain no exception data. */
export const ERROR_CATALOG: Record<ErrorCodeValue, { status: number; message: string }> = {
  NODE_OFFLINE: { status: 503, message: 'Provider Agent is unavailable.' },
  GPU_UNAVAILABLE: { status: 503, message: 'Hardware is unavailable.' },
  GPU_TOO_HOT: { status: 503, message: 'Hardware is not ready.' },
  RENTAL_NOT_FOUND: { status: 404, message: 'Rental was not found.' },
  RENTAL_NOT_ACTIVE: { status: 409, message: 'Rental is not ACTIVE.' },
  RENTAL_EXPIRED: { status: 409, message: 'Rental has expired.' },
  RESERVATION_NOT_READY: { status: 409, message: 'Reservation is not ready.' },
  INVALID_SIGNATURE: { status: 401, message: 'Signature is invalid.' },
  INVALID_SESSION: { status: 401, message: 'Authenticate this rental first.' },
  SESSION_EXPIRED: { status: 409, message: 'Session has expired. Authenticate again.' },
  CHALLENGE_EXPIRED: { status: 408, message: 'Challenge has expired. Request another challenge.' },
  CHALLENGE_NOT_FOUND: { status: 404, message: 'Challenge was not found.' },
  CHALLENGE_REPLAYED: { status: 409, message: 'Challenge has already been used.' },
  CHALLENGE_MISMATCH: { status: 409, message: 'Challenge does not match the rental.' },
  RENTER_MISMATCH: { status: 409, message: 'Renter does not match the rental.' },
  NODE_MISMATCH: { status: 409, message: 'Rental belongs to another node.' },
  AUDIENCE_MISMATCH: { status: 409, message: 'Challenge belongs to another Agent audience.' },
  SESSION_RENTER_MISMATCH: { status: 409, message: 'Session renter does not match the rental.' },
  EOA_REQUIRED: { status: 409, message: 'An EOA renter is required.' },
  CONFIG_UNAVAILABLE: { status: 503, message: 'Deployment configuration is unavailable.' },
  DEPENDENCY_UNAVAILABLE: { status: 503, message: 'An Agent dependency is unavailable.' },
  MODEL_NOT_ALLOWED: { status: 403, message: 'Only the configured model is available.' },
  ORIGIN_NOT_ALLOWED: { status: 403, message: 'Browser origin is not allowed.' },
  RATE_LIMITED: { status: 429, message: 'Request quota or spacing limit reached.' },
  CONCURRENCY_LIMIT: { status: 429, message: 'One inference is already running. Wait or cancel it.' },
  BODY_TOO_LARGE: { status: 413, message: 'Request exceeds the allowed size.' },
  INFERENCE_FAILED: { status: 500, message: 'Generation failed or timed out.' },
  ABORTED_AT_EXPIRY: { status: 408, message: 'Generation stopped at rental expiry.' },
  RPC_UNAVAILABLE: { status: 503, message: 'Authoritative chain read is unavailable.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Request content type must be application/json.' },
  INVALID_BODY: { status: 400, message: 'Request body does not match the API schema.' },
  INTERNAL: { status: 500, message: 'An internal error occurred.' },
};

export function isErrorCode(code: unknown): code is ErrorCodeValue {
  return typeof code === 'string' && Object.hasOwn(ERROR_CATALOG, code);
}

export function protocolError(code: unknown): { status: number; body: { error: string; code: ErrorCodeValue } } {
  const canonical = isErrorCode(code) ? code : ErrorCode.INTERNAL;
  const entry = ERROR_CATALOG[canonical];
  return { status: entry.status, body: { error: entry.message, code: canonical } };
}

export class ArchcoreError extends Error {
  readonly code: ErrorCodeValue;
  readonly statusCode: number;

  constructor(
    code: ErrorCodeValue,
    message: string,
    statusCode = 400,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ArchcoreError';
    this.code = code;
    // Legacy callers cannot redefine protocol semantics with a local status.
    void statusCode;
    this.statusCode = ERROR_CATALOG[code].status;
  }
}

/** Safe, log-friendly shape. Never include prompts, tokens, or signatures. */
export function toSafeError(error: unknown): { code: string; message: string } {
  if (error instanceof ArchcoreError) {
    return { code: error.code, message: ERROR_CATALOG[error.code].message };
  }
  return { code: ErrorCode.INTERNAL, message: ERROR_CATALOG.INTERNAL.message };
}
