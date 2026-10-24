// A10.5 service information: a service's kind (start page groups), its own address for tiles
// ("Open address") and its headline stats. Stored per integration in `integration_service`; until
// that table exists (the lead's migration), every integration answers its package's kind and
// headline and its configured address, and saves of these fields are refused in words.
import "server-only";
import { eq } from "drizzle-orm";
import type { HeadlineStat, Integration, PackageManifest, ServiceKind } from "@/core/contracts";
import { db, sqlite } from "@/core/db";
import { logger } from "@/core/log";
import { integrationServices } from "@/db/schema/integrations";
import { SERVICE_KINDS } from "./manifest";
import type { IntegrationRow } from "./repo";

const log = logger("integrations.service-info");

export const SERVICE_TABLE_MISSING = "Atrium needs a database update before it can keep a service's kind, address and headline stats. They show their defaults until then.";

const g = globalThis as unknown as { __atriumServiceTable?: { ready: boolean; at: number } };

/** Whether the integration_service table exists; a missing table is checked again every 30 s. */
export function serviceTableReady(now = Date.now()): boolean {
  const c = g.__atriumServiceTable;
  if (c && (c.ready || now - c.at < 30_000)) return c.ready;
  let ready = false;
  try {
    ready = !!sqlite().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'integration_service'").get();
  } catch {
    ready = false;
  }
  g.__atriumServiceTable = { ready, at: now };
  return ready;
}

/** openUrl "" means the owner chose no link; a missing openUrl falls back to the configured address. */
export type ServiceRow = { kind?: ServiceKind; openUrl?: string; headline?: HeadlineStat[] };

export function getServiceRow(integrationId: string): ServiceRow | undefined {
  if (!serviceTableReady()) return undefined;
  const r = db().select().from(integrationServices).where(eq(integrationServices.integrationId, integrationId)).get();
  if (!r) return undefined;
  return { ...(r.kind ? { kind: r.kind } : {}), ...(r.openUrl !== null ? { openUrl: r.openUrl } : {}), ...(r.headline ? { headline: r.headline as HeadlineStat[] } : {}) };
}

/** Every stored row at once, for listings. */
export function serviceRows(): Map<string, ServiceRow> {
  if (!serviceTableReady()) return new Map();
  return new Map(db().select().from(integrationServices).all().map((r) => [r.integrationId, { ...(r.kind ? { kind: r.kind } : {}), ...(r.openUrl !== null ? { openUrl: r.openUrl } : {}), ...(r.headline ? { headline: r.headline as HeadlineStat[] } : {}) }]));
}

/**
 * Saves the given fields (null clears one, undefined keeps it). Returns false when the table is
 * missing, so the caller can say so; a save never fails the rest of an integration change.
 */
export function saveServiceRow(integrationId: string, patch: { kind?: ServiceKind | null; openUrl?: string | null; headline?: HeadlineStat[] | null }): boolean {
  if (!serviceTableReady()) {
    log.warn("integration_service table missing; service fields not saved", { integrationId });
    return false;
  }
  const prev = getServiceRow(integrationId) ?? {};
  const next = {
    kind: patch.kind === undefined ? (prev.kind ?? null) : patch.kind,
    openUrl: patch.openUrl === undefined ? (prev.openUrl ?? null) : patch.openUrl,
    headline: patch.headline === undefined ? (prev.headline ?? null) : patch.headline,
  };
  const row = { integrationId, ...next, updatedAt: new Date() };
  db().insert(integrationServices).values(row).onConflictDoUpdate({ target: integrationServices.integrationId, set: { kind: row.kind, openUrl: row.openUrl, headline: row.headline, updatedAt: row.updatedAt } }).run();
  return true;
}

/** An http or https address with no credentials in it, normalised; undefined otherwise. */
export function cleanOpenUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(v.trim()) ? v.trim() : `http://${v.trim()}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (u.username || u.password) return undefined;
    return u.toString().slice(0, 2048);
  } catch {
    return undefined;
  }
}

/** The configured base address of a package that has one (baseUrl); Docker's API address is not a web page. */
export function baseAddressOf(row: Pick<IntegrationRow, "packageId" | "config">): string | undefined {
  if (row.packageId === "docker") return undefined;
  return cleanOpenUrl(row.config.baseUrl);
}

const KIND_WORDS: [ServiceKind, RegExp][] = [
  ["media", /\b(jellyfin|plex|emby|sonarr|radarr|lidarr|readarr|prowlarr|bazarr|overseerr|jellyseerr|tautulli|immich|photoprism|navidrome|audiobookshelf|kavita|komga|media|movies?|music|photos?|tv|video|stream(ing)?)\b/],
  ["monitoring", /\b(prometheus|grafana|uptime|kuma|monitor(ing)?|metrics?|alert(s|ing)?|netdata|zabbix|loki|status|health)\b/],
  ["network", /\b(pfsense|opnsense|unifi|pihole|pi-hole|adguard|nginx|proxy|traefik|caddy|wireguard|tailscale|dns|dhcp|firewall|router|network(ing)?|vpn)\b/],
  ["smart-home", /\b(home ?assistant|hass|homebridge|zigbee|z-?wave|mqtt|smart ?home|automation|esphome|node-red)\b/],
  ["storage", /\b(truenas|unraid|nextcloud|syncthing|minio|storage|nas|backups?|files?|drive|seafile|paperless)\b/],
  ["containers", /\b(docker|portainer|podman|kubernetes|k8s|containers?|proxmox|vms?)\b/],
];

/** A10.5 spec import: the kind from words in a spec title, `other` when nothing fits. */
export function kindFromTitle(title: string | undefined): ServiceKind {
  const t = (title ?? "").toLowerCase();
  for (const [k, re] of KIND_WORDS) if (re.test(t)) return k;
  return "other";
}

export function isServiceKind(v: unknown): v is ServiceKind {
  return typeof v === "string" && (SERVICE_KINDS as readonly string[]).includes(v);
}

export type ServiceInfo = Required<Pick<Integration, "kind">> & Pick<Integration, "openUrl"> & { headline: HeadlineStat[]; headlineFrom: "integration" | "package" | "none" };

/** The integration's kind, address and headline: its own when set, else the package's and its base address. */
export function serviceInfoOf(row: Pick<IntegrationRow, "id" | "packageId" | "config">, manifest: PackageManifest | undefined, stored: ServiceRow | undefined = getServiceRow(row.id)): ServiceInfo {
  const specTitle = row.packageId === "custom-api" && typeof row.config.specTitle === "string" ? row.config.specTitle : undefined;
  const kind = stored?.kind ?? (specTitle ? kindFromTitle(specTitle) : undefined) ?? manifest?.service?.kind ?? "other";
  const openUrl = stored?.openUrl !== undefined ? stored.openUrl || undefined : baseAddressOf(row);
  const own = stored?.headline;
  const pkg = manifest?.service?.headline;
  const headline = own ?? pkg ?? [];
  return { kind, ...(openUrl ? { openUrl } : {}), headline: headline.slice(0, 4), headlineFrom: own ? "integration" : pkg?.length ? "package" : "none" };
}
