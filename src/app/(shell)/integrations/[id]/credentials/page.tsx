import { requireUser } from "@/features/auth";
import { checkCredentialLink, getIntegration } from "@/features/integrations/service";
import { commandsView } from "@/features/integrations/commands";
import { CredentialsForm } from "@/features/integrations/ui/credentials";
import { LinkExpired } from "@/features/integrations/ui/setup-title";
import { listCredentials } from "@/features/integrations/credentials/service";
import { getIntegrationRow } from "@/features/integrations/repo";
import { effectiveManifest, getPackage, pinFor } from "@/features/integrations/runtime";

export const dynamic = "force-dynamic";
export const metadata = { title: "Credentials" };

// Opened from an agent's request_credentials link. Needs a signed-in session (requireUser never
// accepts an agent token); expires after 24 hours and once the secrets are saved.
export default async function CredentialsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireUser();
  const { id } = await params;
  const token = (await searchParams).draft;
  const link = checkCredentialLink(id, token);
  if (!link.ok || !token) return <LinkExpired message={link.ok ? "This link has expired. Ask your agent for a new one" : link.message} />;
  const row = getIntegrationRow(id);
  const pkg = row ? getPackage(row.packageId) : undefined;
  const origin = row && pkg ? pinFor(effectiveManifest(pkg, row.secretFields), row.config) : undefined;
  return <CredentialsForm integration={getIntegration(s.principal, id)} token={token} canChange={commandsView(s.principal, id).pending} credentials={listCredentials(s.principal)} origin={origin} />;
}
