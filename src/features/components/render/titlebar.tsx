"use client";
// The window title bar a component surface carries when its theme has `surface.titleBars` on (design
// v4 "Windows" and section 2; gauntlet w2-r1 Fix 4). Always rendered, shown only by CSS under
// `[data-canvas-titlebars="on"]`, so theme switches need no re-render. 28px, mono label: the door glyph
// (gold when the data is live), the widget's own title (A8.5), and the data status on the right.
import type { ReactNode } from "react";
import type { ComponentNode } from "@/core/contracts";
import { DoorGlyph } from "@/features/shell";
import { useNodeEnv } from "./context";
import type { NodeStatus, PageScope } from "./resolve";

const STATUS: Record<NodeStatus["kind"], { word: string; tone: "ok" | "warn" | "bad" | "off" } | null> = {
  none: null,
  ok: { word: "live", tone: "ok" },
  stale: { word: "stale", tone: "warn" },
  failed: { word: "failed", tone: "bad" },
  empty: { word: "no data", tone: "off" },
  loading: { word: "loading", tone: "off" },
  not_shared: { word: "not shared", tone: "off" },
  not_available: { word: "off", tone: "off" },
};

/**
 * The words in a widget's title bar (A8.5): its own title, never the app slug or a source's template name.
 * With no title the bar draws no text, unless "Show title bar" is on: then it falls back to what the
 * widget shows in words (`fallback`, such as a card's title or a stat's label).
 */
export function titleText(node: ComponentNode, fallback?: string): string {
  const own = node.title?.trim();
  if (own) return own;
  return node.showTitle === true ? (fallback?.trim() || "") : "";
}

/** @deprecated Kept for callers that still ask for the old `app / thing` path; it now returns the title text (A8.5). */
export function titlePath(node: ComponentNode, _scope: PageScope, fallback?: string): string {
  return titleText(node, fallback);
}

/**
 * The bar. `status` replaces the node's own (a card passes its children's rolled-up status, Fix 4);
 * `word` replaces the status word and tone (a shape mismatch, Fix 14); `extra` sits before the status
 * (a chart's legend, Fix 6).
 */
export function NodeTitleBar({ fallback, status: given, word, extra }: { fallback?: string; status?: NodeStatus; word?: { word: string; tone: "ok" | "warn" | "bad" | "off" }; extra?: ReactNode }) {
  const env = useNodeEnv();
  const status = given ?? env.status;
  const s = word ?? STATUS[status.kind];
  // "Show title bar" off (A8.5): this widget draws no bar even when the theme has title bars.
  if (env.node.showTitle === false) return null;
  const text = titleText(env.node, fallback);
  return (
    <div className="atr-titlebar" data-slot="titlebar" data-node-titlebar data-titlebar-status={s?.word ?? ""} aria-hidden>
      <DoorGlyph lit={!word && (status.kind === "ok" || status.kind === "stale")} />
      <span className="atr-titlebar-path" data-titlebar-text={text}>{text}</span>
      {extra}
      {s ? (
        <span className="atr-titlebar-status" data-tone={s.tone}>
          <span className="atr-titlebar-dot" />
          {s.word}
        </span>
      ) : null}
    </div>
  );
}
