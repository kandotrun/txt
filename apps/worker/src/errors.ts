/**
 * HTTP error shape (spec §12.2): `{"error":{"code":"...","message":"..."}}`.
 * Codes never include keys, plaintext, or stack traces.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST") =>
  new ApiError(400, code, message);
export const unauthorized = (message = "authentication required") =>
  new ApiError(401, "UNAUTHORIZED", message);
export const scopeRequired = (message = "insufficient scope") =>
  new ApiError(403, "SCOPE_REQUIRED", message);
export const notFound = (message = "not found") => new ApiError(404, "NOT_FOUND", message);
export const conflict = (message: string, code = "CONFLICT") =>
  new ApiError(409, code, message);
export const preconditionFailed = (message = "stale ETag") =>
  new ApiError(412, "PRECONDITION_FAILED", message);
export const payloadTooLarge = (message = "payload too large") =>
  new ApiError(413, "PAYLOAD_TOO_LARGE", message);
export const rangeNotSatisfiable = (message = "range not satisfiable") =>
  new ApiError(416, "RANGE_NOT_SATISFIABLE", message);
export const unprocessable = (message: string, code = "UNPROCESSABLE") =>
  new ApiError(422, code, message);
export const preconditionRequired = (message = "precondition required") =>
  new ApiError(428, "PRECONDITION_REQUIRED", message);
export const tooManyRequests = (message = "rate limited") =>
  new ApiError(429, "TOO_MANY_REQUESTS", message);
export const serviceUnavailable = (message = "temporarily unavailable") =>
  new ApiError(503, "SERVICE_UNAVAILABLE", message);
