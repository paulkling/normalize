export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "payload_too_large"
  | "quota_exceeded"
  | "rate_limited"
  | "inference_failed"
  | "unavailable"
  | "timeout"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  payload_too_large: 413,
  quota_exceeded: 429,
  rate_limited: 429,
  inference_failed: 500,
  unavailable: 503,
  timeout: 504,
  internal: 500,
};

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  invalid_request: "The request is invalid.",
  unauthorized: "Missing or invalid API key.",
  forbidden: "This API key has been revoked.",
  not_found: "Not found.",
  payload_too_large: "Transcript exceeds the maximum length.",
  quota_exceeded: "Monthly request quota exhausted.",
  rate_limited: "Too many requests for this key.",
  inference_failed: "The model failed to process the request.",
  unavailable: "The model is not available right now.",
  timeout: "The model did not respond within the server budget.",
  internal: "Internal error.",
};

export interface ErrorExtras {
  reset_at?: string;
  retry_after_seconds?: number;
  details?: unknown;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extras: ErrorExtras;
  constructor(code: ErrorCode, message?: string, extras: ErrorExtras = {}) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.code = code;
    this.status = STATUS[code];
    this.extras = extras;
  }
}

export function errorBody(e: ApiError) {
  return {
    error: {
      code: e.code,
      message: e.message,
      ...(e.extras.reset_at !== undefined ? { reset_at: e.extras.reset_at } : {}),
      ...(e.extras.retry_after_seconds !== undefined ? { retry_after_seconds: e.extras.retry_after_seconds } : {}),
      ...(e.extras.details !== undefined ? { details: e.extras.details } : {}),
    },
  };
}
