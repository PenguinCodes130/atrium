import { readFileSync } from "node:fs";
import path from "node:path";
import type { AdapterContext, HostHttp } from "@/core/contracts";

export const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "__fixtures__", name), "utf8");

export type Route = { status?: number; body: string; headers?: Record<string, string> };
export type Call = { path: string; method: string; query?: Record<string, string>; auth?: string; body?: unknown };

/** A HostHttp that answers from fixtures by path. Records calls; never touches the network. */
export function fakeCtx(routes: Record<string, Route | ((c: Call) => Route)>, config: Record<string, unknown> = {}): { ctx: AdapterContext; calls: Call[] } {
  const calls: Call[] = [];
  const http: HostHttp = {
    async fetch(req) {
      const call: Call = { path: req.path, method: req.method ?? "GET", ...(req.query ? { query: req.query } : {}), ...(req.auth ? { auth: req.auth } : {}), ...(req.body !== undefined ? { body: req.body } : {}) };
      calls.push(call);
      const r = routes[req.path];
      if (!r) return { status: 404, headers: {}, text: async () => "", json: async () => ({}) };
      const route = typeof r === "function" ? r(call) : r;
      return { status: route.status ?? 200, headers: route.headers ?? {}, text: async () => route.body, json: async () => JSON.parse(route.body) as unknown };
    },
  };
  return { ctx: { config, http, log: { debug() {}, info() {}, warn() {}, error() {} }, signal: new AbortController().signal, now: () => new Date("2026-10-17T12:00:00Z") }, calls };
}
