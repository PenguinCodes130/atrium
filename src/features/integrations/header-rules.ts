// Which headers count as credentials (architecture v2 section 3 amendment): a saved custom
// endpoint keeps only non-secret headers. Pure, shared by the server checks and the screens.

const CREDENTIAL_NAMES = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key", "apikey", "private-token"]);

export const CREDENTIAL_HEADER_HINT = "Paste the request as a curl command so Atrium keeps it as a secret field, or remove the header.";

/** True for Authorization, Cookie, X-API-Key, any name containing token, key, secret, password or auth, or a value that looks like one. */
export function isCredentialHeader(name: string, value = ""): boolean {
  const n = name.trim().toLowerCase();
  if (CREDENTIAL_NAMES.has(n)) return true;
  if (/(token|key|secret|passw|auth|session|credential|signature)/.test(n)) return true;
  if (/^\s*(bearer|basic|digest|token|pveapitoken)[\s=]/i.test(value)) return true;
  return false;
}
