"use client";
// System screens (design v4 section 4, "System screens").
//   Error: one window titled "error · <short id>" with "Something went wrong in this room", a Primary
//     "Try again" and the id in caption type. The frame stays usable around it.
//   Not found: the empty room with "This room does not exist." and "Go to Apps".
//   Coming (Fix 11): a destination that is not built yet (/settings, /approvals, /library, /audit)
//     typed or bookmarked shows the same story as its tab, "<Name> is coming in a later update", in
//     the empty-room style, never "does not exist".
import { usePathname } from "next/navigation";
import { EmptyRoom, ROOM_COPY } from "./empty-room";
import { Button } from "./button";
import { usePageTitle } from "./shell-context";
import { Window } from "./window";
import { Screen, ScreenHeader } from "./screen-header";
import { comingRouteFor } from "./nav";

/** A short id for the logs: Next's digest when present, else a random one. */
export function shortErrorId(digest?: string): string {
  if (digest) return digest.slice(0, 10);
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ErrorScreen({ errorId, onRetry }: { errorId: string; onRetry: () => void }) {
  return (
    <Screen data-error-screen>
      <ScreenHeader title="Something went wrong in this room" lead="Atrium kept the rest of the frame running. Try the room again, or go back to your apps." />
      <Window title={`error · ${errorId}`} status={<span>failed</span>} live={false} className="w-full max-w-[560px]" role="alert" data-error-window>
        <p className="type-body text-fg">This screen stopped while it was loading. Nothing you saved is lost.</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={onRetry} data-retry>
            Try again
          </Button>
          <Button variant="quiet" href="/">
            Go to Apps
          </Button>
        </div>
        <p className="mt-6 border-t border-line pt-3 type-caption text-fg-3" data-error-id>
          error id <code className="text-fg">{errorId}</code>
        </p>
      </Window>
    </Screen>
  );
}

/** "<Name> is coming in a later update": the room for an unbuilt destination's address. */
export function ComingScreen({ label, arrives }: { label: string; arrives: string }) {
  usePageTitle(label);
  return (
    <EmptyRoom
      headingLevel={1}
      title={`${label} is coming in a later update.`}
      body={`It arrives ${arrives}. The rest of Atrium works now.`}
      actions={
        <Button variant="primary" href="/" data-go-home>
          Go to Apps
        </Button>
      }
      tag={<span className="tag">soon</span>}
    />
  );
}

export function NotFoundScreen() {
  const pathname = usePathname() ?? "/";
  const coming = comingRouteFor(pathname);
  if (coming) return <ComingScreen label={coming.label} arrives={coming.arrives} />;
  return <MissingRoom />;
}

function MissingRoom() {
  usePageTitle("Not found");
  return (
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
  );
}
