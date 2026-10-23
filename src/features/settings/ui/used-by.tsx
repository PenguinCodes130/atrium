"use client";
// "Used by" as a count with a disclosure (settings gauntlet w2-r1 item 7): app names never wrap mid-word
// in a narrow card; the list opens on demand. Settings r3 (w2-r2 item 4): each app links to its Look in
// the builder.
export function UsedBy({ usedBy }: { usedBy: { appId: string; slug?: string; name: string; draft: boolean; published: boolean }[] }) {
  if (!usedBy.length) return <p className="mt-2 type-caption text-fg-2" data-used-by="0">Used by no apps</p>;
  return (
    <details className="mt-2" data-used-by={usedBy.length}>
      <summary className="flex min-h-9 cursor-pointer items-center type-caption text-fg-2 touch:min-h-11">Used by {usedBy.length} {usedBy.length === 1 ? "app" : "apps"}</summary>
      <ul className="flex flex-col gap-0.5 pl-3">
        {usedBy.map((u) => (
          <li key={u.appId} className="type-caption break-words text-fg">
            {u.slug ? (
              <a href={`/build/${encodeURIComponent(u.slug)}?look=1`} className="inline-flex min-h-9 items-center underline underline-offset-2 hover:text-fg-2 touch:min-h-11" data-used-by-link={u.slug}>{u.name}</a>
            ) : (
              u.name
            )}
            {u.published && !u.draft ? " (published)" : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}
