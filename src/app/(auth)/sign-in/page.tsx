import { redirect } from "next/navigation";
import { ensureBootstrapped } from "@/features/auth/server/bootstrap";
import { getSession } from "@/features/auth";
import { configuredProviders } from "@/features/auth/server/providers";
import { safeNext } from "@/features/auth/server/step-up";
import { SignInForm } from "@/features/auth/components";
import { AuthCard } from "../card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const setup = await ensureBootstrapped();
  if (setup.state !== "ready") redirect("/setup-required");
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : "/");
  // An MCP client's authorization request arrives here signed (sig, client_id). The form sends it
  // back with the sign-in so the flow continues to the consent screen.
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) query.append(k, one);
  const oauthQuery = query.get("sig") && query.get("client_id") ? query.toString() : null;
  if (!oauthQuery && (await getSession())) redirect(next);
  const error = typeof sp.error === "string" ? sp.error : null;
  return (
    <AuthCard>
      <SignInForm providers={configuredProviders()} next={next} initialError={error} oauthQuery={oauthQuery} />
    </AuthCard>
  );
}
