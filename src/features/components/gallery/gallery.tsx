"use client";
// TEMPORARY component gallery (/library/gallery): renders the catalogue with sample data so the
// components subsystem can be screenshotted and tested in a browser before app-builder mounts it.
// Controls here never reach the server: a local fake answers runs, and every run is listed.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AppDocument, ComponentNode, PageDoc, Principal, RenderContext, RenderMode } from "@/core/contracts";
import { BUILT_IN_THEMES, Button, Canvas, ControlConfirm, AppSwitcher, Screen, ScreenHeader, Window, type Theme } from "@/features/shell";
import { RenderNode } from "../render/render-node";
import { NodeCssProvider, RenderDeviceProvider, RenderEditProvider } from "../render/context";
import { pageScope } from "../page";
import { createControlRunner } from "../control-runner";
import { InspectorPanels, HtmlCodeWindow } from "../inspector/inspector";
import { evaluateTemplate } from "../bindings";
import { CORPUS, corpusScope } from "../bindings/corpus";
import { blockLogs, subscribeBlockLogs } from "../sandbox/bridge";
import { newNode } from "../insert";
import { gallerySources, GALLERY_CONTROLS, type GallerySource } from "./data";

export type GalleryProps = {
  scene: string;
  theme: "controlRoom" | "dusk" | "solid";
  mode: RenderMode;
  doc: AppDocument;
  page: PageDoc;
  css: Record<string, string>;
  principal: Principal;
  series: number;
  answer: "ok" | "refuse";
  viewer: "user" | "guest";
  guestValues?: Record<string, unknown>;
};

type Sent = { nodeId: string; controlId: string; input?: unknown; draft?: boolean; confirmed?: boolean };

function useConfirm() {
  const [req, setReq] = useState<{ text: string; resolve(ok: boolean): void } | null>(null);
  const confirm = useCallback((text: string) => new Promise<boolean>((resolve) => setReq({ text, resolve })), []);
  const dialog = (
    <ControlConfirm
      open={!!req}
      title={req?.text ?? ""}
      onConfirm={() => {
        req?.resolve(true);
        setReq(null);
      }}
      onCancel={() => {
        req?.resolve(false);
        setReq(null);
      }}
    />
  );
  return { confirm, dialog };
}

function BlockLog({ id }: { id: string }) {
  const logs = useSyncExternalStore((cb) => subscribeBlockLogs(id, cb), () => blockLogs(id), () => blockLogs(id));
  return (
    <ol className="m-0 list-none p-0" data-block-log={id}>
      {logs.map((l, i) => (
        <li key={i} data-level={l.level} className="type-caption font-mono text-fg-2">
          {l.level}: {l.message.slice(0, 400)}
        </li>
      ))}
    </ol>
  );
}

export function Gallery(p: GalleryProps) {
  const theme: Theme = BUILT_IN_THEMES[p.theme];
  const [sources, setSources] = useState<Record<string, GallerySource>>(() => gallerySources(p.series));
  const [sent, setSent] = useState<Sent[]>([]);
  const [navigated, setNavigated] = useState<string[]>([]);
  const { confirm, dialog } = useConfirm();
  const [doc, setDoc] = useState(p.doc);
  const page = doc.pages.find((x) => x.id === p.page.id) ?? p.page;
  const [selected, setSelected] = useState<string | null>(null);
  const [extra, setExtra] = useState<ComponentNode[]>([]);

  // The fake server: answers after 300ms; a successful lamp toggle shows up in the "stream" 600ms later.
  const fakeFetch = useCallback(
    async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Sent;
      setSent((s) => [...s, body]);
      await new Promise((r) => setTimeout(r, 300));
      if (p.answer === "refuse") return { status: 403, json: async () => ({ ok: false, code: "not_shared", message: "No data: this integration is no longer shared" }) };
      if (body.controlId === GALLERY_CONTROLS.lamp && typeof body.input === "boolean") {
        setTimeout(() => setSources((s) => {
          const lamps = s.lamps!.data as Extract<NonNullable<GallerySource["data"]>, { kind: "table" }>;
          return { ...s, lamps: { ...s.lamps!, data: { ...lamps, rows: lamps.rows.map((r) => (r.entity === "light.desk" ? { ...r, state: body.input ? "on" : "off" } : r)) } } };
        }), 600);
      }
      return { status: 200, json: async () => ({ ok: true, message: "Done" }) };
    },
    [p.answer],
  );
  const controls = useMemo(() => Object.fromEntries(doc.controls.map((c) => [c.id, { label: c.label, ...(c.confirm ? { confirm: c.confirm } : {}), ...(c.id === GALLERY_CONTROLS.draftOnly ? { draftOnly: true } : {}) }])), [doc.controls]);
  const runControl = useMemo(() => createControlRunner({ appId: "gallery", mode: p.mode, controls, confirm, fetch: fakeFetch }), [p.mode, controls, confirm, fakeFetch]);

  // Ticks for the motion scene: the stat counts and the chart gains a point every 2 seconds.
  useEffect(() => {
    if (p.scene !== "motion") return;
    const h = setInterval(() => {
      setSources((s) => {
        const cpu = s.cpu!.data as { kind: "stat"; value: number; label: string };
        const load = s.load!.data as Extract<NonNullable<GallerySource["data"]>, { kind: "series" }>;
        const t = load.series[0]!.points.at(-1)![0] + 300_000;
        return {
          ...s,
          cpu: { ...s.cpu!, data: { ...cpu, value: Math.round((cpu.value + 7.3) % 100 * 10) / 10 } },
          load: { ...s.load!, data: { ...load, series: load.series.map((x, i) => ({ ...x, points: [...x.points.slice(1), [t, 30 + ((t / 300_000 + i * 5) % 40)] as [number, number | null]] })) } },
        };
      });
    }, 2000);
    return () => clearInterval(h);
  }, [p.scene]);

  const values = useMemo(() => {
    const live = { ...sources } as Record<string, GallerySource>;
    const scope = pageScope({ doc, page, appId: "gallery", appSlug: "gallery", viewer: { kind: p.viewer, name: p.viewer === "guest" ? "Guest room" : "Tristan" }, sources: live as never, signedUrls: {}, ...(p.guestValues ? { guest: p.guestValues } : {}), draftOnlyControls: [GALLERY_CONTROLS.draftOnly] });
    if (p.scene === "unavailable") scope.$available = false;
    return scope;
  }, [sources, doc, page, p.viewer, p.guestValues, p.scene]);

  const ctx: RenderContext = useMemo(
    () => ({
      mode: p.scene === "inspector" ? "edit" : p.mode,
      principal: p.viewer === "guest" ? { kind: "guest", guestLinkId: "g_gallery", appId: "gallery", label: "Guest room", via: "guest-link" } : p.principal,
      appId: "gallery",
      pageId: page.id,
      version: "draft",
      values,
      runControl,
      confirm,
      navigate: (target) => setNavigated((n) => [...n, "pageId" in target ? target.pageId : target.href]),
    }),
    [p.mode, p.scene, p.viewer, p.principal, page.id, values, runControl, confirm],
  );

  const root = useMemo<ComponentNode>(() => (extra.length ? { ...page.root, children: [...(page.root.children ?? []), ...extra] } : page.root), [page.root, extra]);
  const selectedNode = useMemo(() => {
    let hit: ComponentNode | null = null;
    const walk = (n: ComponentNode) => {
      if (n.id === selected) hit = n;
      n.children?.forEach(walk);
    };
    walk(page.root);
    return hit as ComponentNode | null;
  }, [page.root, selected]);

  const patchNode = (nodeId: string, patch: Partial<ComponentNode>) => {
    const walk = (n: ComponentNode): ComponentNode => (n.id === nodeId ? { ...n, ...patch } : n.children ? { ...n, children: n.children.map(walk) } : n);
    setDoc((d) => ({ ...d, pages: d.pages.map((pg) => (pg.id === page.id ? { ...pg, root: walk(pg.root) } : pg)) }));
  };

  const canvas = (
    <Canvas theme={theme} className="!min-h-0" data-gallery-canvas={p.theme}>
      <div className="p-6 max-sm:p-4">
        <NodeCssProvider css={p.css}>
          <RenderDeviceProvider device="auto">
            {p.scene === "inspector" ? (
              <EditCanvas root={root} ctx={ctx} onSelect={setSelected} selected={selected} />
            ) : (
              <RenderNode node={root} ctx={ctx} />
            )}
          </RenderDeviceProvider>
        </NodeCssProvider>
      </div>
    </Canvas>
  );

  if (p.scene === "bindings") return <BindingsHarness />;

  return (
    <Screen>
      <ScreenHeader title="Component gallery" lead={`Scene: ${p.scene}. Sample data only; controls answer locally.`} />
      <div className={p.scene === "inspector" ? "mt-8 grid gap-6 lg:grid-cols-[1fr_320px]" : "mt-8"} data-gallery-scene={p.scene}>
        <div className="min-w-0 flex flex-col gap-6">
          {canvas}
          {p.scene === "inspector" && selectedNode?.type === "html" ? <HtmlCodeWindow node={selectedNode} onChange={(patch) => patchNode(selectedNode.id, patch as Partial<ComponentNode>)} /> : null}
        </div>
        {p.scene === "inspector" ? (
          <aside className="border border-line-strong bg-bg-hi" data-gallery-inspector>
            {selectedNode ? <InspectorPanels node={selectedNode} doc={doc} ctx={ctx} onChange={(patch) => patchNode(selectedNode.id, patch as Partial<ComponentNode>)} /> : <p className="type-body p-4 text-fg-2">Select a component.</p>}
          </aside>
        ) : null}
      </div>
      {p.scene === "motion" ? (
        <Button variant="secondary" className="mt-4" data-add-component onClick={() => setExtra((e) => [...e, { ...newNode("stat"), props: { data: { $bind: "{{ temp }}" } }, slot: { x: 0, y: 200 + e.length * 17, w: 4, h: 16 } }])}>
          Add a component
        </Button>
      ) : null}
      <Window title="gallery / runs" className="mt-8" small>
        <ol className="m-0 list-none p-0" data-sent-runs={sent.length}>
          {sent.map((s, i) => (
            <li key={i} className="type-caption font-mono text-fg-2" data-sent={JSON.stringify(s)}>
              {JSON.stringify(s)}
            </li>
          ))}
        </ol>
        <p className="type-caption font-mono text-fg-2" data-navigated={navigated.join(",")}>
          navigated: {navigated.join(", ") || "none"}
        </p>
        {["sandbox", "all", "guest", "motion"].includes(p.scene) ? (
          <div className="flex flex-col gap-2" data-block-logs>
            {(page.root.children ?? []).filter((c) => c.type === "html").map((c) => (
              <div key={c.id}>
                <span className="type-label text-fg">{c.name}</span>
                <BlockLog id={c.id} />
              </div>
            ))}
          </div>
        ) : null}
      </Window>
      {dialog}
      {p.scene === "css" ? <AppSwitcher viewer="user" currentSlug="gallery" apps={[{ slug: "gallery", name: "Gallery" }]} /> : null}
    </Screen>
  );
}

function EditCanvas({ root, ctx, onSelect, selected }: { root: ComponentNode; ctx: RenderContext; onSelect(id: string): void; selected: string | null }) {
  return (
    <RenderEditProvider onSelect={onSelect} selectedId={selected ?? undefined}>
      <RenderNode node={root} ctx={ctx} />
    </RenderEditProvider>
  );
}

/** Evaluates the shared corpus in the browser for the server/browser comparison (criterion 17). */
function BindingsHarness() {
  const [out, setOut] = useState("");
  const ref = useRef(false);
  useEffect(() => {
    if (ref.current) return;
    ref.current = true;
    setOut(JSON.stringify(CORPUS.map((t) => evaluateTemplate(t, corpusScope()))));
  }, []);
  return (
    <Screen>
      <ScreenHeader title="Binding corpus" lead={`${CORPUS.length} templates evaluated in this browser.`} />
      <pre className="type-caption mt-6 whitespace-pre-wrap break-all font-mono text-fg-2" data-corpus-result={out ? "ready" : "pending"}>
        {out}
      </pre>
    </Screen>
  );
}

