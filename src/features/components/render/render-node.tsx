"use client";
// RenderNode (architecture v3 4.4, amendment A4.2): renders a node tree with bindings, visibility,
// mobile overrides, style overrides and node CSS, library instances and HTML blocks.
//
//   <Canvas theme={theme} customCss={scoped}>
//     <NodeCssProvider css={compileDocumentCss(doc, pageId)}>     // server-compiled node CSS
//       <RenderNode node={page.root} ctx={ctx} />
//     </NodeCssProvider>
//   </Canvas>
//
// The outermost RenderNode becomes the render root: it measures its own width (phones under 640px,
// unless RenderDeviceProvider forces a device), ticks $now each second only when the tree reads it,
// and, for signed-in editors, asks the server to compile CSS for nodes edited since the page loaded.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import "../components.css";
import type { ComponentNode, PropValue, RenderContext } from "@/core/contracts";
import { transitionFor, useReducedMotion } from "@/features/shell";
import { isBinding, sourcesInTemplate, templatesIn, usesNow, type PropError } from "../bindings";
import { getComponentDef } from "../catalogue/defs";
import { NOT_CONNECTED, sampleProps } from "../catalogue/samples";
import { expandInstance } from "../library-instance";
import { lineDataKey } from "../page";
import { compileNodeStylesAction } from "../actions";
import { isLayoutType } from "../style/node-css-policy";
import { DeviceContext, EditContext, NodeContext, NodeCssContext, RootContext, ScopeContext, type NodeEnv, type RootEnv } from "./context";
import { effectiveNode, hiddenOnDevice, instanceComponent, instanceScope, nodeStatus, nodeVisible, resolveProps, valueKey, withDefaults, type Device, type NodeStatus, type PageScope } from "./resolve";

/** Every template in a tree reads $now? (props, mobile props and visibility rules). */
export function treeUsesNow(n: ComponentNode): boolean {
  const ts = [...templatesIn(n.props as PropValue, ""), ...templatesIn((n.responsive?.mobile?.props ?? {}) as PropValue, "")];
  if (ts.some((t) => usesNow(t.template))) return true;
  if (isBinding(n.visibleWhen) && usesNow(n.visibleWhen.$bind)) return true;
  return (n.children ?? []).some(treeUsesNow);
}

function styleSig(n: ComponentNode): string {
  return JSON.stringify([n.overrideTheme ?? false, n.style ?? null, n.css ?? null, n.responsive?.mobile?.style ?? null]);
}
// CSS saved on a layout is ignored (final pass, w2-r3 item 3), so it does not make the layout "styled".
const isStyled = (n: ComponentNode) => (!!n.css && !isLayoutType(n.type)) || (!!n.overrideTheme && (!!n.style || !!n.responsive?.mobile?.style));

export function RenderNode({ node, ctx }: { node: ComponentNode; ctx: RenderContext }) {
  const root = useContext(RootContext);
  const parent = useContext(ScopeContext);
  if (root && parent) return <NodeView node={node} ctx={ctx} scope={parent.scope} path={parent.path} />;
  return <RenderRoot node={node} ctx={ctx} />;
}

function RenderRoot({ node, ctx }: { node: ComponentNode; ctx: RenderContext }) {
  const forced = useContext(DeviceContext);
  const provided = useContext(NodeCssContext);
  const edit = useContext(EditContext);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [mountedAt] = useState(() => Date.now());
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  const device: Device = forced !== "auto" ? forced : width !== null && width < 640 ? "mobile" : "desktop";

  // $now ticks once a second only when the page reads it (spec 3.2.2, criterion 18).
  const needsNow = useMemo(() => treeUsesNow(node), [node]);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!needsNow) return;
    setNow(Date.now());
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [needsNow]);
  const [tz] = useState(() => -new Date().getTimezoneOffset());
  const scope = useMemo<PageScope>(() => {
    const base = ctx.values as PageScope;
    return { ...base, ...(base.$tzOffsetMin === undefined ? { $tzOffsetMin: tz } : {}), ...(needsNow && now !== null ? { $now: now } : {}) };
  }, [ctx.values, needsNow, now, tz]);

  // Node CSS: the server-compiled map, plus live compiles for nodes edited since (signed-in users only).
  const [local, setLocal] = useState<Record<string, { sig: string; css: string }>>({});
  const queue = useRef(new Map<string, ComponentNode>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canCompile = ctx.principal.kind === "user";
  const requestCss = useCallback(
    (n: ComponentNode) => {
      if (!canCompile) return;
      queue.current.set(n.id, n);
      if (timer.current) return;
      timer.current = setTimeout(async () => {
        timer.current = null;
        const batch = [...queue.current.values()];
        queue.current.clear();
        try {
          const out = await compileNodeStylesAction(batch.map((b) => ({ id: b.id, type: b.type, style: b.style, css: b.css, overrideTheme: b.overrideTheme, responsive: b.responsive })));
          setLocal((prev) => {
            const next = { ...prev };
            for (const b of batch) next[b.id] = { sig: styleSig(b), css: out[b.id]?.css ?? "" };
            return next;
          });
        } catch {
          /* the node renders with the theme only */
        }
      }, 150);
    },
    [canCompile],
  );
  const env = useMemo<RootEnv>(() => {
    const css: Record<string, string> = { ...(provided ?? {}) };
    for (const [id, v] of Object.entries(local)) css[id] = v.css;
    return { device, mountedAt, css, requestCss, onSelect: edit?.onSelect, selectedId: edit?.selectedId };
  }, [device, mountedAt, provided, local, requestCss, edit?.onSelect, edit?.selectedId]);
  const sigs = useRef(local);
  sigs.current = local;

  return (
    <RootContext.Provider value={env}>
      <LocalSigContext.Provider value={sigs}>
        <div ref={ref} className="atr-render-root" data-device={device} data-render-mode={ctx.mode}>
          <NodeView node={node} ctx={ctx} scope={scope} path="" />
        </div>
      </LocalSigContext.Provider>
    </RootContext.Provider>
  );
}

/**
 * "Choose a data source" on a sample: the inspector (InspectorPanels) opens its Data group and focuses
 * the source picker for that node. The request is kept until the inspector for that node mounts.
 */
let pendingSourceChoice: string | null = null;
export const SOURCE_CHOICE_EVENT = "atrium:choose-source";
export function requestSourceChoice(nodeId: string): void {
  pendingSourceChoice = nodeId;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SOURCE_CHOICE_EVENT, { detail: { nodeId } }));
}
export function takeSourceChoice(nodeId: string): boolean {
  if (pendingSourceChoice !== nodeId) return false;
  pendingSourceChoice = null;
  return true;
}

/** The sources in `failing` that a node reads through its props, phone props or visibleWhen. */
function readFailures(node: ComponentNode, failing: Record<string, string>): string[] {
  const temps = [...templatesIn(node.props as never, "props"), ...(node.responsive?.mobile?.props ? templatesIn(node.responsive.mobile.props as never, "props") : [])];
  const names = new Set(temps.flatMap((t) => sourcesInTemplate(t.template)));
  if (isBinding(node.visibleWhen)) for (const n of sourcesInTemplate(node.visibleWhen.$bind)) names.add(n);
  return [...names].filter((n) => Object.prototype.hasOwnProperty.call(failing, n));
}

const LocalSigContext = createContext<React.RefObject<Record<string, { sig: string; css: string }>> | null>(null);

function guestProps(node: ComponentNode, eff: ComponentNode, scope: PageScope, path: string, device: Device): Record<string, unknown> {
  const g = scope.$guest ?? {};
  const out: Record<string, unknown> = { ...withDefaults(eff) };
  const mobileProps = device === "mobile" ? node.responsive?.mobile?.props ?? {} : {};
  for (const [k, v] of Object.entries(eff.props)) {
    if (k === "data" && node.type === "html") continue;
    if (!templatesIn(v as PropValue, k).length) continue;
    // A10.2: a chart line's data comes under its own key; its name, colour and hidden flag are literals.
    if (k === "lines" && node.type === "chart" && Array.isArray(v)) {
      const mobile = Object.prototype.hasOwnProperty.call(mobileProps, k) ? "@mobile" : "";
      out[k] = v.map((ln, i) => (ln && typeof ln === "object" && !Array.isArray(ln) ? { ...(ln as object), data: g[valueKey(node.id, `${lineDataKey(i)}${mobile}`, path)] } : ln));
      continue;
    }
    const key = valueKey(node.id, Object.prototype.hasOwnProperty.call(mobileProps, k) ? `${k}@mobile` : k, path);
    out[k] = g[key];
  }
  return out;
}

function NodeView(props: { node: ComponentNode; ctx: RenderContext; scope: PageScope; path: string }): ReactNode {
  // Library instances render their saved subtree with $param bound to the instance.
  if (props.node.type.startsWith("lib:")) return <InstanceView {...props} />;
  return <PlainNodeView {...props} />;
}

function PlainNodeView({ node, ctx, scope, path }: { node: ComponentNode; ctx: RenderContext; scope: PageScope; path: string }): ReactNode {
  const root = useContext(RootContext)!;
  const sigs = useContext(LocalSigContext);
  const reduced = useReducedMotion();
  const device = root.device;
  const edit = ctx.mode === "edit";
  const guest = !!scope.$guest;

  // CSS: the server map, or a live compile when this node changed since the page loaded.
  const styled = isStyled(node);
  const local = sigs?.current?.[node.id];
  const sig = styled ? styleSig(node) : "";
  const stale = styled && (local ? local.sig !== sig : !root.css[node.id] && ctx.principal.kind === "user");
  useEffect(() => {
    if (stale) root.requestCss(node);
  });
  const css = styled ? (local && local.sig === sig ? local.css : local ? "" : root.css[node.id] ?? "") : "";

  const vis = guest ? (node.visibleWhen ? { visible: scope.$guest![valueKey(node.id, "$visible", path)] !== false } : { visible: true }) : nodeVisible(node, scope);
  const offDevice = hiddenOnDevice(node, device);
  if ((!vis.visible || offDevice) && !edit) return null;

  const eff = effectiveNode(node, device);
  let resolved: Record<string, unknown>;
  let errors: PropError[] = [];
  let status: NodeStatus;
  if (guest) {
    resolved = guestProps(node, eff, scope, path, device);
    status = (scope.$guest![valueKey(node.id, "$status", path)] as NodeStatus | undefined) ?? { kind: "none" };
  } else {
    const r = resolveProps(eff, scope);
    resolved = r.props;
    errors = r.errors;
    if (vis.error) errors = [...errors, { prop: "visibleWhen", error: vis.error }];
    status = nodeStatus(eff, scope);
  }

  // A data component that is not connected yet shows sample values in the builder (marked "sample")
  // and the designed empty state everywhere else (gauntlet w2-r1 Fix 7).
  const sample = sampleProps(eff);
  if (sample && edit) {
    resolved = { ...resolved, ...sample };
    status = { kind: "none" };
  } else if (sample) status = { kind: "empty", message: NOT_CONNECTED };

  // A9.2 (recipes spec 3.2): in the builder, a widget bound to a read that failed its live check gets a
  // small warning mark. The builder passes the failing sources as $failingReads (name to reason).
  const failingReads = edit ? (scope as { $failingReads?: Record<string, string> }).$failingReads : undefined;
  const failedSources = failingReads && Object.keys(failingReads).length ? readFailures(node, failingReads) : [];

  const def = getComponentDef(node.type);
  const env: NodeEnv = {
    node: eff,
    scope,
    path,
    status,
    errors,
    ctx,
    device,
    renderChild: (child, opts = {}) => <NodeView key={opts.key ?? child.id} node={child} ctx={ctx} scope={opts.scope ? ({ ...scope, ...opts.scope } as PageScope) : scope} path={opts.path ?? path} />,
  };
  // Only components added after the page first rendered fade in with `settle` (criterion 69).
  const animateIn = Date.now() - root.mountedAt > 600;
  const Comp = def?.Component as ((p: { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext }) => ReactNode) | undefined;
  const hiddenTag = !vis.visible ? "hidden" : offDevice ? (device === "mobile" ? "hidden on phones" : "hidden") : null;
  return (
    <motion.div
      data-node={node.id}
      data-type={node.type}
      className="atr-node"
      data-node-styled={styled ? "" : undefined}
      data-sample={sample && edit ? "" : undefined}
      data-hidden-node={hiddenTag ? "" : undefined}
      data-hidden-device={offDevice && edit ? device : undefined}
      data-selected={root.selectedId === node.id ? "" : undefined}
      data-new-node={animateIn ? "" : undefined}
      initial={animateIn ? { opacity: 0, y: reduced ? 0 : 8 } : false}
      animate={{ opacity: hiddenTag ? 0.45 : 1, y: 0 }}
      transition={transitionFor("settle", reduced)}
      onClick={
        edit && root.onSelect
          ? (e) => {
              e.stopPropagation();
              e.preventDefault();
              root.onSelect!(node.id);
            }
          : undefined
      }
    >
      {css ? <style data-node-css={node.id}>{css}</style> : null}
      {edit && hiddenTag ? <span className="atr-hidden-tag">{hiddenTag}</span> : null}
      {edit && errors.length ? (
        <span className="atr-binding-warning" role="note" data-binding-warning title={errors.map((e) => `${e.prop}: ${e.error.message}`).join("\n")}>
          <span aria-hidden>!</span>
          <span className="sr-only">{errors.map((e) => `${e.prop}: ${e.error.message}`).join(". ")}</span>
          <span className="atr-binding-warning-text">{errors[0]!.error.message}</span>
        </span>
      ) : edit && failedSources.length ? (
        <span className="atr-binding-warning" role="note" data-read-warning={failedSources.join(" ")} title={failedSources.map((n) => `${n}: ${failingReads![n]}`).join("\n")}>
          <span aria-hidden>!</span>
          <span className="sr-only">{`This read stopped working: ${failedSources.map((n) => failingReads![n]).join(". ")}`}</span>
          <span className="atr-binding-warning-text">Read stopped working</span>
        </span>
      ) : null}
      <ScopeContext.Provider value={{ scope, path }}>
        <NodeContext.Provider value={env}>
          {Comp ? <Comp node={eff} resolved={resolved} ctx={ctx} /> : <div data-slot="root" className="atr-unknown canvas-surface">This component type is not installed: {node.type}</div>}
        </NodeContext.Provider>
      </ScopeContext.Provider>
      {sample && edit ? (
        <span className="atr-sample-bar" data-sample-bar>
          <span className="atr-sample-tag" data-sample-tag>Sample data</span>
          <button
            type="button"
            className="atr-sample-action"
            data-choose-source
            // The builder selects on a capturing click and stops it there, so the request is made on
            // pointer down (and on Enter or Space); the click then selects the node as usual.
            onPointerDown={() => requestSourceChoice(node.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") requestSourceChoice(node.id);
            }}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              requestSourceChoice(node.id);
              root.onSelect?.(node.id);
            }}
          >
            Choose a data source
          </button>
        </span>
      ) : null}
    </motion.div>
  );
}

function InstanceView({ node, ctx, scope, path }: { node: ComponentNode; ctx: RenderContext; scope: PageScope; path: string }) {
  const root = useContext(RootContext)!;
  const lib = instanceComponent(node, scope);
  const offDevice = hiddenOnDevice(node, root.device);
  if (offDevice && ctx.mode !== "edit") return null;
  if (!lib) {
    return (
      <div data-node={node.id} data-type={node.type} className="atr-node">
        <div data-slot="root" className="atr-unknown canvas-surface">This library component is missing.</div>
      </div>
    );
  }
  const inner = expandInstance(node, lib);
  const innerScope = scope.$guest ? scope : instanceScope(node, lib, scope);
  return (
    <div data-node={node.id} data-type={node.type} data-node-styled={isStyled(node) ? "" : undefined} data-library={lib.id} data-library-version={lib.version} className="atr-node atr-instance">
      <NodeView node={inner} ctx={ctx} scope={innerScope} path={path} />
    </div>
  );
}
