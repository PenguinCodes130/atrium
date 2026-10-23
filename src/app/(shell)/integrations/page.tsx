import { requireUser } from "@/features/auth";
import { canEdit, gallery, listIntegrations } from "@/features/integrations/service";
import { IntegrationsHome } from "@/features/integrations/ui/home";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrations" };

export default async function IntegrationsPage() {
  const s = await requireUser();
  const g = gallery();
  return <IntegrationsHome integrations={listIntegrations(s.principal)} packages={g.packages} declarative={g.declarative} problems={g.problems} canEdit={canEdit(s.principal)} />;
}
