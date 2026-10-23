// Writes a secret value into an outgoing request, scrubs secret values out of responses, and
// holds the header rules for requests a person shapes (Try it and custom endpoints).
// Values only ever pass through this folder (architecture v2 section 11).
import "server-only";
import type { AuthPlacement } from "@/core/contracts";
import { CREDENTIAL_HEADER_HINT, isCredentialHeader } from "../header-rules";

export { isCredentialHeader };

/**
 * Attaches one secret. Returns every form of the value that went on the wire (the raw value, and
 * composites such as the base64 `user:secret` of Basic auth), so the caller can scrub all of them.
 * Header placements also report the header name, so it counts as set by Atrium, not by a person.
 */
export function attachSecret(auth: AuthPlacement, value: string, headers: Record<string, string>, url: URL, config: Record<string, unknown>): { forms: string[]; header?: string } {
  if (auth.as === "bearer") {
    headers.authorization = `Bearer ${value}`;
    return { forms: [value, `Bearer ${value}`], header: "authorization" };
  }
  if (auth.as === "header") {
    headers[auth.name.toLowerCase()] = value;
    return { forms: [value], header: auth.name.toLowerCase() };
  }
  if (auth.as === "query") {
    url.searchParams.set(auth.name, value);
    return { forms: [value] };
  }
  if (auth.as === "proxmox-token") {
    headers.authorization = `PVEAPIToken=${value}`;
    return { forms: [value, `PVEAPIToken=${value}`], header: "authorization" };
  }
  const pair = `${String(config[auth.userKey] ?? "")}:${value}`;
  const b64 = Buffer.from(pair).toString("base64");
  headers.authorization = `Basic ${b64}`;
  return { forms: [value, pair, b64, `Basic ${b64}`], header: "authorization" };
}

/** Every encoding of one wire form that could come back in a response body. */
function encodings(v: string): string[] {
  const b64 = Buffer.from(v).toString("base64");
  return [v, encodeURIComponent(v), b64, b64.replace(/=+$/, ""), Buffer.from(v).toString("base64url"), JSON.stringify(v).slice(1, -1)];
}

/** Replaces every occurrence of the given secret forms (and their URL, base64 and JSON encodings) in a response body. */
export function scrubSecrets(body: Buffer, values: string[]): Buffer {
  const usable = values.filter((v) => v.length >= 4);
  if (usable.length === 0) return body;
  let text = body.toString("utf8");
  let changed = false;
  // Longest first, so a composite is replaced whole before its parts.
  const forms = [...new Set(usable.flatMap(encodings))].filter((f) => f.length >= 4).sort((a, b) => b.length - a.length);
  for (const form of forms) {
    if (text.includes(form)) {
      text = text.split(form).join("[secret]");
      changed = true;
    }
  }
  return changed ? Buffer.from(text, "utf8") : body;
}

export function scrubText(text: string, values: string[]): string {
  return scrubSecrets(Buffer.from(text, "utf8"), values).toString("utf8");
}

/** Headers Atrium sets itself or that change how the connection works; a person's value is dropped. */
export const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "expect", "proxy-connection"]);

/**
 * The only headers a person-shaped request may send to a loopback or private address, besides
 * the credential headers Atrium attaches. Everything else (including method-override headers)
 * could turn a read into a write on a homelab service.
 */
export const PRIVATE_SAFE_HEADERS = new Set(["accept", "accept-language", "cache-control", "pragma", "if-none-match", "if-modified-since", "user-agent"]);

export type HeaderCheck = { ok: true; headers: Record<string, string> } | { ok: false; name: string; message: string; hint: string };

/** Cleans a person's non-secret headers: drops connection headers, refuses anything that looks like a credential. */
export function checkUserHeaders(input: Record<string, string> | undefined): HeaderCheck {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const name = k.trim().toLowerCase();
    if (!name || FORBIDDEN_HEADERS.has(name)) continue;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) return { ok: false, name: k, message: `"${k}" is not a valid header name.`, hint: "Header names use letters, numbers and dashes." };
    if (/[\r\n]/.test(v)) return { ok: false, name: k, message: `The "${k}" header has a line break in it.`, hint: "Put the value on one line." };
    if (isCredentialHeader(name, v)) return { ok: false, name: k, message: `The "${k}" header looks like a credential, so Atrium will not keep it as a plain header.`, hint: CREDENTIAL_HEADER_HINT };
    headers[name] = v;
  }
  return { ok: true, headers };
}
