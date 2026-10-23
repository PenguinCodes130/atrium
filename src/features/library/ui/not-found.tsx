"use client";
// Not found under /library (gauntlet w2-r2 Fix 8): the shell's "This room does not exist." room, drawn
// once inside the shell layout (the root not-found would wrap a second shell around it), with the crumb
// title "Not found". The library has shipped, so no "coming in a later update" room here.
import { Button, EmptyRoom, ROOM_COPY, usePageTitle } from "@/features/shell";

export function LibraryNotFound() {
  usePageTitle("Not found");
  return (
    <div className="flex flex-1 flex-col" data-not-found-in-shell data-library-not-found>
      <EmptyRoom
        headingLevel={1}
        title={ROOM_COPY.missing.title}
        body={null}
        actions={
          <Button variant="primary" href="/" data-go-home>
            {ROOM_COPY.missing.primary}
          </Button>
        }
      />
    </div>
  );
}
