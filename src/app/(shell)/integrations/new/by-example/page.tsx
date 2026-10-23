import { requireUser } from "@/features/auth";
import { Forbidden } from "@/core/errors";
import { addressBook, canEdit } from "@/features/integrations/service";
import { ByExample } from "@/features/integrations/ui/by-example";

export const dynamic = "force-dynamic";
export const metadata = { title: "Custom API" };

export default async function ByExamplePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireUser();
  if (!canEdit(s.principal)) throw new Forbidden("Your role can view integrations but not change them.");
  const sp = await searchParams;
  let queue: { method: string; path: string; summary: string; shape: string }[] | undefined;
  try { queue = typeof sp.queue === "string" ? (JSON.parse(sp.queue) as typeof queue)?.slice(0, 50) : undefined; } catch { queue = undefined; }
  const existing = addressBook(s.principal).filter((e) => e.packageId === "custom-api");
  return <ByExample existing={existing} {...(typeof sp.url === "string" ? { initialUrl: sp.url } : {})} {...(typeof sp.integration === "string" ? { integrationId: sp.integration } : {})} {...(queue ? { queue } : {})} {...(typeof sp.spec === "string" ? { specUrl: sp.spec } : {})} />;
}
