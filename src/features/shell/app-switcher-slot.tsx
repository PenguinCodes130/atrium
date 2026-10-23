// Server slot for the app switcher (architecture v3 A1.6). app-builder renders
// <AppSwitcherSlot slug={slug} /> in the (app) route group's viewer; it resolves who is viewing and
// what the sheet lists, then draws the client <AppSwitcher>. Guests and signed-out viewers get nothing.
import "server-only";
import { getPrincipal } from "@/features/auth";
import { AppSwitcher } from "./app-switcher";
import { switcherData } from "./switcher-data";

export async function AppSwitcherSlot({ slug }: { slug: string }) {
  const principal = await getPrincipal().catch(() => null);
  const data = await switcherData(principal, slug);
  if (!data.show) return null;
  return <AppSwitcher viewer="user" currentSlug={slug} apps={data.apps} canEdit={data.canEdit} />;
}
