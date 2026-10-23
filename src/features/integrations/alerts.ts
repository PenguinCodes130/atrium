// System alerts from integrations (spec 3.1, 3.4.7). The notifications subsystem (a later wave)
// owns notify(); until it registers, alerts are written to the log so nothing is lost.
import "server-only";
import { randomUUID } from "node:crypto";
import type { Alert } from "@/core/contracts";
import { logger } from "@/core/log";

type Notify = (alert: Alert) => Promise<unknown> | unknown;
const g = globalThis as unknown as { __atriumNotify?: Notify; __atriumAlertLog?: Alert[] };
const log = logger("integrations.alerts");

/** notifications calls this at startup with its notify(). */
export function registerAlertSink(notify: Notify): void {
  g.__atriumNotify = notify;
}

export function sendSystemAlert(a: Omit<Alert, "id" | "at" | "source">): Alert {
  const alert: Alert = { id: randomUUID(), source: "system", at: new Date().toISOString(), ...a };
  (g.__atriumAlertLog ??= []).push(alert);
  if (g.__atriumAlertLog.length > 200) g.__atriumAlertLog.shift();
  log.warn("system alert", { severity: alert.severity, title: alert.title, body: alert.body });
  try { void g.__atriumNotify?.(alert); } catch { /* delivery problems belong to notifications */ }
  return alert;
}

/** Alerts sent in this process, newest last (diagnostics and tests). */
export function sentAlerts(): Alert[] {
  return [...(g.__atriumAlertLog ?? [])];
}
