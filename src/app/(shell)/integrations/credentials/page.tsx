import { requireUser } from "@/features/auth";
import { listCredentials } from "@/features/integrations/credentials/service";
import { CredentialsView } from "@/features/integrations/ui/credentials-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Credentials" };

// The Credentials view of the Integrations tab (Amendment 2): the caller's own saved credentials
// (every one for the owner), never their values. Viewers see the role message.
export default async function CredentialsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireUser();
  const sp = await searchParams;
  return <CredentialsView credentials={listCredentials(s.principal)} canSave={s.principal.role !== "viewer"} startOpen={sp.new === "1"} />;
}
