// The setup-required screen: one sentence, nothing to click (auth spec "States").
import { redirect } from "next/navigation";
import { ensureBootstrapped } from "@/features/auth/server/bootstrap";
import { AuthCard } from "../card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Setup required" };

export default async function SetupRequiredPage() {
  const setup = await ensureBootstrapped();
  if (setup.state === "ready") redirect("/sign-in");
  return (
    <AuthCard title="atrium / setup required">
      <h1 className="type-title-3 text-fg" data-setup-message={setup.reason}>
        {setup.message}
      </h1>
    </AuthCard>
  );
}
