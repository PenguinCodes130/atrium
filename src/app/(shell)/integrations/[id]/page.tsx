import { notFound } from "next/navigation";
import { requireUser } from "@/features/auth";
import { NotFound } from "@/core/errors";
import { canEdit, canManage, canReadData, getIntegration, listEndpoints, packageCard, sharingView } from "@/features/integrations/service";
import { commandsView } from "@/features/integrations/commands";
import { getPackage } from "@/features/integrations/runtime";
import { IntegrationDetail } from "@/features/integrations/ui/detail";
import { listCredentials } from "@/features/integrations/credentials/service";

export const dynamic = "force-dynamic";

export default async function IntegrationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireUser();
  const { id } = await params;
  let integration;
  try { integration = getIntegration(s.principal, id); } catch (e) { if (e instanceof NotFound) notFound(); throw e; }
  const pkg = getPackage(integration.packageId) ? packageCard(integration.packageId) : null;
  const sp = await searchParams;
  return <IntegrationDetail integration={integration} pkg={pkg} endpoints={listEndpoints(s.principal, id)} canEdit={canManage(s.principal, integration)} cachedOnly={sp.cached === "1"} commands={commandsView(s.principal, id)} sharing={await sharingView(s.principal, id)} credentials={listCredentials(s.principal)} canRead={canReadData(s.principal, integration)} canRecipes={canEdit(s.principal) && (canReadData(s.principal, integration) || canManage(s.principal, integration))} />;
}
