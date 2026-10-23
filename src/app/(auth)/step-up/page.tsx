// Full-page step-up, for returns from a provider and direct links. Sheets are the usual path.
import { redirect } from "next/navigation";
import { getSession } from "@/features/auth";
import { safeNext } from "@/features/auth/server/step-up";
import { StepUpPage } from "./step-up-page";
import { AuthCard } from "../card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Confirm it is you" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!(await getSession())) redirect("/sign-in?next=/step-up");
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : "/");
  const error = typeof sp.error === "string" ? "The confirmation did not complete. Try again, or cancel." : null;
  return (
    <AuthCard title="atrium / confirm it is you">
      <StepUpPage next={next} error={error} />
    </AuthCard>
  );
}
