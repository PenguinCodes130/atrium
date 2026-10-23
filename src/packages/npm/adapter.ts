// Nginx Proxy Manager adapter. Read-only, GET only.
import { arr, defineAdapter, getJson, num, obj, str } from "../lib";

const TOKEN = { auth: "token", secretLabel: "API token" };

function parseTime(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s);
  return Number.isNaN(t) ? null : t;
}

const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";

export default defineAdapter({
  async health(ctx) {
    const info = obj(await getJson(ctx, "api/"), "status");
    const v = obj(info.version ?? {}, "version");
    // The status route is public; this one proves the token works.
    await getJson(ctx, "api/users/me", TOKEN);
    const version = v.major !== undefined ? `${str(v.major)}.${str(v.minor)}.${str(v.revision)}` : undefined;
    return { status: str(info.status).toUpperCase() === "OK" ? "ok" : "degraded", version };
  },
  reads: {
    async "proxy-hosts"(ctx) {
      const rows = arr(await getJson(ctx, "api/nginx/proxy-hosts", TOKEN), "proxy host list").map((h) => {
        const host = obj(h, "proxy host");
        const domains = Array.isArray(host.domain_names) ? host.domain_names.map((d) => str(d)).join(", ") : str(host.domain_names);
        const cert = num(host.certificate_id) ?? 0;
        return {
          domain: domains,
          forward: `${str(host.forward_scheme, "http")}://${str(host.forward_host)}:${str(host.forward_port)}`,
          enabled: truthy(host.enabled) ? "up" : "down",
          ssl: cert > 0 ? (truthy(host.ssl_forced) ? "Forced" : "On") : "Off",
        };
      });
      return {
        data: {
          kind: "table",
          columns: [
            { key: "domain", label: "Domain", type: "text" },
            { key: "forward", label: "Forward target", type: "text" },
            { key: "enabled", label: "Enabled", type: "status" },
            { key: "ssl", label: "SSL", type: "text" },
          ],
          rows,
          total: rows.length,
        },
      };
    },
    async certificates(ctx) {
      const rows = arr(await getJson(ctx, "api/nginx/certificates", TOKEN), "certificate list")
        .map((c) => {
          const cert = obj(c, "certificate");
          const domains = Array.isArray(cert.domain_names) ? cert.domain_names.map((d) => str(d)).join(", ") : "";
          return { name: str(cert.nice_name) || domains, domains, provider: str(cert.provider), expires: parseTime(cert.expires_on) };
        })
        .sort((a, b) => (a.expires ?? Infinity) - (b.expires ?? Infinity));
      return {
        data: {
          kind: "table",
          columns: [
            { key: "name", label: "Certificate", type: "text" },
            { key: "domains", label: "Domains", type: "text" },
            { key: "provider", label: "Provider", type: "text" },
            { key: "expires", label: "Expires", type: "time" },
          ],
          rows,
          total: rows.length,
        },
      };
    },
  },
});
