import { notFound } from "next/navigation";
import { Button, Window } from "@/features/shell";
import { settingsSession } from "@/features/settings/page-auth";
import { ThemeEditor } from "@/features/settings/ui/theme-editor";
import { canvasThemeCss } from "@/features/themes/resolve";
import { canEditThemes, getSavedTheme, themeById, themeUsage } from "@/features/themes/store";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit theme" };

export default async function ThemeEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await settingsSession(`/settings/themes/${id}`);
  const found = themeById(id);
  if (!found) notFound();
  if (found.builtIn || !canEditThemes(s.principal)) {
    return (
      <Window title={`themes / ${found.theme.name}`} className="max-w-[560px]" data-theme-readonly>
        <p className="type-body text-fg">{found.builtIn ? "Built-in themes cannot be edited. Duplicate it on the Themes screen to make your own." : "Owners and members can edit themes. You can see it on the Themes screen."}</p>
        <Button variant="secondary" href="/settings/themes" className="mt-4">Back to themes</Button>
      </Window>
    );
  }
  const saved = getSavedTheme(id)!;
  const css = saved.theme.customCss ? (canvasThemeCss(saved.theme, { scope: `s${id.replace(/[^a-z0-9]/g, "")}` }) as string) : undefined;
  return <ThemeEditor id={id} rev={saved.rev} theme={saved.theme} invalid={saved.invalid} usedBy={await themeUsage(id)} {...(css ? { savedCss: css } : {})} />;
}
