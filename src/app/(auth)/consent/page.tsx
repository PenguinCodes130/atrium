// MCP OAuth consent (owned by auth; architecture section 9b). Better Auth's OAuth provider sends the
// signed-in user here with a signed authorization request. The screen names the agent and every scope
// it asks for; granting atrium:propose needs a step-up first (checked again on the server).
import { redirect } from "next/navigation";
import { getSession } from "@/features/auth";
import { ConsentFlow } from "@/features/auth/components";
import { consentDetails } from "@/features/auth/server/oauth";
import { AuthCard } from "../card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Allow an agent" };

export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) query.append(k, one);
  if (!(await getSession())) redirect(query.get("sig") ? `/sign-in?${query.toString()}` : "/sign-in?next=/consent");
  const details = await consentDetails(query);
  if (!details) {
    return (
      <AuthCard title="atrium / connect an agent">
        <div className="flex flex-col gap-2" data-consent-unavailable>
          <h1 className="type-title-2 text-fg">No agent is asking for access</h1>
          <p className="type-body text-fg-muted">
            {query.get("sig")
              ? "This request has expired or is not valid. Start the connection again from your agent."
              : "When an agent connects through MCP, this screen shows its name and every permission it asks for."}
          </p>
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="atrium / connect an agent">
      <ConsentFlow clientName={details.clientName} clientUri={details.clientUri} scopes={details.scopes} oauthQuery={details.oauthQuery} />
    </AuthCard>
  );
}
