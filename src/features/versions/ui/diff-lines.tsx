"use client";
// Readable diff lines grouped by page (design v4 "Versions"): added with an ok left edge, removed bad,
// changed warn. Each line also says what happened in words, so colour is never the only signal.
import type { DiffGroup } from "../diff";

const EDGE = { added: "border-l-ok", removed: "border-l-bad", changed: "border-l-warn" } as const;
const WORD = { added: "added", removed: "removed", changed: "changed" } as const;

export function DiffLines({ groups, empty = "No changes." }: { groups: DiffGroup[]; empty?: string }) {
  if (groups.length === 0) return <p className="type-body text-fg-2" data-diff-empty>{empty}</p>;
  return (
    <div className="flex flex-col gap-4" data-diff>
      {groups.map((g) => (
        <section key={g.pageId ?? "app"} className="flex flex-col gap-1" data-diff-group={g.title}>
          <h4 className="font-mono text-[12px] text-fg-2">{g.pageId ? `page / ${g.title}` : "app"}</h4>
          <ul className="flex flex-col gap-1">
            {g.lines.map((l, i) => (
              <li key={i} className={`flex items-baseline gap-2 border-l-4 bg-bg-sunk px-2 py-1 type-body ${EDGE[l.kind]}`} data-diff-line={l.kind}>
                <span className="w-16 flex-none font-mono text-[11px] text-fg-2">{WORD[l.kind]}</span>
                <span>{l.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
