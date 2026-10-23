import { OwnerOnly, settingsSession } from "@/features/settings/page-auth";
import { existingData } from "@/features/backup/import";
import { backupHistory } from "@/features/backup/status";
import { BackupsPanel } from "@/features/settings/ui/backups-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Backups" };

export default async function BackupsPage() {
  const s = await settingsSession("/settings/backups");
  if (s.user.role !== "owner") return <OwnerOnly what="Backups" />;
  return (
    <div data-settings-tab="backups">
      <BackupsPanel history={backupHistory()} existing={existingData(s.user.id)} />
    </div>
  );
}
