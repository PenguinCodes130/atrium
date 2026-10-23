import { redirect } from "next/navigation";
import { settingsSession } from "@/features/settings/page-auth";

export const dynamic = "force-dynamic";

// /settings opens the first tab the person can use.
export default async function SettingsIndex() {
  const s = await settingsSession();
  redirect(s.user.role === "owner" ? "/settings/general" : "/settings/appearance");
}
