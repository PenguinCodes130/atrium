"use client";
import { Window, usePageTitle } from "@/features/shell";

/** Sets the page title for the sky band crumb; the visible title is the shared ScreenHeader. */
export function SetupTitle({ title }: { title: string }) {
  usePageTitle(title);
  return null;
}

export function LinkExpired({ message }: { message: string }) {
  usePageTitle("Credentials");
  return (
    <div className="screen-x flex w-full flex-col py-(--gutter)">
      <Window title="integrations / credentials / link" className="max-w-2xl" padded={false} data-link-expired>
        <div className="p-6">
          <p role="alert" className="type-title-3 text-fg">{message}</p>
        </div>
      </Window>
    </div>
  );
}
