// Signers for image URLs inside integration data (settings gauntlet w2-r1 items 3 and 4), for the data
// stream and the polling fallback (src/features/data/routes.ts, applied by the lead as a shared file
// request). Each data source's URLs are signed for that page's app, for the caller's kind (a guest gets
// guest-safe signatures, a signed-in person "viewer" ones), and only when the URL is public or on that
// source's own integration origin (its configured base URL's scheme, host and port; settings gauntlet
// w2-r2 item 1: a host-name match let a feed reach every other port on that machine). A URL a stranger put into an RSS
// item or a calendar invite that points at loopback, a private address or a local name is not signed,
// so it can never make Atrium send a GET into the LAN.
import "server-only";
import type { Principal } from "@/core/contracts";
import { getIntegrationRow } from "@/features/integrations/repo";
import { dataImageSigner, integrationOriginsFrom, type ImageAccess } from "./sign";

export type UrlSigner = (url: string) => string | null;

/**
 * Extra ports on the integration's own host that a package serves images from, declared here by
 * package id (none today: every official package serves its images from its base URL's origin). A port
 * listed here is trusted for that package's integrations only, with the base URL's scheme and host.
 */
export const IMAGE_PORTS_BY_PACKAGE: Readonly<Record<string, readonly number[]>> = Object.freeze({});

/** The origins an integration was configured with (none for an unknown integration). */
export function integrationImageOrigins(integrationId: string): string[] {
  const row = getIntegrationRow(integrationId);
  return row ? integrationOriginsFrom(row.config, IMAGE_PORTS_BY_PACKAGE[row.packageId] ?? []) : [];
}

/**
 * One signer per data source key on a page. `sources` are the page's stream sources (key and
 * integration id). Unknown keys get null (nothing is signed).
 */
export function imageSignersFor(p: Principal, appId: string, sources: readonly { key: string; integrationId: string }[]): (sourceKey: string) => UrlSigner | null {
  const access: ImageAccess = p.kind === "guest" ? "guest" : "viewer";
  const signers = new Map<string, UrlSigner>();
  const origins = new Map<string, string[]>();
  for (const s of sources) {
    let own = origins.get(s.integrationId);
    if (!own) {
      own = integrationImageOrigins(s.integrationId);
      origins.set(s.integrationId, own);
    }
    signers.set(s.key, dataImageSigner({ appId, access, ownOrigins: own }));
  }
  return (key) => signers.get(key) ?? null;
}
