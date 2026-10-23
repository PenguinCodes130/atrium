"use client";
// HtmlBlockHost (architecture v3 4.7 and 13, spec 3.5): renders the sandboxed frame and runs the host
// side of the bridge. The frame is <iframe sandbox="allow-scripts" src="/sandbox/frame">; the host
// sends a MessageChannel port in its first message and from then on listens ONLY on that port.
// On a second load of the frame the host removes it, never sends a port again, and shows "This block
// tried to leave the sandbox". Control requests go through ctx.runControl (which owns the confirm
// rules), so a block can never mark a draft-preview run as confirmed.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentNode, HostToFrame, RenderContext } from "@/core/contracts";
import { useNodeEnv } from "./context";
import { valueKey } from "./resolve";
import { BUNDLED_LIBS } from "../sandbox/frame-doc";
import { CONTROL_LIMIT, MAX_IMAGE_BYTES, handleFrameMessage, pushBlockLog, startBlockRun, type BridgeState } from "../sandbox/bridge";

type P = { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext };

export const ESCAPE_MESSAGE = "This block tried to leave the sandbox";
export const DATA_NOTICE = "Data you give this block is visible to whoever wrote its code.";

const THEME_VARS = ["surface", "surface-text", "surface-muted", "canvas-text", "accent", "accent-text", "ok", "warn", "bad", "info", "line", "radius", "gap", "pad", "font-body", "font-display", "font-mono", "border-color", "border-width"];

function readTheme(el: Element | null): Record<string, string> {
  if (!el) return {};
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const k of THEME_VARS) {
    const v = cs.getPropertyValue(`--theme-${k}`).trim();
    if (v) out[`--theme-${k}`] = v.slice(0, 300);
  }
  return out;
}

async function toDataUrl(path: string): Promise<{ url: string; bytes: number } | null> {
  try {
    const res = await fetch(path, { credentials: "same-origin" });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/^image\/(png|jpeg|webp|gif|avif|svg\+xml)/.test(type)) return null;
    const blob = await res.blob();
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("read"));
      r.readAsDataURL(blob);
    });
    return { url, bytes: blob.size };
  } catch {
    return null;
  }
}

/**
 * A7.6 "fill": the block is as tall as the window below what sits above it (the app's navigation; the
 * whole window when the navigation is None), tracking resizes. The window is the closest
 * `[data-app-viewport]` scroll area (the builder canvas) or the browser window (the viewer). A builder
 * canvas drawn scaled (Preview width) is measured in page px, not screen px.
 */
function useFillHeight(ref: React.RefObject<HTMLElement | null>, on: boolean): number {
  const [h, setH] = useState(480);
  useEffect(() => {
    if (!on) return;
    const el = ref.current;
    if (!el) return;
    const port = el.closest("[data-app-viewport]") as HTMLElement | null;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const scale = el.offsetWidth > 0 ? r.width / el.offsetWidth || 1 : 1;
      const viewTop = port ? port.getBoundingClientRect().top - port.scrollTop : -window.scrollY;
      const viewH = port ? port.clientHeight : document.documentElement.clientHeight;
      const top = r.top - viewTop;
      // The page's own bottom padding stays below the block, so the page fits without scrolling.
      const main = el.closest("main[data-app-page]");
      const below = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      const next = Math.max(20, Math.floor((viewH - top) / scale - below));
      setH((cur) => (Math.abs(cur - next) >= 1 ? next : cur));
    };
    const soon = () => { if (!raf) raf = window.requestAnimationFrame(measure); };
    measure();
    const ro = new ResizeObserver(soon);
    ro.observe(port ?? document.documentElement);
    const frame = el.closest("[data-atrium-app-frame]");
    if (frame) ro.observe(frame);
    window.addEventListener("resize", soon);
    return () => { ro.disconnect(); window.removeEventListener("resize", soon); if (raf) window.cancelAnimationFrame(raf); };
  }, [ref, on]);
  return h;
}

export function HtmlBlockView(props: P) {
  const r = props.resolved;
  // New code means a fresh frame (and a fresh load count): the old document is never re-used.
  const codeKey = JSON.stringify([r.html ?? "", r.css ?? "", r.js ?? "", r.libs ?? [], r.images ?? []]);
  return <SandboxFrame key={codeKey} {...props} />;
}

function SandboxFrame({ node, resolved, ctx }: P) {
  const env = useNodeEnv();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const loads = useRef(0);
  const connects = useRef(0);
  const [escaped, setEscaped] = useState(false);
  const [height, setHeight] = useState<number>(typeof resolved.height === "number" ? resolved.height : 120);
  const [imageError, setImageError] = useState<string | null>(null);
  const isGuest = ctx.principal.kind === "guest";
  // The frame is created only after hydration, so its load event is never missed.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // What the block may see: its resolved data map (for guests, the server-resolved map only).
  const data = useMemo(() => {
    if (env.scope.$guest) return (env.scope.$guest[valueKey(node.id, "data", env.path)] ?? {}) as Record<string, unknown>;
    return (resolved.data && typeof resolved.data === "object" ? resolved.data : {}) as Record<string, unknown>;
  }, [env.scope.$guest, env.path, node.id, resolved.data]);
  const dataJson = JSON.stringify(data);

  const listed = useMemo(() => (Array.isArray(resolved.controls) ? (resolved.controls as unknown[]).filter((c): c is string => typeof c === "string") : []), [resolved.controls]);
  const state = useRef<BridgeState>({ listed: [], inDocument: [], pages: [], height: "auto", recent: [] });
  state.current.listed = listed;
  state.current.inDocument = Object.keys(env.scope.$controls ?? {});
  state.current.pages = (env.scope.$pages ?? []).map((p) => ({ id: p.id, slug: p.slug }));
  const fill = resolved.height === "fill";
  const rootRef = useRef<HTMLDivElement>(null);
  const fillPx = useFillHeight(rootRef, fill);
  state.current.height = fill ? fillPx : resolved.height === "auto" || resolved.height === undefined ? "auto" : (resolved.height as number);

  const send = (m: HostToFrame) => {
    try {
      portRef.current?.postMessage(m);
    } catch {
      /* closed */
    }
  };

  // Images arrive in the frame as inline data, 2 MB in total.
  const images = useMemo(() => (Array.isArray(resolved.images) ? (resolved.images as unknown[]).filter((s): s is string => typeof s === "string" && s.startsWith("/uploads/")) : []), [resolved.images]);
  const imagesKey = images.join("|");
  const imageData = useRef<Promise<Record<string, string>> | null>(null);
  useEffect(() => {
    imageData.current = (async () => {
      const out: Record<string, string> = {};
      let total = 0;
      for (const p of images) {
        const r = await toDataUrl(p);
        if (!r) continue;
        total += r.bytes;
        if (total > MAX_IMAGE_BYTES) {
          setImageError("This block's images are over the 2 MB limit; the rest were not sent.");
          break;
        }
        out[p] = r.url;
      }
      return out;
    })();
  }, [imagesKey]);

  async function onMessage(e: MessageEvent) {
    const action = handleFrameMessage(e.data, state.current, Date.now());
    switch (action.kind) {
      case "ready": {
        startBlockRun(node.id);
        const libs = ((resolved.libs as string[] | undefined) ?? []).map((l) => BUNDLED_LIBS[l]).filter((x): x is string => !!x);
        const missing = ((resolved.libs as string[] | undefined) ?? []).filter((l) => !BUNDLED_LIBS[l]);
        if (missing.length) pushBlockLog(node.id, { at: Date.now(), level: "warn", message: `Not bundled in this Atrium yet: ${missing.join(", ")}` });
        const imgs = (await imageData.current) ?? {};
        send({
          t: "init",
          html: String(resolved.html ?? ""),
          css: String(resolved.css ?? ""),
          js: String(resolved.js ?? ""),
          libs: libs.map((l) => `${window.location.origin}${l}`),
          images: imgs,
          data,
          theme: readTheme(frameRef.current),
          viewer: { kind: isGuest ? "guest" : "user" },
        });
        return;
      }
      case "resize":
        setHeight(action.height);
        return;
      case "control": {
        const res = await ctx.runControl(node.id, action.controlId, action.input);
        send({ t: "controlResult", reqId: action.reqId, ok: res.ok, ...(res.message ? { message: res.message } : {}) });
        return;
      }
      case "navigate":
        if (ctx.mode !== "edit") ctx.navigate({ pageId: action.pageId });
        return;
      case "log":
        pushBlockLog(node.id, { at: Date.now(), level: action.level, message: action.message });
        return;
      default:
        return;
    }
  }
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  function onLoad() {
    loads.current += 1;
    if (loads.current > 1) {
      // The frame loaded a second document: remove it and never hand the new one a port.
      portRef.current?.close();
      portRef.current = null;
      setEscaped(true);
      pushBlockLog(node.id, { at: Date.now(), level: "error", message: ESCAPE_MESSAGE });
      return;
    }
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const ch = new MessageChannel();
    portRef.current = ch.port1;
    ch.port1.onmessage = (ev) => void onMessageRef.current(ev);
    // The frame's origin is opaque, so "*" is the only target that reaches it; the port is the channel.
    win.postMessage({ t: "connect" }, "*", [ch.port2]);
    connects.current += 1;
  }

  // Data and theme updates reach a running block as they change.
  useEffect(() => {
    send({ t: "data", data: JSON.parse(dataJson) as Record<string, unknown> });
  }, [dataJson]);
  useEffect(() => {
    let last = "";
    const h = setInterval(() => {
      const t = readTheme(frameRef.current);
      const s = JSON.stringify(t);
      if (last && s !== last) send({ t: "theme", theme: t });
      last = s;
    }, 400);
    return () => clearInterval(h);
  }, []);
  useEffect(() => () => portRef.current?.close(), []);

  const title = node.name?.trim() || "HTML block";
  const fixed = typeof resolved.height === "number";
  const boxH = fill ? fillPx : fixed ? (resolved.height as number) : undefined;
  if (escaped) {
    return (
      <div data-slot="root" className="atr-html-escaped" role="alert" data-sandbox-escape data-loads={loads.current} data-connects={connects.current}>
        {ESCAPE_MESSAGE}
      </div>
    );
  }
  return (
    <div ref={rootRef} data-slot="root" className="atr-html" style={{ minHeight: boxH, ...(fill ? { height: boxH } : {}) }} data-html-fill={fill ? fillPx : undefined}>
      {mounted ? (
      <iframe
        ref={frameRef}
        title={title}
        src="/sandbox/frame"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={onLoad}
        style={{ height: boxH ?? height, pointerEvents: ctx.mode === "edit" ? "none" : undefined }}
        data-html-frame
        data-limit={`${CONTROL_LIMIT.count}/${CONTROL_LIMIT.windowMs}`}
      />
      ) : null}
      {imageError ? <p className="atr-control-msg">{imageError}</p> : null}
    </div>
  );
}
