// The builder at /build/<slug> (app-builder). Editors only; others get the not-found room.
import { loadBuilder } from "@/features/apps/builder-load";
import { BuilderScreen } from "@/features/builder/builder-screen";
import type { InsertGroup } from "@/features/builder/panels";

export const dynamic = "force-dynamic";
export const metadata = { title: "Builder" };

export default async function BuilderHome({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const insert = sp.insert;
  // Settings r3 shared file request (gauntlet w2-r2 item 4): "Use on an app" in Settings links to
  // ?review=1 (open the publish review) and "Used by" to ?look=1 (open the App look sheet).
  const openOnStart = sp.review === "1" ? "review" : sp.look === "1" ? "look" : undefined;
  const p = await loadBuilder(slug);
  return <BuilderScreen {...p} catalogue={p.catalogue as InsertGroup[]} {...(typeof insert === "string" && /^lib:[A-Za-z0-9_-]{1,40}$/.test(insert) ? { insertOnOpen: insert } : {})} {...(openOnStart ? { openOnStart } : {})} />;
}
