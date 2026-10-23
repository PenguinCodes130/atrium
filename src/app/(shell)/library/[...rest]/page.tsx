// Every unknown /library/* address (components, gauntlet w2-r2 Fix 8): the library's own not-found room,
// inside the shell, instead of the root not-found (which drew the old "coming" room for /library).
import { notFound } from "next/navigation";
import { requireUser } from "@/features/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Not found" };

export default async function LibraryUnknown() {
  await requireUser();
  notFound();
}
