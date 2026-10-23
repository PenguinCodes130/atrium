// Server component: the owner banners settings shows (password variable still set, secrets locked).
import "server-only";
import { WarnIcon, ErrorIcon } from "@/features/shell";
import { getAuthBanners } from "./server/banners";

export { getAuthBanners };
export { loadUsersPage } from "./server/manage";

export async function AuthBanners() {
  const banners = await getAuthBanners();
  if (banners.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-auth-banners>
      {banners.map((b) => (
        <p key={b.id} role={b.tone === "critical" ? "alert" : "status"} data-banner={b.id} className="flex items-start gap-2 border border-line-strong bg-bg-hi p-3 type-body text-fg">
          {b.tone === "critical" ? <ErrorIcon className="mt-0.5 size-4 flex-none text-danger" /> : <WarnIcon className="mt-0.5 size-4 flex-none text-warning" />}
          <span>{b.message}</span>
        </p>
      ))}
    </div>
  );
}
