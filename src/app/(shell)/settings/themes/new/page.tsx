import { notFound } from "next/navigation";
import { Button, Window } from "@/features/shell";
import { settingsSession } from "@/features/settings/page-auth";
import { ThemeEditor } from "@/features/settings/ui/theme-editor";
import { canEditThemes, themeById, uniqueName } from "@/features/themes/store";

export const dynamic = "force-dynamic";
export const metadata = { title: "New theme" };

// Wave 2.10a r2 (low L8): New theme opens the editor on an unsaved copy (Control Room, or ?from=<id>),
// and nothing is stored until the person presses Save, so leaving it leaves no stray theme behind.
export default async function NewThemePage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const { from } = await searchParams;
  const s = await settingsSession("/settings/themes/new");
  if (!canEditThemes(s.principal)) {
    return (
      <Window title="themes / new" className="max-w-[560px]" data-theme-readonly>
        <p className="type-body text-fg">Owners and members can make themes.</p>
        <Button variant="secondary" href="/settings/themes" className="mt-4">Back to themes</Button>
      </Window>
    );
  }
  const base = themeById(typeof from === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(from) ? from : "control-room") ?? themeById("control-room");
  if (!base) notFound();
  const theme = { ...base.theme, id: "new", name: uniqueName(`${base.theme.name} copy`), author: base.builtIn ? "Atrium" : base.theme.author };
  return <ThemeEditor id="new" isNew rev={0} theme={theme} invalid={0} usedBy={[]} />;
}
