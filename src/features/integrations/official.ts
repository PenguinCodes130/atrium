// Static import map of the official packages (architecture v2 section 3: trusted code in the repo).
import type { Adapter, CustomEndpoint } from "@/core/contracts";
import prometheusManifest from "@/packages/prometheus/full-manifest";
import prometheus from "@/packages/prometheus/adapter";
import npmManifest from "@/packages/npm/manifest.json";
import npm from "@/packages/npm/adapter";
import pfsenseManifest from "@/packages/pfsense/manifest.json";
import pfsense from "@/packages/pfsense/adapter";
import rssManifest from "@/packages/rss/manifest.json";
import rss from "@/packages/rss/adapter";
import proxmoxManifest from "@/packages/proxmox/manifest.json";
import proxmox from "@/packages/proxmox/adapter";
import dockerManifest from "@/packages/docker/manifest.json";
import docker from "@/packages/docker/adapter";
import kumaManifest from "@/packages/uptime-kuma/manifest.json";
import kuma from "@/packages/uptime-kuma/adapter";
import haManifest from "@/packages/home-assistant/manifest.json";
import ha from "@/packages/home-assistant/adapter";
import customManifest from "@/packages/custom-api/manifest.json";
import { createCustomApiAdapter } from "@/packages/custom-api/adapter";
import systemManifest from "@/packages/atrium-system/manifest.json";
import system from "@/packages/atrium-system/adapter";

export type OfficialEntry = { manifest: unknown; adapter: Adapter | ((endpoints: CustomEndpoint[]) => Adapter) };

/** Gallery order: the eight official packages, then Custom API last. */
export const OFFICIAL_PACKAGES: OfficialEntry[] = [
  { manifest: prometheusManifest, adapter: prometheus },
  { manifest: npmManifest, adapter: npm },
  { manifest: pfsenseManifest, adapter: pfsense },
  { manifest: rssManifest, adapter: rss },
  { manifest: proxmoxManifest, adapter: proxmox },
  { manifest: dockerManifest, adapter: docker },
  { manifest: kumaManifest, adapter: kuma },
  { manifest: haManifest, adapter: ha },
  { manifest: customManifest, adapter: createCustomApiAdapter },
  // A10.6: built in, never in the gallery; its one integration (id "atrium") is created at start.
  { manifest: systemManifest, adapter: system },
];
