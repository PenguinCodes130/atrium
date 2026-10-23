import { requireUser } from "@/features/auth";
import { Screen, ScreenHeader } from "@/features/shell";
import { canEdit, gallery } from "@/features/integrations/service";
import { AddIntegration } from "@/features/integrations/ui/gallery";

export const dynamic = "force-dynamic";
export const metadata = { title: "Add integration" };

export default async function NewIntegrationPage() {
  const s = await requireUser();
  return (
    <Screen>
      <ScreenHeader title="Add integration" lead="Paste an address to detect it, or pick an app Atrium knows." />
      <AddIntegration packages={gallery().packages} canEdit={canEdit(s.principal)} />
    </Screen>
  );
}
