// settings public surface (server).
//   getInstanceSettings(), versionRetention(), auditRetentionDays()   instance-wide values (A4.4)
//   getUserPrefs(userId)                                              per-user shell preferences
//   registerAppPort(port)                                             app-builder plugs in its apps (see app-port.ts)
//   settingsTools                                                     themes.* agent tools for the registry
import "server-only";
export { getInstanceSettings, getUserPrefs, versionRetention, auditRetentionDays, MIN_VERSION_RETENTION, DEFAULT_AUDIT_RETENTION_DAYS } from "./store";
export type { InstanceSettings, UserPrefs } from "./store";
export { registerAppPort, appPort } from "./app-port";
export type { AppPort, PortApp } from "./app-port";
export { settingsTools } from "./tools";
