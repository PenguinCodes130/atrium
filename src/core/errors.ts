// Base errors. `message` is always safe to show a user and never contains a secret.
export class AtriumError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code: string = "bad_request",
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class Unauthorized extends AtriumError {
  constructor(message = "Sign in to continue.") {
    super(message, 401, "unauthorized");
  }
}

export class Forbidden extends AtriumError {
  constructor(message = "You do not have permission to do that.") {
    super(message, 403, "forbidden");
  }
}

export class NotFound extends AtriumError {
  constructor(message = "Not found.") {
    super(message, 404, "not_found");
  }
}

export class RateLimited extends AtriumError {
  constructor(readonly retryAfterSec: number) {
    super(`Too many attempts. Try again in ${Math.max(1, Math.ceil(retryAfterSec / 60))} minutes.`, 429, "rate_limited");
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AtriumError) {
    const headers: Record<string, string> = {};
    if (err instanceof RateLimited) headers["Retry-After"] = String(err.retryAfterSec);
    return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status, headers });
  }
  return Response.json({ error: { code: "internal", message: "Something went wrong." } }, { status: 500 });
}
