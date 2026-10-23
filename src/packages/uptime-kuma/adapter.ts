// Uptime Kuma adapter. Reads the Prometheus-format /metrics page with an API key. GET only.
import type { AdapterContext } from "@/core/contracts";
import { checkStatus, defineAdapter } from "../lib";

const KEY = { auth: "apiKey" } as const;

async function metrics(ctx: AdapterContext): Promise<string> {
  const res = await ctx.http.fetch({ path: "metrics", ...KEY });
  checkStatus(res, "API key");
  return res.text();
}

function labels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) out[m[1]!] = m[2]!.replace(/\\(.)/g, "$1");
  return out;
}

export function parseMonitors(text: string) {
  const items: { label: string; state: "up" | "down" | "warn" | "unknown"; detail?: string }[] = [];
  for (const m of text.matchAll(/^monitor_status\{([^}]*)\}\s+(\S+)/gm)) {
    const l = labels(m[1]!);
    const v = Number(m[2]);
    const state = v === 1 ? "up" : v === 0 ? "down" : v === 2 ? "warn" : "unknown";
    items.push({ label: l.monitor_name ?? "monitor", state, detail: v === 2 ? "pending" : v === 3 ? "maintenance" : (l.monitor_type ?? "") || undefined });
  }
  return items;
}

export default defineAdapter({
  async health(ctx) {
    const text = await metrics(ctx);
    const version = /^app_version\{([^}]*)\}/m.exec(text);
    return { status: /monitor_status/.test(text) ? "ok" : "degraded", version: version ? labels(version[1]!).version : undefined };
  },
  reads: {
    async monitors(ctx) {
      return { data: { kind: "status", items: parseMonitors(await metrics(ctx)) } };
    },
  },
});
