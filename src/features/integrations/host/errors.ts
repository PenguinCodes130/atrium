import type { AdapterError } from "@/core/contracts";

/** Thrown inside the host boundary and by adapters; carries a safe AdapterError. */
export class HostError extends Error {
  constructor(readonly adapterError: AdapterError) {
    super(adapterError.message);
    this.name = "HostError";
  }
}

export const BLOCKED_ADDRESS_MESSAGE = "This integration is not allowed to reach that address";
export const SECRETS_LOCKED_MESSAGE = "Secrets locked: the master key is missing or wrong";
export const DOCKER_SOCKET_MESSAGE =
  "The raw Docker socket gives root access to this host. Use a read-only socket proxy, or set the allow-socket switch on the server";

export function hostError(code: AdapterError["code"], message: string, hint?: string, retryAfterSec?: number): HostError {
  return new HostError({ code, message, ...(hint ? { hint } : {}), ...(retryAfterSec ? { retryAfterSec } : {}) });
}

const TLS_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

function codeOf(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string" && c !== "UND_ERR_SOCKET") return c;
    e = (e as { cause?: unknown }).cause;
  }
  return typeof (err as { code?: unknown })?.code === "string" ? ((err as { code: string }).code) : undefined;
}

/** Maps a low-level network error to a friendly AdapterError. Never includes request details. */
export function toAdapterError(err: unknown, timedOut: boolean, timeoutMs: number): AdapterError {
  if (err instanceof HostError) return err.adapterError;
  if (timedOut) {
    return { code: "timeout", message: `The service did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, hint: "Check the service is running and the address and port are right." };
  }
  const code = codeOf(err);
  if (code && TLS_CODES.has(code)) {
    return {
      code: "tls",
      message: "The service's certificate could not be verified.",
      hint: "If this is a self-signed certificate on your LAN, turn off \"Verify TLS\" for this integration.",
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { code: "unreachable", message: "That host name could not be found.", hint: "Check the address for typos, or use the IP address." };
  }
  if (code === "ECONNREFUSED") {
    return { code: "unreachable", message: "The host refused the connection.", hint: "Check the port number and that the service is running." };
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return { code: "unreachable", message: "The host could not be reached.", hint: "Check the address and that Atrium's server can reach that network." };
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE" || code === "UND_ERR_CLOSED") {
    return { code: "unreachable", message: "The connection was closed before the service answered.", hint: "Check the scheme (http or https) and the port." };
  }
  if (code === "ENOENT" || code === "EACCES") {
    return { code: "unreachable", message: "The socket could not be opened.", hint: "Check the socket path and its permissions." };
  }
  return { code: "unreachable", message: "The service could not be reached.", hint: "Check the address, port and scheme." };
}

/**
 * The remote service's own reason for an error answer, cut to 200 characters: the `error`,
 * `message`, `detail` or `reason` field of a JSON body, or a short plain-text body. The body has
 * already been scrubbed of secrets by the host boundary. Returns undefined when there is none.
 */
export function serviceSaid(body: string, contentType = ""): string | undefined {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
  const t = body.trim();
  if (!t) return undefined;
  if (/json/i.test(contentType) || /^[{[]/.test(t)) {
    try {
      const j = JSON.parse(t) as unknown;
      const pick = (v: unknown, depth = 0): string | undefined => {
        if (typeof v === "string") return v;
        if (!v || typeof v !== "object" || depth > 2) return undefined;
        if (Array.isArray(v)) return pick(v[0], depth + 1);
        const o = v as Record<string, unknown>;
        for (const k of ["reason", "error_description", "message", "error", "detail", "errors", "title", "msg"]) {
          const got = pick(o[k], depth + 1);
          if (got) return got;
        }
        return undefined;
      };
      const r = pick(j);
      return r ? clean(r) : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^text\/plain/i.test(contentType) && t.length <= 400) return clean(t);
  return undefined;
}

/** Maps an HTTP status from a remote service to an AdapterError, or null when it is fine. */
export function statusError(status: number, opts: { secretLabel?: string; retryAfter?: string | undefined; said?: string | undefined } = {}): AdapterError | null {
  if (status === 401 || status === 403) {
    const field = opts.secretLabel ? `the "${opts.secretLabel}" field` : "the credentials";
    return {
      code: "auth",
      message: `The service refused ${field} (HTTP ${status}).`,
      hint: opts.secretLabel ? `Check ${opts.secretLabel} is correct, not expired, and has read access.` : "Check the credentials and their permissions.",
    };
  }
  if (status === 429) {
    const retry = Number(opts.retryAfter);
    return { code: "rate_limited", message: "The service is limiting requests right now.", hint: "Atrium will back off and try again.", ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSec: retry } : {}) };
  }
  if (status === 404) return { code: "bad_response", message: "The service answered, but that path does not exist (HTTP 404).", hint: "Check the base URL, including any path prefix." };
  if (status >= 400) {
    return {
      code: "bad_response",
      message: `The service answered with an error (HTTP ${status}).`,
      hint: opts.said ? `The service said: "${opts.said}"` : status >= 500 ? "Check the service's own logs." : "Check the address and its parameters.",
    };
  }
  return null;
}

export const ERROR_HEADINGS: Record<AdapterError["code"], string> = {
  auth: "Wrong credentials",
  unreachable: "Cannot reach host",
  timeout: "Timed out",
  tls: "Certificate problem",
  bad_response: "Unexpected response",
  rate_limited: "Rate limited",
  config: "Config problem",
  permission: "Not permitted",
};
