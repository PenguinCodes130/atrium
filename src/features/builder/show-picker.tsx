"use client";
// "What should this show?" (Wave 2.9, direct-data-spec.md 3.1 and 3.2; Amendment 10, A10.4). One focused
// search box over the data catalogue: every read of every service the person may use, each with the thing
// it is about inline ("CPU in use, pve1") and its live value. Results that fit the component come first.
// With nothing typed, browse By service (service, its things, their reads) or By measure. A pick binds at
// once through a managed source (A10.1): no data source step, nothing to name. Chart lines take series
// reads or a value read's history (A10.3), and a third unit is refused with two ways out (spec 3.4).
// The Wave 2.5 to 2.8 picker stays one click away ("Set it up by hand") for data already in the app, a
// typed template, a card for each, or a read's own settings.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogueItem, CatalogueResponse, CatalogueService, ComponentNode, DataShapeKind, DraftOp, Measure, PeekResponse, PropValue, ShapedData, ValueFormat } from "@/core/contracts";
import { Button, Sheet } from "@/features/shell";
import { findNode, nodeLabel } from "@/features/apps/doc";
import type { AppDocument } from "@/core/contracts";
import { META } from "@/features/components/catalogue/meta";
import { PackageIcon } from "@/features/integrations/ui/package-icon";
import { PICK_RETURN_KEY } from "@/features/integrations/ui/return-to-builder";
import { SelectMenu } from "@/features/settings/ui/controls";
import { cardForEachOps, keyColumn, mainColumns, paramFields, repeatAround, rowFields, rowTemplate, showChoices, type ParamField } from "./data-pick";
import { formatValue } from "@/features/components/render/format";
import { liveWords, type BindableIntegration } from "./data-picker";
import { addLineOps, axisGroups, bindItemOps, chartLines, fitsFor, getAtPath, itemFits, itemWords, lineRead, propKind, setAtPath, thirdUnitRefusal, unitWords, type LineUnit, type PickItem } from "./direct-data";

/** What the picker was opened for: a node and one of its props ("data", "stats.2.value", "lines" adds a line). */
export type ShowTarget = { nodeId: string; prop: string; fromInsert?: boolean; /** Change on a bound component: its source, so "Set it up by hand" opens on it as before. */ source?: string };

type Props = {
  target: ShowTarget;
  doc: AppDocument;
  bindable: BindableIntegration[] | null;
  /** Live data of the app's sources (for a chart's existing lines' units). */
  data: Record<string, ShapedData | undefined>;
  apply(ops: DraftOp[]): void;
  onClose(): void;
  /** The Wave 2.5 picker, for what the catalogue does not cover. */
  onByHand(): void;
  /** A pick's value is shown on the canvas at once, before the stream catches up (spec 3.2: within 1 s). */
  onPeeked(name: string, data: ShapedData): void;
  /** Selects a node (a new chart made by "Put it on a new chart"). */
  onSelect?(nodeId: string): void;
  /** Makes a node id for a new component. */
  newNodeId(): string;
};

const MEASURES: { id: Measure; label: string }[] = [
  { id: "cpu", label: "CPU" }, { id: "memory", label: "Memory" }, { id: "disk", label: "Disk" }, { id: "network", label: "Network" },
  { id: "temperature", label: "Temperature" }, { id: "uptime", label: "Uptime" }, { id: "count", label: "Counts" }, { id: "status", label: "Status" },
];
const row = "flex min-h-11 w-full items-center gap-3 border border-line px-3 py-2 text-left hover:bg-bg-sunk focus-visible:outline-2 focus-visible:outline-accent-ink disabled:opacity-60";
const input = "h-11 w-full border border-line-strong bg-bg-hi px-3 type-body outline-none focus-visible:outline-2 focus-visible:outline-accent-ink";
const link = "inline-flex min-h-11 items-center px-1 type-caption underline";
const tab = "inline-flex min-h-11 items-center border px-3 type-label";

type Peeked = Record<string, { data?: ShapedData; error?: string }>;

/** The catalogue for this query (A10.4), editors only; null while loading. */
function useCatalogue(params: Record<string, string> | null): { res: CatalogueResponse | null; error: string | null } {
  const key = params ? new URLSearchParams(params).toString() : "";
  const [state, setState] = useState<{ key: string; res: CatalogueResponse | null; error: string | null }>({ key: "", res: null, error: null });
  useEffect(() => {
    if (!params) return;
    let live = true;
    const ctl = new AbortController();
    fetch(`/api/data/catalogue?${key}`, { credentials: "same-origin", signal: ctl.signal })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as (CatalogueResponse & { error?: { message?: string } }) | null;
        if (!live) return;
        if (!r.ok || !j || !Array.isArray(j.items)) setState({ key, res: null, error: j?.error?.message ?? "The list of your data could not be read." });
        else setState({ key, res: j, error: null });
      })
      .catch(() => { if (live) setState({ key, res: null, error: "Atrium could not be reached." }); });
    return () => { live = false; ctl.abort(); };
  }, [key]);
  return state.key === key ? { res: state.res, error: state.error } : { res: null, error: null };
}

/** Live values for the items on screen, through POST /api/data/peek (at most 20 per request, one service each), kept per key. */
function usePeek(items: PickItem[]): Peeked {
  const [values, setValues] = useState<Peeked>({});
  const asked = useRef(new Set<string>());
  const want = items.filter((i) => i.key && !asked.current.has(i.key) && !(i as CatalogueItem).needsSettings).slice(0, 60);
  const wantKey = want.map((i) => i.key).join("\n");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!want.length) return;
    for (const i of want) asked.current.add(i.key!);
    // One request per service, so a slow or silent service never holds the others' values (each answers
    // within its own 3 s budget). Answers are kept per key even after the search moves on: these keys are
    // never asked again, so dropping a late answer would leave its row waiting for good.
    const byService = new Map<string, PickItem[]>();
    for (const it of want) byService.set(it.integrationId, [...(byService.get(it.integrationId) ?? []), it]);
    const batches = [...byService.values()].flatMap((list) => Array.from({ length: Math.ceil(list.length / 20) }, (_, n) => list.slice(n * 20, n * 20 + 20)));
    for (const batch of batches) {
      void fetch("/api/data/peek", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: batch.map((i) => ({ integrationId: i.integrationId, endpointId: i.endpointId, params: i.params })) }) })
        .then((r) => (r.ok ? (r.json() as Promise<PeekResponse>) : null))
        .then((j) => {
          if (!mounted.current) return;
          const got: Peeked = {};
          // The answer comes back in the order asked; its keys follow the catalogue's.
          batch.forEach((it, n) => { const v = j?.values[n]; got[it.key!] = v ? { ...(v.data ? { data: v.data } : {}), ...(v.error ? { error: v.error } : {}) } : { error: "No answer." }; });
          setValues((s) => ({ ...s, ...got }));
        })
        .catch(() => { if (mounted.current) setValues((s) => ({ ...s, ...Object.fromEntries(batch.map((i) => [i.key!, { error: "No answer." }])) })); });
    }
  }, [wantKey]);
  return values;
}

/** One item's live value in words: "7.8 %", "9 rows", "3 of 4 up", or "no answer". */
function valueWords(p: Peeked[string] | undefined): { text: string; failed: boolean } | null {
  if (!p) return null;
  if (p.data) return { text: liveWords(p.data), failed: false };
  return { text: "no answer", failed: true };
}

/** The unit of a line's data: from its live data, or the read's format. */
function unitOf(d: ShapedData | undefined, fallback?: LineUnit): LineUnit {
  if (d && (d.kind === "series" || d.kind === "stat")) return { format: d.format, unit: d.unit };
  return fallback ?? {};
}

export function ShowPicker({ target, doc, bindable, data, apply, onClose, onByHand, onPeeked, onSelect, newNodeId }: Props) {
  const node = findNode(doc, target.nodeId)?.node ?? null;
  const type = node?.type ?? "stat";
  const kind = propKind(type, target.prop);
  const lineMode = kind === "line";
  const fits = fitsFor(type, target.prop);
  const fitsTitle = lineMode ? "a chart line" : kind === "status" ? "a status badge" : `a ${(META[fits as keyof typeof META]?.title ?? fits).toLowerCase()}`;
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  useEffect(() => { const t = window.setTimeout(() => setTyped(q.trim()), 200); return () => window.clearTimeout(t); }, [q]);
  const [browse, setBrowse] = useState<"service" | "measure">("service");
  const [service, setService] = useState<CatalogueService | null>(null);
  const [thing, setThing] = useState<string | null>(null);
  const [measure, setMeasure] = useState<Measure | null>(null);
  const [settingsFor, setSettingsFor] = useState<CatalogueItem | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [another, setAnother] = useState<CatalogueItem | null>(null);
  const [switchFor, setSwitchFor] = useState<PickItem | null>(null);
  const [refusal, setRefusal] = useState<{ item: PickItem; sentence: string; percent: PickItem[] | null; checking: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // What to ask the catalogue: the typed words, or the browse step.
  const query: Record<string, string> | null = typed
    ? { q: typed, fits, limit: "50" }
    : browse === "service" && service ? { integrationId: service.integrationId, fits, limit: "200" }
    : browse === "measure" && measure ? { measure, fits, limit: "100" }
    : { fits, limit: "20" };
  const { res, error } = useCatalogue(query);
  const [services, setServices] = useState<CatalogueService[] | null>(null);
  useEffect(() => { if (res && !service && !typed && !measure) setServices(res.services); }, [res]);
  const people = (services ?? []).filter((s) => s.integrationId !== "atrium");

  const items: (CatalogueItem & { fit: boolean })[] = useMemo(() => {
    if (!res) return [];
    // The catalogue ranks by the component type; a single field (a stat's value, a tile's stat) refines it here.
    return res.items.map((it, i) => ({ ...it, fit: lineMode || kind === "status" || kind === "value" ? itemFits(type, target.prop, it) : !!res.fits[i] }));
  }, [res, type, target.prop]);
  const thingsOfService = useMemo(() => {
    if (!service || typed || !res) return [];
    const m = new Map<string, { value: string; label: string; detail?: string; count: number }>();
    for (const it of res.items) {
      const k = it.thing ? `${it.thing.param}=${it.thing.value}` : "";
      const cur = m.get(k) ?? { value: k, label: it.thing?.label ?? `${service.name} itself`, ...(it.thing?.detail ? { detail: it.thing.detail } : {}), count: 0 };
      cur.count++;
      m.set(k, cur);
    }
    return [...m.values()];
  }, [res, service, typed]);
  const listed = typed ? items : browse === "service" && service && thing !== null ? items.filter((it) => (it.thing ? `${it.thing.param}=${it.thing.value}` : "") === thing) : browse === "measure" && measure ? items : [];
  const fitting = listed.filter((i) => i.fit);
  const other = listed.filter((i) => !i.fit);

  // Wave 2.10b F3: Change opens on the current choice: its service, then its thing, with its row marked
  // and scrolled into view. Runs once; browsing away afterwards is the person's own choice.
  const currentDef = target.source ? doc.dataSources.find((d) => d.name === target.source) ?? null : null;
  const startOn = useRef<"service" | "item" | "done">(currentDef ? "service" : "done");
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  useEffect(() => {
    if (!currentDef || typed || startOn.current === "done") return;
    if (startOn.current === "service") {
      if (service || !services) return;
      const s = services.find((x) => x.integrationId === currentDef.integrationId);
      startOn.current = s ? "item" : "done";
      if (s) setService(s);
      return;
    }
    // Wait for the service's own listing, not the overview still on screen.
    if (!service || !res || !res.items.length || res.items.some((it) => it.integrationId !== service.integrationId)) return;
    startOn.current = "done";
    const it = res.items.find((x) => x.endpointId === currentDef.endpointId && Object.entries(x.params).every(([k, v]) => JSON.stringify(currentDef.params?.[k]) === JSON.stringify(v)));
    if (!it) return;
    setThing(it.thing ? `${it.thing.param}=${it.thing.value}` : "");
    setCurrentKey(it.key);
  }, [currentDef, typed, service, services, res]);
  useEffect(() => {
    if (!currentKey) return;
    document.querySelector(`[data-show-item="${CSS.escape(currentKey)}"]`)?.scrollIntoView({ block: "center" });
  }, [currentKey, listed.length]);
  // Values for the first 20 rows at once, and for any further row once it scrolls into view (a long list,
  // or many services answering the same words, never leaves a row on the screen waiting).
  const [inView, setInView] = useState<ReadonlySet<string>>(() => new Set());
  const observer = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    observer.current = new IntersectionObserver((entries) => {
      const keys = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).getAttribute("data-show-item") ?? "").filter(Boolean);
      if (keys.length) setInView((cur) => (keys.every((k) => cur.has(k)) ? cur : new Set([...cur, ...keys])));
    });
    return () => { observer.current?.disconnect(); observer.current = null; };
  }, []);
  const observe = useCallback((el: HTMLElement | null) => { if (el) observer.current?.observe(el); }, []);
  const ordered = [...fitting, ...other];
  const peeked = usePeek(ordered.filter((it, i) => i < 20 || inView.has(it.key)));

  const close = () => onClose();

  // Round 2 item 11: inside a repeat, "This row" and its fields come first (the repeat passes each row as $item).
  const around = node ? repeatAround(doc, node.id) : null;
  const rowList = around?.source ? rowFields(data[around.source]) : [];
  const pickRow = (key: string, label: string) => {
    if (!node) return close();
    const bindAt = kind === "gauge" ? "value" : target.prop;
    let props = setAtPath(node.props, bindAt, { $bind: rowTemplate(key) });
    // A stat (or a tile's stat, a bar reading) with no label of its own takes the field's name.
    const labelAt = /^(stats|items)\.(\d+)\.value$/.test(target.prop) ? target.prop.replace(/value$/, "label") : bindAt === "value" && ["stat", "gauge", "progress"].includes(type) ? "label" : null;
    if (labelAt && !getAtPath(node.props, labelAt)) props = setAtPath(props, labelAt, label.slice(0, 40));
    apply([{ op: "node.update", nodeId: node.id, patch: { props } } as DraftOp]);
    close();
  };

  /** Binds an item (spec 3.2) and closes: the value shows on the canvas at once from the peek. */
  const pick = (item: PickItem, opts: { switchTo?: string } = {}) => {
    if (!node) return close();
    if ((item as CatalogueItem).needsSettings && !settingsFor) { setSettingsFor(item as CatalogueItem); setSettings({ ...item.params }); return; }
    if (lineMode) { void addLine(item); return; }
    if (!itemFits(type, target.prop, item) && !opts.switchTo) { setSwitchFor(item); return; }
    const r = bindItemOps(doc, node.id, target.prop, item, { ...(opts.switchTo ? { switchTo: opts.switchTo } : {}), title: !!target.fromInsert });
    if (!r) return;
    let ops = r.ops;
    // A new stat on a tile or a resource bar reading gets a label in words.
    const m = /^(stats|items)\.(\d+)\.value$/.exec(target.prop);
    if (m) {
      const entry = getAtPath(node.props, `${m[1]}.${m[2]}`);
      const hasLabel = entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).label === "string" && (entry as Record<string, string>).label;
      if (!hasLabel) ops = ops.map((o) => (o.op === "node.update" && o.nodeId === node.id ? { ...o, patch: { ...o.patch, props: setAtPath(o.patch.props as Record<string, PropValue>, `${m[1]}.${m[2]}.label`, (item.thing ? item.thing.label : item.label).slice(0, 40)) } } : o));
    }
    const v = item.key ? peeked[item.key]?.data : undefined;
    // Round 2 items 11 and 14: an empty repeat bound to rows becomes one ready card per row (titled by the
    // row's name, its main values as stats), and a table of a wide read starts on its main columns.
    const wants = (node.type === "repeat" && !(node.children ?? []).length) || (node.type === "table" && !(Array.isArray(node.props.columns) && node.props.columns.length));
    const finish = (d: ShapedData | undefined) => {
      // The ready cards carry the repeat's own items binding, so only then is the plain bind left out
      // (a repeat that already has a child keeps the bind: lead follow-up, the binding was dropped).
      const ready = readyOps(node, r.name, d, newNodeId);
      apply([...ops.filter((o) => !(ready.length && o.op === "node.update" && o.nodeId === node.id)), ...ready].map((o) => (node.type === "table" && o.op === "node.update" && o.nodeId === node.id ? withColumns(o, d) : o)));
      if (d) onPeeked(r.name, d);
      close();
    };
    if (wants && !v) { void peekOne(item).then(finish); return; }
    finish(v);
  };

  /** Adds a chart line (spec 3.4), refusing a third unit with its two ways out. */
  const addLine = async (item: PickItem) => {
    if (!node) return;
    const read = lineRead(item);
    if (!read) { setSwitchFor(item); return; }
    const existing = chartLines(node).map((ln) => unitOf(data[/\{\{\s*([a-z][a-z0-9_]*)/.exec(ln.data.$bind)?.[1] ?? ""]));
    // A read whose format is decided by its data (Prometheus "measure" reads) says it in its live value;
    // when the chart already has two units and that value has not arrived yet, ask for it first.
    let seen = item.key ? peeked[item.key]?.data : undefined;
    if (!seen && !item.format && axisGroups(existing.filter((u) => u.format || u.unit)).length >= 2) seen = await peekOne(item);
    const next: LineUnit = { format: item.format ?? (seen && (seen.kind === "stat" || seen.kind === "series") ? seen.format : undefined), unit: seen && (seen.kind === "stat" || seen.kind === "series") ? seen.unit : undefined };
    const sentence = next.format || next.unit ? thirdUnitRefusal(existing.filter((u) => u.format || u.unit), next, itemWords(item)) : null;
    if (sentence) { setRefusal({ item, sentence, percent: null, checking: true }); void findPercent(item).then((p) => setRefusal((r) => (r && r.item === item ? { ...r, percent: p, checking: false } : r))); return; }
    const r = addLineOps(doc, node.id, item);
    if (!r) return;
    apply(r.ops);
    close();
  };

  /** One read's value now (A10.4 peek), for its format. */
  const peekOne = async (item: PickItem): Promise<ShapedData | undefined> => {
    const r = await fetch("/api/data/peek", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ integrationId: item.integrationId, endpointId: item.endpointId, params: item.params }] }) }).catch(() => null);
    const j = r?.ok ? ((await r.json().catch(() => null)) as PeekResponse | null) : null;
    return j?.values[0]?.data;
  };
  /** "Show all as percent": every line (and the new one) has a percent read of the same measure and thing. */
  const findPercent = async (item: PickItem): Promise<PickItem[] | null> => {
    if (!node) return null;
    const wanted = [...chartLines(node).map((ln) => /\{\{\s*([a-z][a-z0-9_]*)/.exec(ln.data.$bind)?.[1] ?? "").map((n) => doc.dataSources.find((s) => s.name === n) ?? null), null];
    const out: PickItem[] = [];
    for (const src of wanted) {
      const integrationId = src?.integrationId ?? item.integrationId;
      const res = await fetch(`/api/data/catalogue?${new URLSearchParams({ integrationId, fits: "chart", limit: "200" })}`, { credentials: "same-origin" }).then((r) => (r.ok ? (r.json() as Promise<CatalogueResponse>) : null)).catch(() => null);
      if (!res) return null;
      // The line's own item: the one whose read (or history read) is this source's.
      const own = src ? res.items.find((it) => (it.history && it.history.endpointId === src.endpointId && JSON.stringify(it.history.params) === JSON.stringify(src.params ?? {})) || (it.endpointId === src.endpointId && JSON.stringify(it.params) === JSON.stringify(src.params ?? {}))) : res.items.find((it) => it.key === item.key) ?? (item as CatalogueItem);
      if (!own) return null;
      if (own.format === "percent") { out.push(own); continue; }
      const alt = res.items.find((it) => it.measure === own.measure && it.format === "percent" && (it.thing?.value ?? "") === (own.thing?.value ?? "") && (it.shape === "series" || !!it.history));
      if (!alt) return null;
      out.push(alt);
    }
    return out;
  };
  const allAsPercent = () => {
    if (!node || !refusal?.percent) return;
    let d = doc;
    const ops: DraftOp[] = [];
    const lines: PropValue[] = [];
    const old = chartLines(node);
    const taken: string[] = [];
    refusal.percent.forEach((it, i) => {
      const read = lineRead(it)!;
      const r = addLineOps({ ...d, dataSources: [...d.dataSources] }, node.id, read, { taken });
      if (!r) return;
      for (const o of r.ops) if (o.op === "source.set") { ops.push(o); taken.push(o.source.name); d = { ...d, dataSources: [...d.dataSources, o.source] }; }
      const prev = old[i];
      lines.push({ data: { $bind: `{{ ${r.name} }}` }, label: prev?.label ?? itemWords(it), ...(prev?.color ? { color: prev.color } : {}), ...(prev?.hidden ? { hidden: true } : {}) });
    });
    ops.push({ op: "node.update", nodeId: node.id, patch: { props: { ...node.props, data: null, lines } } } as DraftOp);
    apply(ops);
    close();
  };
  /** "Put it on a new chart": a chart below this one with just the new line. */
  const newChart = () => {
    if (!node || !refusal) return;
    const at = findNode(doc, node.id);
    const read = lineRead(refusal.item);
    if (!at?.parent || !read) return;
    const id = newNodeId();
    const slot = node.slot ? { ...node.slot, y: node.slot.y + node.slot.h } : undefined;
    const fresh: ComponentNode = { id, type: "chart", props: { kind: "line", height: typeof node.props.height === "number" ? node.props.height : 200, legend: true }, ...(slot ? { slot } : {}) };
    const added = { ...doc, pages: doc.pages.map((p) => (p.id === at.page.id ? { ...p, root: insertChild(p.root, at.parent!.id, fresh) } : p)) };
    const r = addLineOps(added, id, refusal.item);
    if (!r) return;
    apply([{ op: "node.add", parentId: at.parent.id, node: fresh }, ...r.ops]);
    onSelect?.(id);
    close();
  };

  const useSettings = () => {
    if (!settingsFor) return;
    const p = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== "" && v !== undefined)) as Record<string, PropValue>;
    const item: CatalogueItem = { ...settingsFor, params: p, needsSettings: false, key: `${settingsFor.integrationId}|${settingsFor.endpointId}|${JSON.stringify(p)}` };
    setSettingsFor(null);
    pick(item);
  };
  const endpointOf = (it: PickItem) => bindable?.find((b) => b.integrationId === it.integrationId)?.endpoints.find((e) => e.id === it.endpointId);
  const settingsFields: ParamField[] = settingsFor ? paramFields(endpointOf(settingsFor)?.params).filter((f) => f.required && f.kind !== "thing") : [];
  const missing = settingsFields.filter((f) => settings[f.key] === undefined || settings[f.key] === "").map((f) => f.label);

  const targetWords = node ? `${nodeLabel(node)}${target.prop !== "data" && target.prop !== "items" ? `: ${target.prop.replace(/\.(\d+)\./, (_, n) => ` ${Number(n) + 1} `)}` : ""}` : "this app";
  const rowFor = (it: CatalogueItem & { fit?: boolean }) => {
    const v = valueWords(peeked[it.key]);
    return (
      <li key={it.key} className="flex items-stretch gap-1">
        <button ref={observe} type="button" className={`${row} flex-1 ${it.key === currentKey ? "border-fg bg-bg-sunk" : ""}`} aria-current={it.key === currentKey || undefined} onClick={() => pick(it)} data-show-item={it.key} data-show-current={it.key === currentKey ? "yes" : undefined} data-show-integration={it.integrationId} data-show-endpoint={it.endpointId} data-show-thing-value={it.thing?.value ?? ""} data-fits={it.fit ? "yes" : "no"}>
          <span className="flex-none"><PackageIcon id={it.serviceIcon || it.packageId} size={20} /></span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="type-body truncate font-medium" data-show-item-words>{itemWords(it)}</span>
            <span className="type-caption truncate text-fg-2">{it.key === currentKey ? <span className="font-medium text-fg" data-show-now>Showing now · </span> : null}{it.integrationName}{it.needsSettings ? " · asks for a setting" : ""}{it.from ? ` · ${it.from}` : ""}</span>
          </span>
          <span className={`type-caption flex-none font-mono ${v?.failed ? "text-fg-2" : ""}`} data-show-value={v ? (v.failed ? "none" : "yes") : "loading"}>{v ? v.text : it.needsSettings ? "" : "…"}</span>
        </button>
        {it.thing && it.thing.value !== "*" && (
          <button type="button" className="inline-flex min-h-11 w-[5.5rem] flex-none items-center justify-center border border-line px-1 text-center type-caption leading-tight hover:bg-bg-sunk focus-visible:outline-2 focus-visible:outline-accent-ink" onClick={() => setAnother(it)} title={`Pick another ${it.thing.param}`} data-show-another={it.key}>Pick another</button>
        )}
      </li>
    );
  };

  return (
    <Sheet open onOpenChange={(o) => { if (!o) close(); }} title="What should this show?" path={`builder / data / ${targetWords}`} name="data-picker" width={520}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {target.fromInsert ? (
            <Button variant="quiet" onClick={close} data-pick-skip title="Leave it on sample values; pick its data later from its Data group">Skip for now</Button>
          ) : (
            <Button variant="quiet" onClick={close} data-pick-cancel>Cancel</Button>
          )}
          {!lineMode && <button type="button" className={`${link} ml-auto`} onClick={() => { onByHand(); }} data-pick-by-hand>Set it up by hand</button>}
        </div>
      }>
      <div className="flex flex-col gap-4" data-data-picker data-show-picker data-target={targetWords} data-mode={lineMode ? "line" : kind}>
        {rowList.length > 0 && !lineMode && (
          <section className="flex flex-col gap-1" data-show-this-row={around!.repeatId}>
            <h3 className="type-label m-0">This row</h3>
            <p className="type-caption m-0 text-fg-2">Each copy shows its own row. The values are the first row&apos;s.</p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {rowList.map((f) => (
                <li key={f.key}>
                  <button type="button" className={row} onClick={() => pickRow(f.key, f.label)} data-show-row-field={f.key}>
                    <span className="type-body min-w-0 flex-1 truncate font-medium">{f.label}</span>
                    <span className="type-caption flex-none font-mono text-fg-2">{rowValueWords(f.value, f.format)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <label className="flex flex-col gap-1">
          <span className="sr-only">Search your data</span>
          <input ref={searchRef} autoFocus type="search" className={input} value={q} onChange={(e) => { setQ(e.target.value); setSettingsFor(null); setAnother(null); setSwitchFor(null); setRefusal(null); }} placeholder={lineMode ? "Search: cpu, memory, network..." : "Search: cpu, memory, containers..."} aria-label="Search your data" data-show-search />
        </label>

        {refusal ? (
          <section className="flex flex-col gap-3 border border-warn p-3" role="alert" data-axis-refusal>
            <p className="type-body m-0" data-axis-sentence>{refusal.sentence}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={newChart} data-axis-new-chart>Put it on a new chart</Button>
              <Button variant="secondary" onClick={allAsPercent} disabled={!refusal.percent} title={refusal.checking ? "Checking for percent reads" : refusal.percent ? undefined : "Not every line has a percent read"} data-axis-percent data-ready={refusal.percent ? "yes" : refusal.checking ? "checking" : "no"}>Show all as percent</Button>
              <button type="button" className={link} onClick={() => setRefusal(null)} data-axis-back>Back to the list</button>
            </div>
            {!refusal.checking && !refusal.percent && <p className="type-caption m-0 text-fg-2" data-axis-percent-why>Not every line has a percent form, so they cannot all be shown as percent.</p>}
          </section>
        ) : settingsFor ? (
          <section className="flex flex-col gap-3 border border-line p-3" data-show-settings={settingsFor.key}>
            <h3 className="type-label m-0">{itemWords(settingsFor)} needs a setting</h3>
            {settingsFields.map((f) => (
              <label key={f.key} className="flex flex-col gap-1 type-caption" data-show-setting={f.key}>{f.label}{f.required ? " (required)" : ""}
                {f.kind === "choice" ? (
                  <SelectMenu label={f.label} hideLabel name={`show-setting-${f.key}`} value={settings[f.key] === undefined || settings[f.key] === "" ? "__none" : String(settings[f.key])} onChange={(v) => setSettings((s) => ({ ...s, [f.key]: v === "__none" ? "" : v }))} options={[{ value: "__none", label: "Choose…" }, ...(f.options ?? []).map((o) => ({ value: o, label: f.optionLabels?.[o] ?? o }))]} />
                ) : (
                  <input className={input} inputMode={f.kind === "number" ? "decimal" : undefined} value={settings[f.key] === undefined ? "" : String(settings[f.key])} onChange={(e) => setSettings((s) => ({ ...s, [f.key]: f.kind === "number" && e.target.value !== "" && Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : e.target.value }))} data-show-setting-input={f.key} />
                )}
                {f.help ? <span className="text-fg-2">{f.help}</span> : null}
              </label>
            ))}
            {!settingsFields.length && <p className="type-caption m-0 text-fg-2">Set it up by hand to fill in this read's settings.</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={missing.length > 0 || !settingsFields.length} onClick={useSettings} data-show-settings-use>Show it</Button>
              <button type="button" className={link} onClick={() => setSettingsFor(null)}>Back to the list</button>
            </div>
            {missing.length > 0 && <p className="type-caption m-0 text-fg-2" data-show-settings-missing>Fill in {missing.join(", ")}.</p>}
          </section>
        ) : switchFor ? (
          <SwitchOffer item={switchFor} type={type} lineMode={lineMode} onSwitch={(t) => { const it = switchFor; setSwitchFor(null); pick(it, { switchTo: t }); }} onBack={() => setSwitchFor(null)} />
        ) : another ? (
          <AnotherList item={another} onPick={(c) => { const it = another; setAnother(null); pick({ ...it, key: `${it.integrationId}|${it.endpointId}|${c.value}`, params: { ...it.params, [it.thing!.param]: c.value }, thing: { ...it.thing!, value: c.value, label: c.label }, ...(it.history ? { history: { ...it.history, params: { ...it.history.params, [it.thing!.param]: c.value } } } : {}) }); }} onBack={() => setAnother(null)} />
        ) : (
          <>
            {services !== null && people.length === 0 && (
              <section className="flex flex-col gap-2 border border-line p-3" data-show-empty>
                <p className="type-body m-0">Connect a service first. Atrium's own readings (this server, and whether an address is up) are below.</p>
                <Button variant="secondary" href="/integrations/new" onClick={() => { try { window.sessionStorage.setItem(PICK_RETURN_KEY, JSON.stringify({ path: window.location.pathname, at: Date.now(), node: target.nodeId, ...(/^[A-Za-z]+$/.test(target.prop) ? { prop: target.prop } : {}) })); } catch { /* storage blocked: the person comes back by hand */ } }} data-pick-connect>Connect a service</Button>
              </section>
            )}
            {error && <p className="type-body m-0 text-bad" role="alert" data-show-error>{error}</p>}
            {res && res.pending.length > 0 && <p className="type-caption m-0 text-fg-2" data-show-pending>{res.pending.length === 1 ? "One service is" : `${res.pending.length} services are`} slow to answer: its reads are listed without their things for now.</p>}

            {!typed && (
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Browse your data">
                <button type="button" role="tab" aria-selected={browse === "service"} className={`${tab} ${browse === "service" ? "border-fg bg-fg text-bg" : "border-line"}`} onClick={() => { setBrowse("service"); setMeasure(null); }} data-show-browse="service">By service</button>
                <button type="button" role="tab" aria-selected={browse === "measure"} className={`${tab} ${browse === "measure" ? "border-fg bg-fg text-bg" : "border-line"}`} onClick={() => { setBrowse("measure"); setService(null); setThing(null); }} data-show-browse="measure">By measure</button>
              </div>
            )}

            {!typed && browse === "service" && !service && (
              <ul className="m-0 flex list-none flex-col gap-1 p-0" data-show-services>
                {services === null ? [0, 1, 2].map((i) => <li key={i} className="h-11 border border-line bg-bg-sunk" />) : services.map((s) => (
                  <li key={s.integrationId}>
                    <button type="button" className={row} onClick={() => { setService(s); setThing(null); }} data-show-service={s.integrationId}>
                      <PackageIcon id={s.icon || s.packageId} size={20} />
                      <span className="type-body min-w-0 flex-1 truncate font-medium">{s.name}</span>
                      {s.health && <span className={`type-caption ${s.health === "ok" ? "text-ok" : "text-bad"}`}>{s.health === "ok" ? "connected" : s.health === "degraded" ? "slow" : "down"}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!typed && browse === "service" && service && (
              <div className="flex flex-col gap-2" data-show-in-service={service.integrationId}>
                <div className="flex items-center gap-2">
                  <button type="button" className={link} onClick={() => { if (thing !== null) setThing(null); else setService(null); }} data-show-up>{thing !== null ? `Back to ${service.name}` : "All services"}</button>
                  <span className="type-label">{service.name}{thing !== null ? ` · ${thingsOfService.find((t) => t.value === thing)?.label ?? ""}` : ""}</span>
                </div>
                {thing === null && (
                  !res ? <ul className="m-0 flex list-none flex-col gap-1 p-0">{[0, 1, 2].map((i) => <li key={i} className="h-11 border border-line bg-bg-sunk" />)}</ul> : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0" data-show-things>
                      {thingsOfService.map((t) => (
                        <li key={t.value}>
                          <button type="button" className={row} onClick={() => setThing(t.value)} data-show-thing={t.value}>
                            <span className="flex min-w-0 flex-1 flex-col"><span className="type-body truncate font-medium">{t.label}</span>{t.detail && <span className="type-caption truncate text-fg-2">{t.detail}</span>}</span>
                            <span className="type-caption flex-none text-fg-2">{t.count} {t.count === 1 ? "read" : "reads"}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                )}
              </div>
            )}
            {!typed && browse === "measure" && !measure && (
              <ul className="m-0 grid list-none grid-cols-2 gap-1 p-0" data-show-measures>
                {MEASURES.map((m) => <li key={m.id}><button type="button" className={row} onClick={() => setMeasure(m.id)} data-show-measure={m.id}><span className="type-body font-medium">{m.label}</span></button></li>)}
              </ul>
            )}
            {!typed && browse === "measure" && measure && <button type="button" className={`${link} self-start`} onClick={() => setMeasure(null)} data-show-up>All measures</button>}

            {(typed || (browse === "service" && service && thing !== null) || (browse === "measure" && measure)) && (
              !res && !error ? (
                <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-busy data-show-loading>{[0, 1, 2].map((i) => <li key={i} className="h-11 border border-line bg-bg-sunk" />)}</ul>
              ) : listed.length === 0 ? (
                <p className="type-body m-0 text-fg-2" data-show-nothing>{typed ? `Nothing matches "${typed}".` : "Nothing here yet."} Try other words, or set it up by hand.</p>
              ) : (
                <>
                  {fitting.length > 0 && (
                    <section className="flex flex-col gap-1" data-show-group="fits">
                      <h3 className="type-caption m-0 font-medium text-fg-2">Fits {fitsTitle}</h3>
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">{fitting.map(rowFor)}</ul>
                    </section>
                  )}
                  {other.length > 0 && (
                    <section className="flex flex-col gap-1" data-show-group="other">
                      <h3 className="type-caption m-0 font-medium text-fg-2">Other data</h3>
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">{other.map(rowFor)}</ul>
                    </section>
                  )}
                </>
              )
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

/** A row field's first value, short: formatted numbers, plain text cut to 24 characters. */
function rowValueWords(v: unknown, format?: ValueFormat): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return format ? formatValue(v, format) : String(Math.round(v * 100) / 100);
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > 24 ? `${t.slice(0, 23)}…` : t;
}

/** Whether rows can make ready cards (a table or a status list). */
function readyCards(d: ShapedData): boolean {
  return d.kind === "table" || d.kind === "status";
}
/** Round 2 item 11: an empty repeat bound to rows gets one ready card per row (as Insert > Card for each does). */
function readyOps(node: ComponentNode, src: string, d: ShapedData | undefined, newNodeId: () => string): DraftOp[] {
  if (node.type !== "repeat" || (node.children ?? []).length || !d || !readyCards(d)) return [];
  return cardForEachOps(node, src, d, mainColumns(d), { makeId: () => newNodeId() });
}
/** Round 2 item 14: a new table on a read with many columns shows its name and main columns first (Columns lists the rest). */
function withColumns(op: DraftOp, d: ShapedData | undefined): DraftOp {
  if (op.op !== "node.update" || !d || d.kind !== "table" || d.columns.length <= TABLE_START_COLUMNS) return op;
  const props = op.patch.props as Record<string, PropValue> | undefined;
  if (!props || (Array.isArray(props.columns) && props.columns.length)) return op;
  const key = keyColumn(d)?.key;
  const cols = [...(key ? [key] : []), ...mainColumns(d)].slice(0, TABLE_START_COLUMNS);
  return { ...op, patch: { ...op.patch, props: { ...props, columns: cols } } } as DraftOp;
}
const TABLE_START_COLUMNS = 5;

function insertChild(root: ComponentNode, parentId: string, child: ComponentNode): ComponentNode {
  if (root.id === parentId) return { ...root, children: [...(root.children ?? []), child] };
  return { ...root, children: (root.children ?? []).map((c) => insertChild(c, parentId, child)) };
}

/** Data that does not fit: offer to show it as a component that does (spec 3.2, "as today"). */
function SwitchOffer({ item, type, lineMode, onSwitch, onBack }: { item: PickItem; type: string; lineMode: boolean; onSwitch(t: string): void; onBack(): void }) {
  const choices = lineMode ? [] : showChoices(item.shape as DataShapeKind).filter((c) => c.type !== "cards");
  const title = (META[type as keyof typeof META]?.title ?? type).toLowerCase();
  return (
    <section className="flex flex-col gap-3 border border-line p-3" data-show-switch={item.key ?? ""}>
      <p className="type-body m-0">{lineMode ? `${itemWords(item)} has no values over time, so it cannot be a chart line.` : `A ${title} cannot show ${itemWords(item)} as it is.`}</p>
      {choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {choices.map((c) => <Button key={c.type} variant="secondary" onClick={() => onSwitch(c.type)} data-show-switch-to={c.type}>Show it as a {c.label.toLowerCase()}</Button>)}
        </div>
      )}
      <button type="button" className={`${link} self-start`} onClick={onBack} data-show-switch-back>Back to the list</button>
    </section>
  );
}

type Choice = { value: string; label: string; detail?: string };

/** "Pick another": the other things the same read is about, from the service's live list (A8.2). */
function AnotherList({ item, onPick, onBack }: { item: CatalogueItem; onPick(c: Choice): void; onBack(): void }) {
  const [state, setState] = useState<{ choices: Choice[] } | { error: string } | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    let live = true;
    const query = new URLSearchParams({ integrationId: item.integrationId, endpointId: item.endpointId, param: item.thing!.param });
    fetch(`/api/data/choices?${query}`, { credentials: "same-origin" })
      .then(async (r) => { const j = (await r.json().catch(() => null)) as { choices?: Choice[]; error?: { message?: string } } | null; if (live) setState(r.ok && j?.choices ? { choices: j.choices } : { error: j?.error?.message ?? "The list could not be read." }); })
      .catch(() => { if (live) setState({ error: "The service did not answer in time." }); });
    return () => { live = false; };
  }, [item.key]);
  const list = state && "choices" in state ? state.choices.filter((c) => !q || `${c.label} ${c.detail ?? ""}`.toLowerCase().includes(q.toLowerCase())) : [];
  return (
    <section className="flex flex-col gap-2" data-show-another-list={item.key}>
      <div className="flex items-center gap-2">
        <button type="button" className={link} onClick={onBack} data-show-another-back>Back to the list</button>
        <span className="type-label">{item.label}, for which {item.thing!.param}?</span>
      </div>
      {state && "choices" in state && state.choices.length > 6 && <input className={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search the list" data-show-another-search />}
      {!state ? <ul className="m-0 flex list-none flex-col gap-1 p-0">{[0, 1, 2].map((i) => <li key={i} className="h-11 border border-line bg-bg-sunk" />)}</ul>
        : "error" in state ? <p className="type-body m-0 text-bad" role="alert">{state.error}</p>
        : (
          <ul className="m-0 flex max-h-96 list-none flex-col gap-1 overflow-y-auto p-0">
            {list.map((c) => (
              <li key={c.value}><button type="button" className={row} onClick={() => onPick(c)} data-show-another-choice={c.value}>
                <span className="flex min-w-0 flex-1 flex-col"><span className="type-body truncate font-medium">{c.label}</span>{c.detail && <span className="type-caption truncate text-fg-2">{c.detail}</span>}</span>
              </button></li>
            ))}
          </ul>
        )}
    </section>
  );
}

export { unitWords, axisGroups };
