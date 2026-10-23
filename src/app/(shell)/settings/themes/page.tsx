import { settingsSession } from "@/features/settings/page-auth";
import { ThemesScreen } from "@/features/settings/ui/themes-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Themes" };

export default async function ThemesPage() {
  await settingsSession("/settings/themes");
  return (
    <div data-settings-tab="themes">
      <ThemesScreen />
    </div>
  );
}
