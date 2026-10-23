import type { Logger } from "./contracts";

// Field names whose values are never written to logs (architecture section 13).
const REDACT = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|key$/i;

function scrub(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return data;
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, REDACT.test(k) ? "[redacted]" : v]));
}

function write(level: string, scope: string, msg: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), level, scope, msg, ...scrub(data) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function logger(scope: string): Logger {
  return {
    debug: (m, d) => process.env.ATRIUM_DEBUG && write("debug", scope, m, d),
    info: (m, d) => write("info", scope, m, d),
    warn: (m, d) => write("warn", scope, m, d),
    error: (m, d) => write("error", scope, m, d),
  };
}
