// The component library (architecture v3 section 4.8, amendment A4.1): owners and members only.
import { redirect } from "next/navigation";
import { requireUser } from "@/features/auth";
import { appAccess } from "@/core/hooks";
import { listLibrary } from "@/features/library/server";
import { LibraryScreen } from "@/features/library/ui/library-screen";
import { libraryCardNode } from "@/features/library/card";
import { compileDocumentCss } from "@/features/components/server";
import type { AppDocument } from "@/core/contracts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Library" };

export default async function LibraryPage() {
  const s = await requireUser();
  // Viewers and guests never reach the library (spec 3.6.5).
  if (s.principal.role === "viewer") redirect("/");
  const hook = appAccess();
  const apps = hook ? await hook.appsFor(s.principal) : [];
  const editable: { slug: string; name: string }[] = [];
  for (const a of apps) if (hook && (await hook.canEditApp(s.principal, a.id))) editable.push({ slug: a.slug, name: a.name });
  const components = listLibrary(s.principal);
  // Each card renders its component with its saved style (gauntlet w2-r1 Fix 14): the same server-side
  // compile and sanitiser an app page uses, for a one-node page holding the card's instance.
  const css: Record<string, Record<string, string>> = {};
  for (const c of components) {
    const root = libraryCardNode(c);
    const doc: AppDocument = { format: "atrium-app", formatVersion: 1, app: { name: "library", homePage: "p_librarycard", pageOrder: ["p_librarycard"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" }, dataSources: [], controls: [], pages: [{ id: "p_librarycard", slug: "card", title: "Card", inNav: false, root: { id: "c_librarycrd", type: "stack", props: {}, children: [root] } }] };
    css[c.id] = compileDocumentCss(doc, undefined, { [`${c.id}@${c.version}`]: c });
  }
  return <LibraryScreen components={components} principal={s.principal} apps={editable} css={css} />;
}
