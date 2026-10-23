// /account moved under settings (architecture v3 Amendment 4, A4.4). auth keeps this route file as a
// permanent redirect to /settings/security, query kept. The proxy (src/proxy.ts) answers /account and
// every path under it with a 308 before this page runs; this file covers anything that reaches it anyway.
// The panels themselves are exported from "@/features/auth/settings-panels" for settings to mount.
import { permanentRedirect } from "next/navigation";
import { accountRedirectTarget } from "@/features/auth/server/security";

export const dynamic = "force-dynamic";

export default async function AccountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, one);
  const search = q.toString();
  permanentRedirect(accountRedirectTarget(search ? `?${search}` : ""));
}
