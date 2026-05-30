import type { Context } from "./deps.ts";

export type ErrorCode =
  | "unauthorized" | "forbidden" | "not_found" | "validation_failed"
  | "conflict" | "rate_limited" | "dependency_unavailable" | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401, forbidden: 403, not_found: 404, validation_failed: 422,
  conflict: 409, rate_limited: 429, dependency_unavailable: 503, internal: 500,
};

export class ApiError extends Error {
  code: ErrorCode;
  details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message); this.code = code; this.details = details;
  }
}

export function sendError(c: Context, err: unknown) {
  const requestId = c.get("requestId") ?? crypto.randomUUID();
  let code: ErrorCode = "internal";
  let message = "Internal error";
  let details: Record<string, unknown> | undefined;
  if (err instanceof ApiError) {
    code = err.code; message = err.message; details = err.details;
  } else if (err instanceof Error) {
    message = err.message;
  }
  const status = STATUS[code];
  console.error(JSON.stringify({ requestId, code, message, details }));
  return c.json({ error: { code, message, request_id: requestId, details } }, status);
}
