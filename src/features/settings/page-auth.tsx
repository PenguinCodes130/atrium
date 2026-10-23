// Page guards for settings screens: a signed-in session (else sign-in, keeping the return path), and
// the owner-only room for General, Users and Backups. The API routes refuse the same people with 403.
import "server-only";
import { redirect } from "next/navigation";
import { Unauthorized } from "@/core/errors";
import { requireUser, type AtriumSession } from "@/features/auth";
import { Window } from "@/features/shell";

export async function settingsSession(path = "/settings"): Promise<AtriumSession> {
  try {
    return await requireUser();
  } catch (err) {
    if (err instanceof Unauthorized) redirect(`/sign-in?next=${encodeURIComponent(path)}`);
    throw err;
  }
}

export function OwnerOnly({ what }: { what: string }) {
  return (
    <Window title="settings / owner only" live={false} className="max-w-[560px]" role="alert" data-owner-only>
      <p className="type-body text-fg">Only the owner can open {what}.</p>
    </Window>
  );
}
