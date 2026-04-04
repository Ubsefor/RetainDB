export type RetainDBErrorCode =
  | "INVALID_API_KEY"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_AMBIGUOUS"
  | "RATE_LIMITED"
  | "TEMPORARY_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "REQUEST_FAILED"
  | "MISSING_PROJECT"
  | "AUTH_IDENTITY_REQUIRED"
  | "AUTH_IDENTITY_INVALID"
  | "MISCONFIGURED_IDENTITY_MODE"
  | "VALIDATION_ERROR";

// Deprecated alias
export type WhisperErrorCode = RetainDBErrorCode;

export class RetainDBError extends Error {
  code: RetainDBErrorCode;
  status?: number;
  retryable: boolean;
  hint?: string;
  requestId?: string;
  details?: unknown;

  constructor(args: {
    code: RetainDBErrorCode;
    message: string;
    status?: number;
    retryable?: boolean;
    hint?: string;
    requestId?: string;
    details?: unknown;
    cause?: unknown;
  }) {
    super(args.message, args.cause ? { cause: args.cause } : undefined);
    this.name = "RetainDBError";
    this.code = args.code;
    this.status = args.status;
    this.retryable = args.retryable ?? false;
    this.hint = args.hint;
    this.requestId = args.requestId;
    this.details = args.details;
  }
}

// Deprecated alias
export { RetainDBError as WhisperError };
