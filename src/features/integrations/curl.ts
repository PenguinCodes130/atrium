// Parses a pasted curl command into a request (spec 3.5.1). Credentials found in it are
// split out into `secret` so the caller can seal them and never echo them back.
import type { AuthPlacement } from "@/core/contracts";
import { isCredentialHeader } from "./header-rules";

export type ParsedSecret = { key: string; label: string; hint: string; auth: AuthPlacement; value: string };
export type ParsedCurl = {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: string;
  verifyTls: boolean;
  /** Username for basic auth, a non-secret config value. */
  basicUser?: string;
  secrets: ParsedSecret[];
  /** The command with every credential replaced by a placeholder, safe to show. */
  redacted: string;
};

export class CurlParseError extends Error {}

export function tokenize(input: string): string[] {
  const s = input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ").trim();
  const out: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new CurlParseError("A quote is not closed.");
      cur += s.slice(i + 1, end);
      has = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && /["\\$`]/.test(s[i + 1]!)) { cur += s[i + 1]; i += 2; }
        else { cur += s[i]; i++; }
      }
      if (i >= s.length) throw new CurlParseError("A quote is not closed.");
      has = true;
      i++;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      has = true;
      i += 2;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

const SECRET_HEADERS = new Set(["x-api-key", "api-key", "apikey", "x-auth-token", "x-api-token", "private-token", "x-access-token"]);

export function parseCurl(input: string): ParsedCurl {
  const t = tokenize(input);
  if (t[0] !== "curl") throw new CurlParseError("That does not look like a curl command. It should start with curl.");
  let method: string | undefined;
  let url: string | undefined;
  let getMode = false;
  let verifyTls = true;
  let basicUser: string | undefined;
  const headers: Record<string, string> = {};
  const data: string[] = [];
  const secrets: ParsedSecret[] = [];
  const redacted: string[] = ["curl"];
  const take = (i: number) => {
    const v = t[i + 1];
    if (v === undefined) throw new CurlParseError(`${t[i]} needs a value.`);
    return v;
  };
  const q = (v: string) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
  for (let i = 1; i < t.length; i++) {
    const a = t[i]!;
    if (a === "-X" || a === "--request") { method = take(i).toUpperCase(); redacted.push(a, q(t[++i]!)); }
    else if (a.startsWith("-X") && a.length > 2) { method = a.slice(2).toUpperCase(); redacted.push(a); }
    else if (a === "-H" || a === "--header") {
      const h = take(i); i++;
      const idx = h.indexOf(":");
      if (idx <= 0) continue;
      const name = h.slice(0, idx).trim();
      const value = h.slice(idx + 1).trim();
      const lname = name.toLowerCase();
      if (lname === "authorization") {
        const bearer = /^bearer\s+(.+)$/i.exec(value);
        if (bearer) secrets.push({ key: "token", label: "Bearer token", hint: "The API token from the service's settings. Atrium sends it as a Bearer token.", auth: { as: "bearer" }, value: bearer[1]!.trim() });
        else secrets.push({ key: "authorization", label: "Authorization header", hint: "The full Authorization header value the service expects.", auth: { as: "header", name: "Authorization" }, value });
        redacted.push("-H", q(`${name}: <secret: ${secrets.at(-1)!.label}>`));
      } else if (SECRET_HEADERS.has(lname) || isCredentialHeader(lname, value)) {
        const key = lname.replace(/[^a-z0-9]+/g, "_");
        secrets.push({ key, label: name, hint: `The value for the ${name} header, from the service's settings.`, auth: { as: "header", name }, value });
        redacted.push("-H", q(`${name}: <secret: ${name}>`));
      } else {
        headers[name] = value;
        redacted.push("-H", q(h));
      }
    } else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--json"].includes(a)) {
      const d = take(i); i++;
      data.push(d);
      if (a === "--json") headers["Content-Type"] ??= "application/json";
      redacted.push(a, q(d));
    } else if (a === "--data-urlencode") {
      const d = take(i); i++;
      const eq = d.indexOf("=");
      data.push(eq >= 0 ? `${d.slice(0, eq)}=${encodeURIComponent(d.slice(eq + 1))}` : encodeURIComponent(d));
      redacted.push(a, q(d));
    } else if (a === "-G" || a === "--get") { getMode = true; redacted.push(a); }
    else if (a === "-k" || a === "--insecure") { verifyTls = false; redacted.push(a); }
    else if (a === "-u" || a === "--user") {
      const u = take(i); i++;
      const idx = u.indexOf(":");
      const user = idx >= 0 ? u.slice(0, idx) : u;
      const pass = idx >= 0 ? u.slice(idx + 1) : "";
      secrets.push({ key: "password", label: "Password", hint: `The password for ${user}.`, auth: { as: "basic", userKey: "username" }, value: pass });
      basicUser = user;
      redacted.push(a, q(`${user}:<secret: Password>`));
    } else if (a === "--url") { url = take(i); i++; redacted.push(a, q(url)); }
    else if (["-A", "--user-agent", "-e", "--referer", "-o", "--output", "-m", "--max-time", "--connect-timeout", "-w", "--write-out"].includes(a)) { i++; }
    else if (a.startsWith("-")) { /* flags such as -s, -L, -i, -v are ignored */ }
    else if (!url) { url = a; redacted.push(q(a)); }
  }
  if (!url) throw new CurlParseError("No URL was found in the curl command.");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new CurlParseError("The URL in the curl command is not valid."); }
  const m = (method ?? (data.length && !getMode ? "POST" : "GET")) as string;
  if (m !== "GET" && m !== "POST") throw new CurlParseError(`Atrium only reads data, so only GET and POST are allowed (this command uses ${m}).`);
  let body: string | undefined;
  if (data.length) {
    if (getMode || m === "GET") for (const pair of data.join("&").split("&")) { const [k, v = ""] = pair.split("="); if (k) parsed.searchParams.append(decodeURIComponent(k), decodeURIComponent(v)); }
    else body = data.join("&");
  }
  // Credentials in the URL itself (user:pass@ or ?token=...) are refused rather than kept.
  if (parsed.username || parsed.password) {
    secrets.push({ key: "password", label: "Password", hint: `The password for ${decodeURIComponent(parsed.username)}.`, auth: { as: "basic", userKey: "username" }, value: decodeURIComponent(parsed.password) });
    basicUser = decodeURIComponent(parsed.username);
    parsed.username = "";
    parsed.password = "";
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (/^(api[_-]?key|token|access[_-]?token|apikey|key)$/i.test(name)) {
      secrets.push({ key: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label: name, hint: `The value for the ${name} query parameter.`, auth: { as: "query", name }, value: parsed.searchParams.get(name) ?? "" });
      parsed.searchParams.delete(name);
    }
  }
  const query = Object.fromEntries(parsed.searchParams.entries());
  const base = new URL(parsed.toString());
  base.search = "";
  const safeUrl = parsed.toString();
  // Rebuild the redacted command's URL from the cleaned URL.
  const red = redacted.map((r) => (r === q(url!) ? q(safeUrl) : r));
  return { method: m, url: base.toString(), headers, query, ...(body !== undefined ? { body } : {}), verifyTls, ...(basicUser !== undefined ? { basicUser } : {}), secrets, redacted: red.join(" ") };
}
