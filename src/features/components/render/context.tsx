"use client";
// Render-time contexts shared by RenderNode and the component implementations.
import { createContext, useContext, type ReactNode } from "react";
import type { ComponentNode, RenderContext } from "@/core/contracts";
import type { PropError } from "../bindings";
import type { Device, NodeStatus, PageScope } from "./resolve";

export type RootEnv = {
  device: Device;
  mountedAt: number;
  /** Scoped node CSS by node id (compiled on the server). */
  css: Record<string, string>;
  /** Asks the server to compile CSS for nodes that have none yet (the builder's live edits). */
  requestCss(node: ComponentNode): void;
  /** Called when a node is clicked in edit mode (the builder selects it). */
  onSelect?: (nodeId: string) => void;
  selectedId?: string;
};

export type NodeEnv = {
  node: ComponentNode;
  scope: PageScope;
  path: string;
  status: NodeStatus;
  errors: PropError[];
  ctx: RenderContext;
  device: Device;
  /** Renders a child node with an optional scope extension (repeat items) and path suffix. */
  renderChild(child: ComponentNode, opts?: { scope?: Partial<PageScope>; path?: string; key?: string }): ReactNode;
};

export const RootContext = createContext<RootEnv | null>(null);
export const NodeContext = createContext<NodeEnv | null>(null);
export const ScopeContext = createContext<{ scope: PageScope; path: string } | null>(null);

export function useNodeEnv(): NodeEnv {
  const env = useContext(NodeContext);
  if (!env) throw new Error("useNodeEnv outside a node");
  return env;
}

export function useRootEnv(): RootEnv | null {
  return useContext(RootContext);
}

/** Forces the device (the builder's desktop and mobile toggle); otherwise the render root measures its width. */
export const DeviceContext = createContext<Device | "auto">("auto");
export function RenderDeviceProvider({ device, children }: { device: Device | "auto"; children: ReactNode }) {
  return <DeviceContext.Provider value={device}>{children}</DeviceContext.Provider>;
}

/** Server-compiled node CSS (compileDocumentCss from "@/features/components/server"). */
export const NodeCssContext = createContext<Record<string, string> | null>(null);
export function NodeCssProvider({ css, children }: { css: Record<string, string>; children: ReactNode }) {
  return <NodeCssContext.Provider value={css}>{children}</NodeCssContext.Provider>;
}

/** Builder hooks: selection in edit mode. */
export const EditContext = createContext<{ onSelect?: (nodeId: string) => void; selectedId?: string } | null>(null);
export function RenderEditProvider({ onSelect, selectedId, children }: { onSelect?: (nodeId: string) => void; selectedId?: string; children: ReactNode }) {
  return <EditContext.Provider value={{ onSelect, selectedId }}>{children}</EditContext.Provider>;
}
