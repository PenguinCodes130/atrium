// The library card's instance node (gauntlet w2-r1 Fix 14), shared by the /library page (server, which
// compiles its CSS) and the screen (browser, which renders it). Pure.
import type { ComponentNode, LibraryComponent } from "@/core/contracts";
import { derivedId } from "@/features/components/ids";
import { instanceNodeFor } from "@/features/components/library-instance";

/** The card's instance: a stable id (so the server-compiled CSS matches) and every data parameter pointed at its sample. */
export function libraryCardNode(c: LibraryComponent): ComponentNode {
  const n = instanceNodeFor(c);
  const props = { ...n.props };
  for (const p of c.params) if (p.kind === "data") props[p.name] = typeof p.default === "string" && p.default ? p.default : p.name;
  return { ...n, id: derivedId(`library-card/${c.id}`), props };
}

