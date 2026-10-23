// integrations.search_docs: fetches one documentation or OpenAPI URL the agent supplies, under the
// detection address rules, and returns its title, text cut to 20 KB and any endpoints (section 9b).
import "server-only";
import type { EndpointSummary } from "@/core/contracts";
import { normalizeUrl } from "./detect";
import { HostError, statusError } from "./host/errors";
import { safeRequest } from "./host/request";
import { decodeEntities } from "@/packages/rss/parse";
import { isOpenApi, openApiTitle, parseOpenApi } from "./openapi";

export const DOCS_MAX_BYTES = 20 * 1024;

export function cutUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�+$/, "");
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const body = html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|pre|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body).replace(/[ \t\f\v\r]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  return { title, text };
}

export type DocsResult = { title: string; url: string; text: string; endpoints?: EndpointSummary[] };

export async function lookupDocs(input: string, signal?: AbortSignal): Promise<DocsResult> {
  const u = normalizeUrl(input);
  const res = await safeRequest({ url: u.toString(), method: "GET", redirect: { mode: "checked" }, verifyTls: true, ...(signal ? { signal } : {}), maxBytes: 3 * 1024 * 1024 });
  const err = statusError(res.status);
  if (err) throw new HostError(err);
  const raw = res.body.toString("utf8");
  const type = res.headers["content-type"] ?? "";
  if (type.includes("json") || /^\s*[[{]/.test(raw)) {
    try {
      const doc = JSON.parse(raw) as unknown;
      if (isOpenApi(doc)) {
        const endpoints = parseOpenApi(doc);
        const info = (doc.info ?? {}) as Record<string, unknown>;
        const text = [typeof info.description === "string" ? info.description : "", ...endpoints.map((e) => `${e.method} ${e.path}${e.summary ? `: ${e.summary}` : ""}`)].join("\n");
        return { title: openApiTitle(doc), url: res.url, text: cutUtf8(text, DOCS_MAX_BYTES), endpoints };
      }
      return { title: u.hostname, url: res.url, text: cutUtf8(JSON.stringify(doc, null, 1), DOCS_MAX_BYTES) };
    } catch { /* fall through to text */ }
  }
  if (type.includes("html") || /<html[\s>]/i.test(raw.slice(0, 2000))) {
    const { title, text } = htmlToText(raw);
    return { title: title || u.hostname, url: res.url, text: cutUtf8(text, DOCS_MAX_BYTES) };
  }
  return { title: u.hostname, url: res.url, text: cutUtf8(raw, DOCS_MAX_BYTES) };
}
