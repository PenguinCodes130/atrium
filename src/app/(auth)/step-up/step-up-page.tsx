"use client";
import { StepUpPanel } from "@/features/auth/components";
import { safeNext } from "@/features/auth/safe-next";

export function StepUpPage({ next, error }: { next: string; error: string | null }) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="type-title-2 text-fg">Confirm it is you</h1>
      <StepUpPanel next={next} initialError={error} onDone={() => window.location.assign(safeNext(next))} onCancel={() => window.location.assign(safeNext(next))} />
    </div>
  );
}
