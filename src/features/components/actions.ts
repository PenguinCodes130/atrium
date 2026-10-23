"use server";
// Server actions for the builder: compile node CSS through app-shell's sanitiser (it is server only)
// and report what was removed. Signed-in users only; guest and viewer pages get CSS precompiled by
// the server render (compileDocumentCss).
import type { ComponentNode } from "@/core/contracts";
import { requireUser } from "@/features/auth";
import { compileNodeCss } from "./style/server";

type StyledNode = Pick<ComponentNode, "id" | "type" | "style" | "css" | "overrideTheme" | "responsive">;

export async function compileNodeStylesAction(nodes: StyledNode[]): Promise<Record<string, { css: string; removed: string[] }>> {
  await requireUser();
  const out: Record<string, { css: string; removed: string[] }> = {};
  for (const n of (Array.isArray(nodes) ? nodes : []).slice(0, 200)) {
    if (!n || typeof n.id !== "string" || typeof n.type !== "string") continue;
    if (typeof n.css === "string" && n.css.length > 65536) {
      out[n.id] = { css: "", removed: ["Node CSS is limited to 64 KB; nothing was applied."] };
      continue;
    }
    out[n.id] = compileNodeCss({ id: n.id, type: n.type, style: n.style, css: n.css, overrideTheme: n.overrideTheme, responsive: n.responsive });
  }
  return out;
}
