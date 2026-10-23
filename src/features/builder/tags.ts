// The canvas selection tag (gauntlet w2-r2 item 9). Pure.
import type { ComponentNode, LibraryComponent } from "@/core/contracts";

/** The canvas selection tag: a library instance shows its library name, like the inspector header (item 9). */
export function tagFor(node: ComponentNode, library: Record<string, LibraryComponent> | undefined): string {
  if (node.libraryRef) {
    const lib = library?.[`${node.libraryRef.componentId}@${node.libraryRef.version}`];
    return lib?.name ?? node.name ?? "library component";
  }
  if (node.type.startsWith("lib:")) return node.name ?? "library component";
  return node.type;
}

