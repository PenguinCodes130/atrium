import { notFound } from "next/navigation";
import { requireUser } from "@/features/auth";
import { Screen, ScreenHeader } from "@/features/shell";
import { addressBook, canEdit, packageCard } from "@/features/integrations/service";
import { getPackage } from "@/features/integrations/runtime";
import { ConnectionForm } from "@/features/integrations/ui/setup-form";
import { SetupTitle } from "@/features/integrations/ui/setup-title";
import { CanChangeList } from "@/features/integrations/ui/commands";
import { ProvidesWindow } from "@/features/integrations/ui/provides";
import { listCredentials } from "@/features/integrations/credentials/service";

export const dynamic = "force-dynamic";

// The setup screen (premium-feel r2): the shared screen header, the form on the screen's left edge,
// and a right-hand window with what the integration will provide.
export default async function SetupPage({ params, searchParams }: { params: Promise<{ packageId: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireUser();
  const id = (await params).packageId.map(decodeURIComponent).join("/");
  if (!getPackage(id) || id === "custom-api") notFound();
  const pkg = packageCard(id);
  const sp = await searchParams;
  const prefill: Record<string, string> = {};
  for (const k of ["baseUrl", "endpoint"]) if (typeof sp[k] === "string") prefill[k] = sp[k] as string;
  return (
    <Screen>
      <SetupTitle title={`Connect ${pkg.name}`} />
      <ScreenHeader title={`Connect ${pkg.name}`} lead={pkg.description} />
      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,40rem)_minmax(0,1fr)]" data-setup-layout>
        <ConnectionForm pkg={pkg} prefill={prefill} canEdit={canEdit(s.principal)} existing={addressBook(s.principal)} credentials={listCredentials(s.principal)} />
        <div className="flex flex-col gap-6">
          <ProvidesWindow pkg={pkg} />
          <CanChangeList items={pkg.commands} intro="Once it is connected, controls that the owner or you place on published apps can run these. Nothing runs until then, and every run is recorded in the audit log." />
        </div>
      </div>
    </Screen>
  );
}
