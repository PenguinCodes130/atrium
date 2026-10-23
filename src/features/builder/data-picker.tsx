"use client";
// The data picker. Wave 2.5 (data-picking-spec.md) built the steps: an integration, what to read, its
// settings, a live sample from the draft stream (A6.2) and a click on the value to show. Wave 2.7
// (data-ease-spec.md 3.1, 3.2; Amendment 8) makes it one "What should this show?" flow: This row (inside a
// Repeat), data already In this app, From your services, or Type it in; reads in groups with the ones the
// service cannot answer hidden; "which thing" from a live list with Every at the top; how to show it,
// including A card for each; friendly names, reuse instead of copies, all-or-this-one for shared data, and
// nothing left behind on Cancel, Escape or the close button. Every change is a draft edit.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppDocument, ComponentNode, DataShapeKind, DataSourceDef, DraftOp, PropValue, ShapedData } from "@/core/contracts";
import { Button, Sheet, Switch, toast } from "@/features/shell";
import { Checkbox, SelectMenu } from "@/features/settings/ui/controls";
import { findNode, newId, nodeLabel } from "@/features/apps/doc";
import { isBinding } from "@/features/components/bindings";
import { formatParts } from "@/features/components/render/format";
import type { SourceData } from "@/features/data/types";
import { PICK_RETURN_KEY } from "@/features/integrations/ui/return-to-builder";
import {
  cardForEachOps, copyForOne, describeTemplate, sameRead, EVERY, everyWords, findReusable, isSourceName, keyColumn, mainColumns, manyValueOffers, missingParams, otherUsers, paramDefaults, paramFields, renameInTemplate, renameOps,
  repeatAround, rowFields, rowTemplate, SHAPE_WORDS, showChoices, sourceLabelFor, sourceNameFromLabel, switchTypeOp, templateFor, unusedAdded, usersOf, wholeFit, wholeProp, wordsFor, type Agg, type ParamField, type Pick, type ShowAs,
} from "./data-pick";

export type BindableEndpoint = {
  id: string; label: string; description: string; params?: Record<string, unknown>; shape: string; defaultRefreshSec: number; minRefreshSec: number;
  /** A8.1: a heading in words, listed under Advanced, what the service must have, and whether it has it. */
  group?: string; advanced?: boolean; needs?: string; available?: boolean;
  /** A9.2: the read's last live check (editors only); `available` is false when it failed. */
  check?: { status: "ok" | "empty" | "failed" | "odd"; reason?: string; at: string };
  /** A9.1: where a recipe read came from ("Node Exporter Full, from Grafana"). */
  from?: string;
};
export type BindableIntegration = { integrationId: string; integrationName: string; packageId: string; health: "ok" | "failing" | "locked" | "unknown"; healthMessage?: string; endpoints: BindableEndpoint[]; /** A8.1, when the listing gives it per integration. */ availability?: Record<string, boolean> };

/** What the picker was opened for: a component and one of its props, a source to change, or neither. */
export type PickTarget = {
  nodeId?: string; prop?: string; source?: string;
  /** Start on this integration (back from "Connect an integration"). */ integrationId?: string;
  /** Opened right after inserting a data widget (spec 3.3): offers "Skip for now", which leaves it on sample values. */ fromInsert?: boolean;
  /** Wave 2.7: opened from Insert > Card for each; the rows picked become one card per row. */ cards?: boolean;
};

type Props = {
  appId: string;
  target: PickTarget;
  doc: AppDocument;
  bindable: BindableIntegration[] | null;
  data: Record<string, ShapedData | undefined>;
  states: Record<string, Omit<SourceData, "data"> | undefined>;
  apply(ops: DraftOp[]): void;
  onClose(): void;
};

const HEALTH_WORDS: Record<BindableIntegration["health"], string> = { ok: "connected", failing: "failing", locked: "secrets locked", unknown: "not checked yet" };
const row = "flex min-h-11 w-full items-center gap-3 border border-line px-3 py-2 text-left hover:bg-bg-sunk focus-visible:outline-2 focus-visible:outline-accent-ink disabled:opacity-60";
const input = "h-9 w-full border border-line-strong bg-bg-hi px-2 type-body touch:h-11";
const chip = "inline-flex min-h-8 items-center border border-line px-2 font-mono text-[12px] hover:bg-fg hover:text-bg touch:min-h-11";
const link = "type-caption min-h-8 px-1 underline touch:min-h-11";

function ago(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

function short(v: unknown, format?: Parameters<typeof formatParts>[1]): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && format && format !== "number") { const p = formatParts(v, format); return p.unit ? `${p.text} ${p.unit}` : p.text; }
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, "");
  return String(v).length > 40 ? `${String(v).slice(0, 39)}…` : String(v);
}

/** A source's live value in a few words ("7.8 %", "9 rows", "3 of 4 up"). */
export function liveWords(d: ShapedData | undefined): string {
  if (!d) return "";
  if (d.kind === "stat") return typeof d.value === "number" && d.format && d.format !== "number" ? short(d.value, d.format) : `${short(d.value)}${d.unit ? ` ${d.unit}` : ""}`;
  if (d.kind === "table") return `${d.total ?? d.rows.length} ${(d.total ?? d.rows.length) === 1 ? "row" : "rows"}`;
  if (d.kind === "series") return `${d.series.length} ${d.series.length === 1 ? "line" : "lines"}`;
  return `${d.items.filter((i) => i.state === "up").length} of ${d.items.length} up`;
}

const availableOf = (integ: BindableIntegration, e: BindableEndpoint) => e.available ?? integ.availability?.[e.id] ?? true;
/** A9.2: a read hidden because it failed its live check on this server (not for want of an exporter). */
const checkFailed = (e: BindableEndpoint) => e.check?.status === "failed";

/** The Show all reads switch's words: how many reads are hidden, and why. */
export function showAllWords(hidden: { check?: BindableEndpoint["check"] }[]): string {
  const failed = hidden.filter((e) => e.check?.status === "failed").length;
  const needs = hidden.length - failed;
  const parts = [needs ? `${needs} need data this service does not have` : "", failed ? `${failed} did not work on this server` : ""].filter(Boolean);
  return `Show all reads${parts.length ? ` (${parts.join("; ")})` : ""}`;
}

type Choice = { value: string; label: string; detail?: string };
type ChoicesState = { state: "loading" } | { state: "ok"; choices: Choice[]; every: boolean; total: number } | { state: "error"; message: string };

/** The live list for a "which thing" parameter (A8.2), read through the server for editors. */
function useChoices(integrationId: string | null, endpointId: string | null, param: string | null, others: Record<string, unknown>, q: string): ChoicesState | null {
  const otherKey = JSON.stringify(Object.fromEntries(Object.entries(others).filter(([k, v]) => k !== param && v !== "" && v !== undefined && v !== null)));
  const [s, setS] = useState<ChoicesState | null>(null);
  const lastList = useRef("");
  useEffect(() => {
    if (!integrationId || !endpointId || !param) { setS(null); return; }
    let live = true;
    // A new search keeps the list (and the search box) on screen until the answer comes.
    const listKey = `${integrationId}|${endpointId}|${param}|${otherKey}`;
    if (lastList.current !== listKey) setS({ state: "loading" });
    lastList.current = listKey;
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 6000);
    const query = new URLSearchParams({ integrationId, endpointId, param });
    if (otherKey !== "{}") query.set("params", otherKey);
    if (q) query.set("q", q); // big lists (a Prometheus metric list) are searched on the server
    fetch(`/api/data/choices?${query}`, { credentials: "same-origin", signal: ctl.signal })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as { choices?: Choice[]; every?: boolean; total?: number; error?: { message?: string } } | null;
        if (!live) return;
        if (!r.ok || !j || !Array.isArray(j.choices)) setS({ state: "error", message: j?.error?.message ?? "The list could not be read." });
        else setS({ state: "ok", choices: j.choices, every: !!j.every, total: typeof j.total === "number" ? j.total : j.choices.length });
      })
      .catch(() => { if (live) setS({ state: "error", message: "The service did not answer in time." }); })
      .finally(() => window.clearTimeout(t));
    return () => { live = false; ctl.abort(); window.clearTimeout(t); };
  }, [integrationId, endpointId, param, otherKey, q]);
  return s;
}

/** The node's props, type, title and children as they were, for Cancel. */
function restoreOps(before: ComponentNode, now: ComponentNode): DraftOp[] {
  const ops: DraftOp[] = [];
  const had = new Set((before.children ?? []).map((c) => c.id));
  const has = new Set((now.children ?? []).map((c) => c.id));
  for (const c of now.children ?? []) if (!had.has(c.id)) ops.push({ op: "node.remove", nodeId: c.id });
  const same = JSON.stringify([before.type, before.props, before.title, before.showTitle, before.slot]) === JSON.stringify([now.type, now.props, now.title, now.showTitle, now.slot]);
  if (!same) {
    const props = { ...Object.fromEntries(Object.keys(now.props).filter((k) => !(k in before.props)).map((k) => [k, null])), ...before.props };
    ops.push({ op: "node.update", nodeId: now.id, patch: { type: before.type, props, title: before.title ?? null, showTitle: before.showTitle ?? null, ...(before.slot ? { slot: before.slot } : {}) } } as DraftOp);
  }
  (before.children ?? []).forEach((c, i) => { if (!has.has(c.id)) ops.push({ op: "node.add", parentId: now.id, node: c, index: i }); });
  return ops;
}

export function DataPicker({ appId, target, doc, bindable, data, states, apply, onClose }: Props) {
  const node = target.nodeId ? findNode(doc, target.nodeId)?.node ?? null : null;
  const existing = target.source ? doc.dataSources.find((d) => d.name === target.source) ?? null : null;
  const prop = target.prop ?? (node ? wholeProp(node.type) ?? undefined : undefined);
  // What the picker changed, to put back on Cancel (spec 3.7); and what it added, to clean up (3.1).
  const before = useRef<{ node: ComponentNode | null; sources: DataSourceDef[] }>({ node: node ? structuredClone(node) : null, sources: doc.dataSources.map((d) => ({ ...d })) });
  const created = useRef(new Set<string>());
  // Template names renamed during this visit, so a template computed before a rename still binds (criterion 7).
  const renamed = useRef<[string, string][]>([]);
  const current = (t: string) => renamed.current.reduce((acc, [from, to]) => renameInTemplate(acc, from, to), t);
  const docRef = useRef(doc);
  docRef.current = doc;
  // Shared data (spec 3.1): Change on a source other widgets read asks first.
  const sharedAtOpen = useRef(existing && node ? otherUsers(doc, existing.name, node.id) : []);
  const [shared, setShared] = useState<"ask" | "all" | "one">(sharedAtOpen.current.length ? "ask" : "all");
  const [editing, setEditing] = useState<string | null>(existing?.name ?? null);

  const [integrationId, setIntegrationId] = useState<string | null>(existing?.integrationId ?? target.integrationId ?? null);
  const [endpointId, setEndpointId] = useState<string | null>(existing?.endpointId ?? null);
  const [name, setNameState] = useState<string | null>(existing?.name ?? null);
  const nameRef = useRef<string | null>(existing?.name ?? null);
  const setName = (n: string | null) => { nameRef.current = n; setNameState(n); };
  const [nameDraft, setNameDraft] = useState(existing?.name ?? "");
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>(existing?.params ?? {});
  const [jsonMode, setJsonMode] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [refresh, setRefresh] = useState<string>(existing ? String(existing.refreshSec) : "");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [colMenu, setColMenu] = useState<string | null>(null);
  const [lastPick, setLastPick] = useState<{ template: string; words: string } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [waitedLong, setWaitedLong] = useState(false);
  const [typed, setTyped] = useState("");
  const [thingSearch, setThingSearch] = useState("");
  const [cardCols, setCardCols] = useState<string[] | null>(null);
  const [cardsBuilt, setCardsBuilt] = useState(false);

  const integ = bindable?.find((b) => b.integrationId === integrationId) ?? null;
  const ep = integ?.endpoints.find((e) => e.id === endpointId) ?? null;
  const fields = useMemo(() => paramFields(ep?.params), [ep]);
  const things = fields.filter((f) => f.kind === "thing");
  const thing = things.find((f) => params[f.key] === undefined || params[f.key] === "") ?? null; // the next one to pick
  const missing = missingParams(fields, params);
  const minRefresh = ep ? Math.max(5, ep.minRefreshSec) : 5;
  const refreshNum = Number(refresh);
  const refreshError = refresh !== "" && (!Number.isInteger(refreshNum) || refreshNum < minRefresh) ? `Refresh at least every ${minRefresh} s.` : null;
  const shape = (ep?.shape ?? null) as DataShapeKind | null;
  // The last sample seen per name, so a rename never blanks the sample while the stream catches up
  // (the Use button stays under the pointer: criterion 7).
  const seen = useRef<Record<string, ShapedData>>({});
  if (name && data[name]) seen.current[name] = data[name]!;
  const sample = name ? data[name] ?? seen.current[name] : undefined;
  const state = name ? states[name] : undefined;
  // Search on the server only when the list is bigger than what came back, a moment after typing stops.
  const [serverQ, setServerQ] = useState("");
  const choices = useChoices(integ?.integrationId ?? null, ep?.id ?? null, thing?.key ?? null, params, serverQ);
  const capped = choices?.state === "ok" && choices.total > choices.choices.length;
  useEffect(() => {
    if (!capped && !serverQ) return;
    const t = window.setTimeout(() => setServerQ(thingSearch.trim()), 300);
    return () => window.clearTimeout(t);
  }, [thingSearch, capped]);
  // Labels of the things picked, kept once seen (the list goes away after a pick).
  const [thingLabels, setThingLabels] = useState<Record<string, string>>({});

  // ---- The source this visit reads (spec 3.1 "Names", reuse) ----
  const autoLabel = ep ? sourceLabelFor(ep.label, things.flatMap((f) => { const v = params[f.key]; if (v === undefined || v === "") return []; return [v === EVERY ? everyWords(f.label) : thingLabels[`${f.key}=${String(v)}`] ?? String(v)]; })) : "";
  const base = (): Omit<DataSourceDef, "name"> | null => {
    if (!integ || !ep || missing.length || refreshError) return null;
    const p = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== "" && v !== undefined)) as Record<string, string>;
    return { integrationId: integ.integrationId, endpointId: ep.id, refreshSec: refresh ? refreshNum : ep.defaultRefreshSec, ...(Object.keys(p).length ? { params: p } : {}) };
  };
  const key = JSON.stringify([integrationId, endpointId, params, refresh, missing.length, !!refreshError, shared, editing]);
  useEffect(() => {
    if (shared === "ask") return;
    const b = base();
    if (!b) return;
    const d = docRef.current;
    const cur = name ? d.dataSources.find((x) => x.name === name) : undefined;
    // Changing an existing source (for all its widgets, or this widget's own copy): edit it in place.
    const ours = !!name && (name === editing || (created.current.has(name) && !otherUsers(d, name, node?.id ?? "").length));
    if (!ours) {
      const match = findReusable(d, b);
      if (match) {
        if (name !== match.name) { setName(match.name); setNameDraft(match.name); setRefresh(String(match.refreshSec)); }
        return;
      }
    }
    if (ours && !cur) return; // this tab's copy has not caught up with the source yet
    if (ours && cur) {
      const mine = created.current.has(cur.name);
      const label = labelDraft ?? (mine ? autoLabel : cur.label);
      const next: DataSourceDef = { ...b, name: cur.name, ...(label ? { label } : {}) };
      if (JSON.stringify(cur) === JSON.stringify(next)) return;
      const t = window.setTimeout(() => {
        // A source this visit made gets a fresh name with its new settings, so the live stream (keyed by
        // name) reads it at once and the name keeps following the words; every binding moves with it.
        const readChanged = !sameRead(cur, next);
        const to = mine && readChanged && label && labelDraft === null ? sourceNameFromLabel(label, docRef.current.dataSources.map((x) => x.name).filter((x) => x !== cur.name)) : cur.name;
        if (to === cur.name) { apply([{ op: "source.set", source: next }]); return; }
        const ops = renameOps(docRef.current, cur.name, to);
        ops[0] = { op: "source.set", source: { ...next, name: to } };
        apply(ops);
        renamed.current.push([cur.name, to]);
        created.current.delete(cur.name);
        created.current.add(to);
        if (editing === cur.name) setEditing(to);
        if (lastPick) setLastPick({ template: renameInTemplate(lastPick.template, cur.name, to), words: lastPick.words });
        setName(to);
        setNameDraft(to);
      }, 400);
      return () => window.clearTimeout(t);
    }
    const label = labelDraft ?? autoLabel;
    const fresh = sourceNameFromLabel(label || ep!.label, d.dataSources.map((x) => x.name));
    apply([{ op: "source.set", source: { ...b, name: fresh, ...(label ? { label } : {}) } }]);
    created.current.add(fresh);
    setName(fresh);
    setNameDraft(fresh);
  }, [key]);
  useEffect(() => {
    setWaitedLong(false);
    if (!name || sample) return;
    const t = window.setTimeout(() => setWaitedLong(true), 3000);
    return () => window.clearTimeout(t);
  }, [name, !!sample]);

  const liveNode = node ? findNode(doc, node.id)?.node ?? node : null;
  const currentTemplate = liveNode && prop ? (() => { const v = (liveNode.props as Record<string, PropValue>)[prop]; return isBinding(v) ? v.$bind : null; })() : null;
  const boundWords = currentTemplate ? (lastPick?.template === currentTemplate ? lastPick.words : describeTemplate(currentTemplate) ?? "Custom template") : null;
  const sourceLabel = (n: string | null) => (n ? docRef.current.dataSources.find((d) => d.name === n)?.label ?? "" : "");

  /** The title a widget inserted through the picker gets (A8.5): what it shows, in words. */
  const titleFor = (words?: string): Record<string, string> => {
    const n = liveNode;
    if (!n || !target.fromInsert || n.title || n.type === "repeat") return {};
    const t = (sourceLabel(nameRef.current) || autoLabel || words || "").slice(0, 120);
    return t ? { title: t } : {};
  };

  /** Binds the target prop. A rename typed but not yet saved lands in the same batch (spec 3.1, criterion 7). */
  const bind = (template: string, words: string, opts: { prop?: string; extra?: Record<string, PropValue> } = {}) => {
    const n = liveNode;
    const p = opts.prop ?? prop;
    if (!n || !p) return;
    const pending = commitRename();
    const t = current(template);
    const renamedProps = pending ? (pending.ops.find((o) => o.op === "node.update" && o.nodeId === n.id) as { patch: { props: Record<string, PropValue> } } | undefined)?.patch.props : undefined;
    const props = { ...(renamedProps ?? n.props), ...(opts.extra ?? {}), [p]: { $bind: t } };
    const others = pending ? pending.ops.filter((o) => !(o.op === "node.update" && o.nodeId === n.id)) : [];
    apply([...others.slice(0, -1), { op: "node.update", nodeId: n.id, patch: { props, ...titleFor(words) } } as DraftOp, ...others.slice(-1)]);
    setLastPick({ template: t, words });
  };
  const pick = (p: Pick) => { const n = nameRef.current; if (n) bind(templateFor(n, p), wordsFor(n, p)); };

  /** Turns the widget into another kind showing this source (spec 3.1 "Pick how to show it"). */
  const showAs = (type: ShowAs["type"]) => {
    const n = liveNode;
    const src = nameRef.current;
    if (!n || !src) return;
    if (type === "cards") return buildCards(mainColumns(sample!), true);
    const op = switchTypeOp(n, type, src) as Extract<DraftOp, { op: "node.update" }>;
    apply([{ ...op, patch: { ...op.patch, ...titleFor() } } as DraftOp]);
    setLastPick({ template: `{{ ${src} }}`, words: `All of ${src}` });
  };

  /** A card for each row (spec 3.2): the widget becomes a Repeat with one ready card. */
  const buildCards = (cols: string[], first = false) => {
    const n = liveNode;
    const src = nameRef.current;
    if (!n || !src || !sample || (sample.kind !== "table" && sample.kind !== "status")) return;
    const ops: DraftOp[] = [];
    let repeat = n;
    if (n.type !== "repeat") {
      const props = { items: { $bind: sample.kind === "status" ? `{{ ${src}.items }}` : `{{ ${src}.rows }}` }, columns: 3, max: 50, empty: "Nothing reported yet" } as Record<string, PropValue>;
      const cleared = Object.fromEntries(Object.keys(n.props).filter((k) => !(k in props)).map((k) => [k, null]));
      ops.push({ op: "node.update", nodeId: n.id, patch: { type: "repeat", props: { ...cleared, ...props } } } as DraftOp);
      repeat = { ...n, type: "repeat", props, children: [] };
    }
    ops.push(...cardForEachOps(repeat, src, sample, cols, { makeId: newId }));
    apply(ops);
    setCardCols(cols);
    setCardsBuilt(true);
    if (first) setLastPick({ template: `{{ ${src}.rows }}`, words: `A card for each row of ${sourceLabel(src) || src}` });
  };
  // Opened from Insert > Card for each (or on an empty Repeat): the first rows that arrive build the cards.
  const cardsMode = !!liveNode && liveNode.type === "repeat" && (target.cards || !(before.current.node?.children ?? []).length);
  useEffect(() => {
    if (!cardsMode || cardsBuilt || !sample || (sample.kind !== "table" && sample.kind !== "status")) return;
    buildCards(cardCols ?? mainColumns(sample), true);
  }, [cardsMode, cardsBuilt, sample?.kind]);

  /** Cancel, Escape and the close button: put back what this visit changed, and remove sources it added that nothing uses. */
  const cancel = async () => {
    // Someone else (a person or an agent) may have started using an added source meanwhile: decide on the
    // newest saved draft, not only on what this tab has seen (spec criterion 15).
    const saved = await latestDoc();
    const d = docRef.current;
    const ops: DraftOp[] = [];
    const b = before.current;
    const now = node ? findNode(d, node.id)?.node : null;
    if (b.node && now) ops.push(...restoreOps(b.node, now));
    for (const s of d.dataSources) {
      const was = b.sources.find((x) => x.name === s.name);
      if (was) { if (JSON.stringify(was) !== JSON.stringify(s)) ops.push({ op: "source.set", source: was }); continue; }
      const others = [...usersOf(saved, s.name), ...usersOf(d, s.name)].filter((u) => !(node && u.nodeId === node.id) && !(now && (now.children ?? []).some((c) => containsId(c, u.nodeId))));
      if (!others.length) ops.push({ op: "source.remove", name: s.name });
    }
    if (ops.length) apply(ops);
    onClose();
  };
  /** Done: keep what it shows; a source this visit added and then moved away from, which nothing uses, goes (spec 3.1). */
  const done = () => {
    const d = docRef.current;
    const keep = nameRef.current; // the data the picker ends on stays; earlier picks it moved away from go
    const gone = unusedAdded(d, before.current.sources.map((s) => s.name), undefined, keep).filter((n) => created.current.has(n));
    if (gone.length) apply(gone.map((n) => ({ op: "source.remove", name: n }) as DraftOp));
    onClose();
  };

  /** The newest saved draft (other people's and agents' edits included), or this tab's copy if it cannot be read. */
  const latestDoc = async (): Promise<AppDocument> => (await fetch(`/api/apps/${encodeURIComponent(appId)}/draft`, { credentials: "same-origin" }).then((r) => (r.ok ? (r.json() as Promise<{ doc: AppDocument }>) : null)).catch(() => null))?.doc ?? docRef.current;

  /**
   * Renames the source's template name now, from this tab's copy, so a bind in the same moment uses the new
   * name (spec 3.1 "Rename and bind land together"). Returns the ops when a rename is pending, without
   * applying them, for the caller to send in one batch; components only the saved draft knows follow after.
   */
  const commitRename = (): { to: string; ops: DraftOp[] } | null => {
    const to = nameDraft.trim();
    const from = nameRef.current;
    if (!from || to === from) return null;
    // Said beside the field, not in a toast that could cover the picker's buttons.
    if (!isSourceName(to)) { setNameError("A name starts with a lowercase letter and uses lowercase letters, digits and _ (at most 32)."); setNameDraft(from); return null; }
    if (docRef.current.dataSources.some((d) => d.name === to)) { setNameError(`There is already a data source named ${to}.`); setNameDraft(from); return null; }
    setNameError(null);
    const local = renameOps(docRef.current, from, to);
    if (!local.length) return null;
    renamed.current.push([from, to]);
    if (seen.current[from]) seen.current[to] = seen.current[from]!;
    setName(to);
    if (created.current.has(from)) { created.current.delete(from); created.current.add(to); }
    if (editing === from) setEditing(to);
    if (lastPick) setLastPick({ template: renameInTemplate(lastPick.template, from, to), words: lastPick.words });
    void followRemote(from, to, new Set(local.flatMap((o) => (o.op === "node.update" ? [o.nodeId] : []))));
    return { to, ops: local };
  };
  const followRemote = async (from: string, to: string, touched: Set<string>) => {
    const saved = await latestDoc();
    const remote = renameOps({ ...saved, dataSources: [...saved.dataSources.filter((d) => d.name !== to), { ...(saved.dataSources.find((d) => d.name === from) ?? { name: from, integrationId: "", endpointId: "", refreshSec: 30 }) }] }, from, to).filter((o) => o.op === "node.update" && !touched.has(o.nodeId) && findNode(docRef.current, o.nodeId));
    if (remote.length) apply(remote);
  };
  const rename = () => { const r = commitRename(); if (r) apply(r.ops); };
  const saveLabel = () => {
    const n = nameRef.current;
    const cur = n ? docRef.current.dataSources.find((d) => d.name === n) : null;
    const l = (labelDraft ?? "").trim();
    if (!cur || labelDraft === null || l === (cur.label ?? "")) return;
    apply([{ op: "source.set", source: { ...cur, ...(l ? { label: l.slice(0, 80) } : { label: "" }) } }]);
  };

  const retry = async () => {
    if (!integ || !ep) return;
    setRetrying(true);
    const q = new URLSearchParams({ integration: integ.integrationId, endpoint: ep.id, refresh: String(refresh ? refreshNum : ep.defaultRefreshSec) });
    if (Object.keys(params).length) q.set("params", JSON.stringify(params));
    await fetch(`/api/data/endpoint?${q}`, { credentials: "same-origin" }).catch(() => null);
    setRetrying(false);
  };

  const startOver = () => { setIntegrationId(null); setEndpointId(null); setParams({}); setName(editing && shared === "all" ? editing : null); setLabelDraft(null); setCardsBuilt(false); };
  const chooseEndpoint = (e: BindableEndpoint) => { setEndpointId(e.id); setParams(paramDefaults(paramFields(e.params))); setRefresh(String(e.defaultRefreshSec)); setLabelDraft(null); setThingSearch(""); if (!(editing && shared === "all")) setName(null); setCardsBuilt(false); };
  const useAppSource = (s: DataSourceDef) => { setIntegrationId(s.integrationId); setEndpointId(s.endpointId); setParams(s.params ?? {}); setRefresh(String(s.refreshSec)); setName(s.name); setNameDraft(s.name); setLabelDraft(null); setCardsBuilt(false); };

  const forWhole = !!(liveNode && prop && wholeProp(liveNode.type) === prop);
  const numberCols = sample?.kind === "table" ? sample.columns.filter((c) => c.type === "number").map((c) => ({ key: c.key, label: c.label })) : [];
  const fit = forWhole && name && (sample?.kind ?? shape) ? wholeFit(liveNode!.type, name, (sample?.kind ?? shape)!, numberCols) : null;
  const wantsOne = !!liveNode && !!prop && ((forWhole && ["stat", "gauge", "progress"].includes(liveNode.type)) || prop === "value");
  const many = wantsOne && name && sample?.kind === "table" && (sample.total ?? sample.rows.length) > 1 ? manyValueOffers(name, sample) : null;
  const everyThing = things.find((f) => params[f.key] === EVERY);
  const targetWords = liveNode ? `${nodeLabel(liveNode)}${prop && !forWhole ? `: ${prop}` : ""}` : "this app";
  const repeat = liveNode ? repeatAround(doc, liveNode.id) : null;
  const rowData = repeat?.source ? data[repeat.source] : undefined;
  const row1 = rowFields(rowData);
  const chosen = !!integ || !!name;
  const appSources = doc.dataSources.filter((s) => !created.current.has(s.name) || s.name === name);
  let step = 0;
  const n = () => ++step;

  // Endpoints in groups (A8.1): hidden when the service lacks their data unless "Show all reads" is on.
  const matching = (integ?.endpoints ?? []).filter((e) => !search || `${e.label} ${e.description} ${e.group ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const hiddenReads = matching.filter((e) => integ && !availableOf(integ, e));
  const hiddenCount = hiddenReads.length;
  const visible = matching.filter((e) => showAll || (integ && availableOf(integ, e)));
  const groups = (() => {
    const out: { title: string; advanced: boolean; items: BindableEndpoint[] }[] = [];
    for (const e of visible) {
      const title = e.advanced ? "Advanced" : e.group ?? "";
      const g = out.find((x) => x.title === title) ?? (out.push({ title, advanced: !!e.advanced, items: [] }), out.at(-1)!);
      g.items.push(e);
    }
    return [...out.filter((g) => !g.advanced), ...out.filter((g) => g.advanced)];
  })();
  const endpointRow = (e: BindableEndpoint) => (
    <li key={e.id}>
      <button type="button" className={row} onClick={() => chooseEndpoint(e)} data-pick-endpoint={e.id} data-available={integ && availableOf(integ, e) ? "yes" : "no"}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="type-body font-medium">{e.label}</span>
          {/* A recipe read with no description of its own has its source tag as its description: shown once. */}
          {e.description && e.description !== e.from ? <span className="type-caption text-fg-2" data-pick-endpoint-description>{e.description}</span> : null}
          {e.from ? <span className="type-caption text-fg-2" data-pick-endpoint-from>{e.from}</span> : null}
          {integ && !availableOf(integ, e) && checkFailed(e) ? <span className="type-caption text-warn" data-pick-endpoint-check="failed">Did not work on this server: {e.check!.reason?.trim() || "the last check failed"}</span>
            : integ && !availableOf(integ, e) && e.needs ? <span className="type-caption text-warn" data-pick-endpoint-needs>Needs {e.needs}</span> : null}
        </span>
        <span className="type-caption flex-none text-fg-2" data-pick-endpoint-kind>{SHAPE_WORDS[e.shape as DataShapeKind] ?? e.shape}</span>
      </button>
    </li>
  );

  const showTypes = liveNode && name && (sample?.kind ?? shape) ? showChoices((sample?.kind ?? shape)!) : [];
  const currentShow: ShowAs["type"] | null = liveNode ? (liveNode.type === "repeat" ? "cards" : (liveNode.type as ShowAs["type"])) : null;

  return (
    <Sheet open onOpenChange={(o) => { if (!o) void cancel(); }} title="What should this show?" path={`builder / data / ${targetWords}`} name="data-picker" width={480}
      footer={
        <div className="flex gap-2">
          <Button variant="primary" onClick={done} disabled={shared === "ask"} data-pick-done>Done</Button>
          {target.fromInsert ? (
            <Button variant="quiet" onClick={() => void cancel()} data-pick-skip title="Leave it on sample values; connect it later from its Data group">Skip for now</Button>
          ) : (
            <Button variant="quiet" onClick={() => void cancel()} data-pick-cancel>Cancel</Button>
          )}
        </div>
      }>
      <div className="flex flex-col gap-5" data-data-picker data-target={targetWords}>
        {shared === "ask" && existing && (
          <section className="flex flex-col gap-2 border border-warn p-3" data-pick-shared={sharedAtOpen.current.length}>
            <p className="type-body m-0">{sharedAtOpen.current.length === 1 ? "1 other widget shows" : `${sharedAtOpen.current.length} other widgets show`} this data ({sharedAtOpen.current.map((u) => u.label).join(", ")}).</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setShared("all")} data-pick-shared-all>Change it for all {sharedAtOpen.current.length + 1} widgets</Button>
              <Button variant="secondary" onClick={() => {
                const c = node ? copyForOne(docRef.current, node.id, existing.name) : null;
                if (!c) return setShared("all");
                apply(c.ops);
                created.current.add(c.name);
                setName(c.name);
                setNameDraft(c.name);
                setEditing(c.name);
                setShared("one");
              }} data-pick-shared-one>Make a separate copy for this one</Button>
            </div>
          </section>
        )}

        {shared !== "ask" && (
          <>
            {/* Step 1: what should this show */}
            <section className="flex flex-col gap-3" data-pick-step="integration">
              <h3 className="type-label m-0">{n()}. {chosen ? "Where the data comes from" : "What should this show?"}</h3>
              {bindable === null ? <p className="type-caption text-fg-2" data-pick-loading>Loading your integrations…</p>
              : chosen ? (
                <div className="flex items-center gap-2" data-pick-chosen-integration={integ?.integrationId ?? ""}>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="type-body truncate font-medium">{integ?.integrationName ?? "Data in this app"}</span>
                    {name && !created.current.has(name) && name !== editing ? <span className="type-caption text-fg-2" data-pick-reused={name}>Already in this app: {sourceLabel(name) || name}</span> : null}
                  </span>
                  {integ && <span className="type-caption text-fg-2">{HEALTH_WORDS[integ.health]}</span>}
                  <button type="button" className={link} onClick={startOver} data-pick-change-integration>Change</button>
                </div>
              ) : (
                <>
                  {row1.length > 0 && liveNode && (
                    <div className="flex flex-col gap-1" data-pick-this-row>
                      <h4 className="type-caption m-0 font-medium text-fg-2">This row</h4>
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {row1.map((f) => {
                          const one = ["stat", "gauge", "progress"].includes(liveNode.type) && forWhole;
                          return (
                            <li key={f.key}>
                              <button type="button" className={row} onClick={() => bind(rowTemplate(f.key), `This row: ${f.label}`, one ? { prop: "value", extra: typeof liveNode.props.label === "string" && liveNode.props.label ? {} : { label: f.label } } : {})} data-pick-row-field={f.key}>
                                <span className="type-body min-w-0 flex-1 truncate font-medium">{f.label}</span>
                                <span className="type-caption flex-none font-mono text-fg-2" data-pick-row-value>{short(f.value, f.format)}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                  {appSources.length > 0 && (
                    <div className="flex flex-col gap-1" data-pick-in-app>
                      <h4 className="type-caption m-0 font-medium text-fg-2">In this app</h4>
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {appSources.map((s) => {
                          const b = bindable.find((x) => x.integrationId === s.integrationId);
                          const e = b?.endpoints.find((x) => x.id === s.endpointId);
                          return (
                            <li key={s.name}>
                              <button type="button" className={row} disabled={!b} onClick={() => useAppSource(s)} data-pick-app-source={s.name}>
                                <span className="flex min-w-0 flex-1 flex-col">
                                  <span className="type-body truncate font-medium">{s.label || s.name}</span>
                                  <span className="type-caption truncate text-fg-2">{[e?.label && e.label !== s.label ? e.label : null, b?.integrationName ?? "not connected"].filter(Boolean).join(" · ")}</span>
                                </span>
                                <span className="type-caption flex-none font-mono text-fg-2" data-pick-app-value>{liveWords(data[s.name])}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                  <div className="flex flex-col gap-1" data-pick-services>
                    {(appSources.length > 0 || row1.length > 0) && <h4 className="type-caption m-0 font-medium text-fg-2">From your services</h4>}
                    {bindable.length === 0 ? (
                      <div className="flex flex-col gap-2 border border-line p-3" data-pick-empty>
                        <p className="type-body m-0">No integrations you can use yet. Connect one, then come back here.</p>
                        <Button variant="secondary" href="/integrations/new" onClick={() => { try { window.sessionStorage.setItem(PICK_RETURN_KEY, JSON.stringify({ path: window.location.pathname, at: Date.now(), ...(target.nodeId ? { node: target.nodeId } : {}), ...(target.prop ? { prop: target.prop } : {}) })); } catch { /* storage blocked: the person comes back by hand */ } }} data-pick-connect>Connect an integration</Button>
                      </div>
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {bindable.map((b) => (
                          <li key={b.integrationId}>
                            <button type="button" className={row} disabled={b.health === "locked"} onClick={() => { setIntegrationId(b.integrationId); setEndpointId(null); setParams({}); setSearch(""); setName(editing && shared === "all" ? editing : null); }} data-pick-integration={b.integrationId} data-health={b.health}>
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className="type-body truncate font-medium">{b.integrationName}</span>
                                <span className="type-caption text-fg-2">{b.packageId} · {b.endpoints.length} {b.endpoints.length === 1 ? "thing" : "things"} to read</span>
                                {b.healthMessage ? <span className={`type-caption ${b.health === "locked" ? "text-warn" : "text-bad"}`} data-pick-health-message>{b.healthMessage}</span> : null}
                              </span>
                              <span className={`type-caption ${b.health === "ok" ? "text-ok" : b.health === "unknown" ? "text-fg-2" : "text-bad"}`}>{HEALTH_WORDS[b.health]}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {liveNode && prop && (
                    <details className="border border-line" data-pick-type-it>
                      <summary className="flex min-h-9 cursor-pointer list-none items-center px-3 type-label touch:min-h-11 [&::-webkit-details-marker]:hidden" data-pick-type-it-toggle>Type it in (a template, for advanced use)</summary>
                      <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
                        <textarea className={`${input} h-16 py-1 font-mono`} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="{{ cpu.value }}" aria-label="Template" data-pick-typed />
                        <Button variant="secondary" disabled={!typed.trim()} onClick={() => bind(typed.trim(), describeTemplate(typed.trim()) ?? "Custom template")} data-pick-typed-use>Use this template</Button>
                      </div>
                    </details>
                  )}
                </>
              )}
            </section>

            {/* Step 2: what to read, in groups */}
            {integ && (
              <section className="flex flex-col gap-2" data-pick-step="endpoint">
                <h3 className="type-label m-0">{n()}. What to read</h3>
                {ep ? (
                  <div className="flex items-center gap-2" data-pick-chosen-endpoint={ep.id}>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="type-body truncate font-medium">{ep.label}</span>
                      <span className="type-caption text-fg-2">{SHAPE_WORDS[ep.shape as DataShapeKind] ?? ep.shape}</span>
                    </span>
                    <button type="button" className={link} onClick={() => { setEndpointId(null); if (!(editing && shared === "all")) setName(null); }} data-pick-change-endpoint>Change</button>
                  </div>
                ) : integ.endpoints.length === 0 ? (
                  <p className="type-body m-0" data-pick-no-endpoints>This integration has nothing to read yet. <a className="underline" href={`/integrations/${encodeURIComponent(integ.integrationId)}`}>Open its endpoints</a></p>
                ) : (
                  <>
                    {integ.endpoints.length > 8 && <input className={input} placeholder="Search what to read" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search what to read" data-pick-endpoint-search />}
                    {groups.map((g) => g.advanced ? (
                      <details key="advanced" className="border border-line" data-pick-group="Advanced">
                        <summary className="flex min-h-9 cursor-pointer list-none items-center px-3 type-label touch:min-h-11 [&::-webkit-details-marker]:hidden" data-pick-group-toggle="Advanced">Advanced ({g.items.length})</summary>
                        <ul className="m-0 flex list-none flex-col gap-1 p-2">{g.items.map(endpointRow)}</ul>
                      </details>
                    ) : (
                      <div key={g.title || "_"} className="flex flex-col gap-1" data-pick-group={g.title}>
                        {g.title && <h4 className="type-caption m-0 font-medium text-fg-2">{g.title}</h4>}
                        <ul className="m-0 flex list-none flex-col gap-1 p-0">{g.items.map(endpointRow)}</ul>
                      </div>
                    ))}
                    {(hiddenCount > 0 || showAll) && (
                      <div className="flex flex-col gap-1" data-pick-show-all>
                        <Switch checked={showAll} onCheckedChange={setShowAll} label={showAllWords(hiddenReads)} />
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

            {/* Step 3: which thing (A8.2), then any other settings */}
            {ep && things.length > 0 && (
              <section className="flex flex-col gap-2" data-pick-step="thing">
                {things.map((f) => {
                  const v = params[f.key];
                  const picked = v !== undefined && v !== "";
                  const open = !picked && thing?.key === f.key;
                  return (
                    <div key={f.key} className="flex flex-col gap-2" data-pick-thing-param={f.key}>
                      <h3 className="type-label m-0">{n()}. Which {f.label.toLowerCase()}</h3>
                      {picked ? (
                        <div className="flex items-center gap-2" data-pick-chosen-thing={String(v)}>
                          <span className="type-body min-w-0 flex-1 truncate font-medium">{v === EVERY ? everyWords(f.label) : thingLabels[`${f.key}=${String(v)}`] ?? String(v)}</span>
                          <button type="button" className={link} onClick={() => { setParams((p) => ({ ...p, [f.key]: "" })); setThingSearch(""); }} data-pick-change-thing>Change</button>
                        </div>
                      ) : open ? (
                        <ThingList field={f} state={choices} search={thingSearch} setSearch={setThingSearch} integrationName={integ!.integrationName} onPick={(c) => { setThingLabels((m) => ({ ...m, [`${f.key}=${c.value}`]: c.label })); setParams((p) => ({ ...p, [f.key]: c.value })); setLabelDraft(null); }} onType={() => setMoreOpen(true)} />
                      ) : <p className="type-caption m-0 text-fg-2">Pick the {things.find((x) => x.key === thing?.key)?.label.toLowerCase() ?? "one"} above first.</p>}
                    </div>
                  );
                })}
              </section>
            )}
            {ep && (
              <section className="flex flex-col gap-3" data-pick-step="settings">
                {fields.some((f) => f.required && f.kind !== "thing") && <h3 className="type-label m-0">{n()}. Settings</h3>}
                {!jsonMode && fields.filter((f) => f.required && f.kind !== "thing").map((f) => <ParamInput key={f.key} field={f} value={params[f.key]} onChange={(v) => setParams((p) => ({ ...p, [f.key]: v }))} />)}
                {missing.length > 0 && <p className="type-caption m-0 text-bad" role="alert" data-pick-missing>Fill in {missing.join(", ")} to see the data.</p>}
                <details className="group/more border border-line" open={moreOpen || !!refreshError || jsonMode} onToggle={(e) => setMoreOpen((e.target as HTMLDetailsElement).open)} data-pick-more-settings>
                  <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 type-label touch:min-h-11 [&::-webkit-details-marker]:hidden" data-pick-more-settings-toggle>
                    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden className="flex-none transition-transform duration-150 group-open/more:rotate-90 motion-reduce:transition-none"><path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" /></svg>
                    More settings
                    <span className="type-caption ml-auto text-fg-2">{[fields.some((f) => !f.required || f.kind === "thing") ? "filters" : "", "refresh", name ? "name" : ""].filter(Boolean).join(", ")}</span>
                  </summary>
                  <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
                    {!jsonMode && fields.filter((f) => !f.required || f.kind === "thing").map((f) => <ParamInput key={f.key} field={f.kind === "thing" ? { ...f, kind: "text", label: `${f.label} (typed)` } : f} value={params[f.key]} onChange={(v) => setParams((p) => ({ ...p, [f.key]: v }))} />)}
                    {jsonMode && (
                      <label className="flex flex-col gap-1 type-caption">Settings as JSON
                        <textarea className={`${input} h-24 py-1 font-mono`} value={jsonText} onChange={(e) => setJsonText(e.target.value)} data-pick-params-json-text />
                      </label>
                    )}
                    {fields.length > 0 && (
                      <div data-pick-params-json><Switch checked={jsonMode} onCheckedChange={(on) => {
                        if (on) { setJsonText(JSON.stringify(params, null, 2)); setJsonMode(true); return; }
                        try { const v = JSON.parse(jsonText || "{}") as unknown; if (v && typeof v === "object" && !Array.isArray(v)) setParams(v as Record<string, unknown>); } catch { toast({ kind: "error", title: "That JSON is not valid", description: "The fields keep the last valid values." }); }
                        setJsonMode(false);
                      }} label="Edit as JSON" /></div>
                    )}
                    <label className="flex flex-col gap-1 type-caption">Refresh every (seconds, at least {minRefresh})
                      <input className={input} inputMode="numeric" value={refresh} onChange={(e) => setRefresh(e.target.value)} aria-invalid={!!refreshError || undefined} data-pick-refresh />
                    </label>
                    {refreshError && <p className="type-caption m-0 text-bad" role="alert" data-pick-refresh-error>{refreshError}</p>}
                    {name && (<>
                      <label className="flex flex-col gap-1 type-caption">Name used in templates
                        <input className={`${input} font-mono`} value={nameDraft} aria-invalid={!!nameError || undefined} onChange={(e) => { setNameDraft(e.target.value); setNameError(null); }} onBlur={rename} onKeyDown={(e) => { if (e.key === "Enter") rename(); }} data-pick-name />
                      </label>
                      {nameError && <p className="type-caption m-0 text-bad" role="alert" data-pick-name-error><span className="font-medium">That name cannot be used</span>. {nameError}</p>}
                    </>)}
                  </div>
                </details>
              </section>
            )}

            {/* The live sample, and what to show */}
            {name && ep && (
              <section className="flex flex-col gap-3" data-pick-step="sample">
                <div className="flex items-end gap-2">
                  <label className="flex min-w-0 flex-1 flex-col gap-1 type-caption">Name
                    <input className={input} value={labelDraft ?? sourceLabel(name)} placeholder={autoLabel || name} onChange={(e) => setLabelDraft(e.target.value)} onBlur={saveLabel} onKeyDown={(e) => { if (e.key === "Enter") saveLabel(); }} data-pick-label />
                  </label>
                </div>
                <h3 className="type-label m-0">{n()}. What comes back</h3>
                {(state?.state === "failed" || state?.error) && !sample ? (
                  <div className="flex flex-col gap-2 border border-bad p-3" role="alert" data-pick-sample-error>
                    <p className="type-body m-0">{state.error?.message ?? "The read failed."}</p>
                    {state.error?.hint ? <p className="type-caption m-0 text-fg-2">{state.error.hint}</p> : null}
                    <Button variant="secondary" disabled={retrying} onClick={retry} data-pick-retry>{retrying ? "Trying…" : "Try again"}</Button>
                  </div>
                ) : !sample ? (
                  <div className="flex flex-col gap-2 border border-line p-3" data-pick-sample-loading>
                    <div className="h-4 w-1/2 bg-bg-sunk" /><div className="h-4 w-3/4 bg-bg-sunk" />
                    {waitedLong && <p className="type-caption m-0 text-fg-2">Still waiting for {integ?.integrationName}.</p>}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2" data-pick-sample data-shape={sample.kind}>
                    {state?.state === "stale" && <p className="type-caption m-0 text-warn" data-pick-stale>Last updated {ago(state.fetchedAt)}</p>}
                    {state?.state === "failed" && <p className="type-caption m-0 text-bad" data-pick-failed>{state.error?.message} <button type="button" className="underline" onClick={retry}>Try again</button></p>}
                    {many && <p className="type-body m-0 font-medium" data-pick-many={many.count}>{many.count} values, one per {everyThing ? everyThing.label.toLowerCase() : (keyColumn(sample)?.label.toLowerCase() ?? "row")}</p>}
                    <Sample data={sample} canPick={!!(liveNode && prop)} colMenu={colMenu} setColMenu={setColMenu} onPick={pick} />
                  </div>
                )}

                {liveNode && prop && sample && (
                  <div className="flex flex-col gap-2 border-t border-line pt-3" data-pick-show>
                    <h3 className="type-label m-0">{n()}. Show it on {targetWords}</h3>
                    {forWhole && showTypes.length > 1 && (
                      <div className="flex flex-col gap-1" data-pick-show-as-list>
                        <span className="type-caption text-fg-2">Show it as</span>
                        <div className="flex flex-wrap gap-2">
                          {showTypes.map((s) => (
                            <button key={s.type} type="button" className={`${chip} font-sans ${currentShow === s.type ? "bg-fg text-bg" : ""}`} aria-pressed={currentShow === s.type} onClick={() => showAs(s.type)} data-pick-show-as={s.type}>{s.label}</button>
                          ))}
                        </div>
                      </div>
                    )}
                    {cardsBuilt && liveNode.type === "repeat" && (sample.kind === "table" || sample.kind === "status") && (
                      <fieldset className="m-0 flex flex-col gap-1 border border-line p-2" data-pick-cards>
                        <legend className="type-caption px-1 text-fg-2">Each card shows</legend>
                        {(sample.kind === "table" ? sample.columns.map((c) => ({ key: c.key, label: c.label })) : rowFields(sample).map((f) => ({ key: f.key, label: f.label }))).filter((c) => c.key !== keyColumn(sample)?.key).map((c) => {
                          const on = (cardCols ?? []).includes(c.key);
                          return <Checkbox key={c.key} checked={on} onCheckedChange={(v) => buildCards(v ? [...(cardCols ?? []), c.key] : (cardCols ?? []).filter((k) => k !== c.key))} label={c.label} data-pick-card-col={c.key} />;
                        })}
                        <SelectMenu label="Cards across" name="pick-cards-across" value={String(typeof liveNode.props.columns === "number" ? liveNode.props.columns : 3)} options={[1, 2, 3, 4, 5, 6].map((x) => ({ value: String(x), label: String(x) }))} onChange={(v) => { const r = { ...liveNode, props: { ...liveNode.props, columns: Number(v) } }; apply(cardForEachOps(r, nameRef.current!, sample, cardCols ?? [], { makeId: newId, across: Number(v) })); }} />
                      </fieldset>
                    )}
                    {forWhole && fit?.ok && liveNode.type !== "repeat" && <Button variant="primary" onClick={() => bind(fit.template, `All of ${name}`)} data-pick-use>Use this data</Button>}
                    {forWhole && fit?.ok && liveNode.type === "repeat" && !cardsBuilt && <Button variant="primary" onClick={() => bind(fit.template, `All of ${name}`)} data-pick-use>Use this data</Button>}
                    {forWhole && fit && !fit.ok && (
                      <div className="flex flex-col gap-2" data-pick-mismatch>
                        <p className="type-body m-0">{fit.why}</p>
                        {many && many.offers.length > 0 && (
                          <>
                            <p className="type-caption m-0 text-fg-2">Pick one row above, or show {many.column!.label}:</p>
                            <div className="flex flex-wrap gap-2">
                              {many.offers.map((o) => <button key={o.agg} type="button" className={chip} onClick={() => bind(o.template, `${o.label} ${many.column!.label}`)} data-pick-many-offer={o.agg}>{o.label}</button>)}
                            </div>
                          </>
                        )}
                        {fit.offers.length > 0 && <p className="type-caption m-0 text-fg-2">Show a summary instead:</p>}
                        <div className="flex flex-wrap gap-2">
                          {fit.offers.map((o) => <button key={o.label} type="button" className={chip} onClick={() => bind(o.template, o.label)} data-pick-offer={o.label}>{o.label}</button>)}
                          {many && <button type="button" className={chip} onClick={() => showAs("table")} data-pick-many-table>Show as a table</button>}
                        </div>
                        {fit.fits.length > 0 && <p className="type-caption m-0 text-fg-2" data-pick-fits>Components that show {SHAPE_WORDS[(sample.kind ?? shape)!]}: {fit.fits.join(", ")}.</p>}
                      </div>
                    )}
                    {!forWhole && <p className="type-caption m-0 text-fg-2">Click a value above to show it.</p>}
                    {!forWhole && many && (
                      <div className="flex flex-wrap gap-2" data-pick-many-offers>
                        {many.offers.map((o) => <button key={o.agg} type="button" className={chip} onClick={() => bind(o.template, `${o.label} ${many.column!.label}`)} data-pick-many-offer={o.agg}>{o.label}</button>)}
                      </div>
                    )}
                    {currentTemplate && (
                      <div className="flex flex-col gap-1 bg-bg-sunk p-2" data-pick-bound>
                        <span className="type-body" data-pick-bound-words>{boundWords}</span>
                        <code className="break-all font-mono text-[12px] text-fg-2" data-pick-template>{currentTemplate}</code>
                        <span className="type-caption text-fg-2">You can edit the template in the inspector.</span>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

function containsId(n: ComponentNode, id: string): boolean {
  return n.id === id || (n.children ?? []).some((c) => containsId(c, id));
}

/** "Which machine": the things the service reports now, searchable, with Every at the top (spec 3.1, A8.2). */
function ThingList({ field, state, search, setSearch, integrationName, onPick, onType }: { field: ParamField; state: ChoicesState | null; search: string; setSearch(s: string): void; integrationName: string; onPick(c: Choice): void; onType(): void }) {
  const noun = field.label.toLowerCase();
  if (!state || state.state === "loading") {
    return (
      <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-busy data-pick-things-loading>
        {[0, 1, 2].map((i) => <li key={i} className="h-11 border border-line bg-bg-sunk" />)}
      </ul>
    );
  }
  if (state.state === "error") {
    return (
      <div className="flex flex-col gap-2 border border-bad p-3" role="alert" data-pick-things-error>
        <p className="type-body m-0">{integrationName}: {state.message}</p>
        <button type="button" className={`${link} self-start`} onClick={onType} data-pick-thing-type>Type it in instead</button>
      </div>
    );
  }
  const list = state.choices.filter((c) => !search || `${c.label} ${c.detail ?? ""} ${c.value}`.toLowerCase().includes(search.toLowerCase()));
  if (!state.choices.length && !search) {
    return (
      <div className="flex flex-col gap-2 border border-line p-3" data-pick-things-empty>
        <p className="type-body m-0">{integrationName} reports no {noun}s yet.</p>
        <button type="button" className={`${link} self-start`} onClick={onType} data-pick-thing-type>Type it in instead</button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-pick-things={state.choices.length}>
      {(state.choices.length > 6 || search || state.total > state.choices.length) && <input className={input} placeholder={`Search ${noun}s`} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={`Search ${noun}s`} data-pick-thing-search />}
      <ul className="m-0 flex max-h-80 list-none flex-col gap-1 overflow-y-auto p-0">
        {state.every && !search && (
          <li>
            <button type="button" className={row} onClick={() => onPick({ value: EVERY, label: everyWords(field.label) })} data-pick-thing={EVERY}>
              <span className="type-body min-w-0 flex-1 font-medium">{everyWords(field.label)}</span>
              <span className="type-caption flex-none text-fg-2">{state.total} {state.total === 1 ? noun : `${noun}s`}, as rows</span>
            </button>
          </li>
        )}
        {list.map((c) => (
          <li key={c.value}>
            <button type="button" className={row} onClick={() => onPick(c)} data-pick-thing={c.value}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="type-body truncate font-medium">{c.label}</span>
                {c.detail ? <span className="type-caption truncate text-fg-2" data-pick-thing-detail>{c.detail}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ParamInput({ field, value, onChange }: { field: ParamField; value: unknown; onChange(v: unknown): void }) {
  const label = `${field.label}${field.required ? " (required)" : ""}`;
  return (
    <div className="flex flex-col gap-1" data-pick-param={field.key} data-kind={field.kind}>
      {field.kind === "switch" ? (
        <Switch checked={value === true} onCheckedChange={(v) => onChange(v)} label={label} />
      ) : (
        <label className="flex flex-col gap-1 type-caption">{label}
          {field.kind === "choice" ? (
            <SelectMenu label={label} hideLabel name={`pick-param-${field.key}`} value={value === undefined || value === "" ? NO_CHOICE : String(value)} onChange={(v) => onChange(v === NO_CHOICE ? "" : v)}
              options={[...(field.required ? (value === undefined || value === "" ? [{ value: NO_CHOICE, label: "Choose…" }] : []) : [{ value: NO_CHOICE, label: "Any" }]), ...field.options!.map((o) => ({ value: o, label: field.optionLabels?.[o] ?? o }))]} />
          ) : (
            <input className={input} inputMode={field.kind === "number" ? "decimal" : undefined} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(field.kind === "number" && e.target.value !== "" && Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : e.target.value)} />
          )}
        </label>
      )}
      {field.help ? <span className="type-caption text-fg-2">{field.help}</span> : null}
    </div>
  );
}

const NO_CHOICE = "__none";

const AGGS_NUM: Agg[] = ["count", "sum", "avg", "min", "max", "list"];
const AGGS_TEXT: Agg[] = ["count", "list"];
const AGG_LABEL: Record<Agg, string> = { count: "Count of rows", sum: "Sum", avg: "Average", min: "Lowest", max: "Highest", list: "List of values" };

function Sample({ data, canPick, colMenu, setColMenu, onPick }: { data: ShapedData; canPick: boolean; colMenu: string | null; setColMenu(c: string | null): void; onPick(p: Pick): void }) {
  const cell = `min-h-8 px-2 py-1 text-left touch:min-h-11 ${canPick ? "cursor-pointer hover:bg-fg hover:text-bg" : ""}`;
  if (data.kind === "stat") {
    const formatted = typeof data.value === "number" && data.format && data.format !== "number" ? formatParts(data.value, data.format) : null;
    return (
      <div className="flex flex-col gap-1 border border-line p-3">
        <div className="flex items-baseline gap-1">
          <button type="button" disabled={!canPick} className={`${cell} text-[40px] font-semibold leading-none`} onClick={() => onPick({ kind: "stat", field: "value" })} data-pick-stat="value">{formatted ? formatted.text : short(data.value)}</button>
          {formatted?.unit || data.unit ? <button type="button" disabled={!canPick} className={cell} onClick={() => onPick({ kind: "stat", field: "unit" })} data-pick-stat="unit">{data.unit || formatted?.unit}</button> : null}
        </div>
        {data.label ? <button type="button" disabled={!canPick} className={`${cell} type-caption`} onClick={() => onPick({ kind: "stat", field: "label" })} data-pick-stat="label">{data.label}</button> : null}
      </div>
    );
  }
  if (data.kind === "table") {
    // Columns whose values are objects (Home Assistant's attributes) are not something to show or pick.
    const structured = (v: unknown) => (v !== null && typeof v === "object") || (typeof v === "string" && /^\s*[[{]/.test(v) && (() => { try { return typeof JSON.parse(v) === "object"; } catch { return false; } })());
    const columns = data.columns.filter((c) => !data.rows.slice(0, 5).some((r) => structured(r[c.key])));
    const keyCol = columns.find((c) => c.type === "text") ?? columns[0];
    const rows = data.rows.slice(0, 5);
    const total = data.total ?? data.rows.length;
    return (
      <div className="flex flex-col gap-1">
        <div className="overflow-x-auto border border-line">
          <table className="w-full border-collapse type-caption">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className="relative border-b border-line p-0 text-left font-medium">
                    <button type="button" disabled={!canPick} className={`${cell} w-full`} aria-expanded={colMenu === c.key} onClick={() => setColMenu(colMenu === c.key ? null : c.key)} data-pick-col={c.key}>{c.label}</button>
                    {colMenu === c.key && canPick && (
                      <div className="absolute left-0 top-full z-10 flex w-44 flex-col border border-line-strong bg-bg-hi p-1 shadow-window-sm" data-pick-col-menu={c.key}>
                        {(c.type === "number" ? AGGS_NUM : AGGS_TEXT).map((a) => (
                          <button key={a} type="button" className="min-h-8 px-2 text-left hover:bg-bg-sunk touch:min-h-11" onClick={() => { setColMenu(null); onPick({ kind: "column", col: c.key, colLabel: c.label, agg: a }); }} data-pick-agg={a}>{AGG_LABEL[a]}</button>
                        ))}
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const kv = keyCol ? (r[keyCol.key] as string | number | undefined) : undefined;
                const unique = kv !== undefined && data.rows.filter((x) => keyCol && x[keyCol.key] === kv).length === 1;
                return (
                  <tr key={i} className="border-b border-line last:border-0">
                    {columns.map((c) => (
                      <td key={c.key} className="p-0">
                        <button type="button" disabled={!canPick} className={`${cell} w-full`} onClick={() => onPick({ kind: "cell", col: c.key, colLabel: c.label, keyCol: keyCol!.key, keyLabel: keyCol!.label, keyValue: (kv ?? i) as string | number, index: i, unique })} data-pick-cell={`${i}:${c.key}`}>{short(r[c.key], c.format)}</button>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {total > rows.length && <p className="type-caption m-0 text-fg-2" data-pick-more>and {total - rows.length} more {total - rows.length === 1 ? "row" : "rows"}</p>}
      </div>
    );
  }
  if (data.kind === "series") {
    return (
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {data.series.map((s) => {
          const pts = s.points.filter((p): p is [number, number] => p[1] !== null);
          const last = pts.at(-1)?.[1];
          const min = Math.min(...pts.map((p) => p[1]));
          const max = Math.max(...pts.map((p) => p[1]));
          const path = pts.map((p, i) => `${(i / Math.max(1, pts.length - 1)) * 100},${max === min ? 10 : 20 - ((p[1] - min) / (max - min)) * 20}`).join(" ");
          return (
            <li key={s.name}>
              <button type="button" disabled={!canPick} className={`${row} ${cell}`} onClick={() => onPick({ kind: "series", name: s.name })} data-pick-series={s.name}>
                <span className={`min-w-0 flex-1 truncate ${s.display ? "type-body" : "font-mono text-[12px]"}`} data-pick-series-label>{s.display || s.name}</span>
                <svg viewBox="0 0 100 20" width={90} height={20} aria-hidden className="flex-none"><polyline points={path} fill="none" stroke="currentColor" strokeWidth={1.5} /></svg>
                <span className="type-body w-20 text-right">{short(last, data.unit ? undefined : data.format)}{data.unit ? ` ${data.unit}` : ""}</span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {data.items.map((it) => (
        <li key={it.label} className="flex items-center gap-2 border border-line px-2" data-pick-status={it.label}>
          <span aria-hidden className={`h-2 w-2 flex-none rounded-full ${it.state === "up" ? "bg-ok" : it.state === "down" ? "bg-bad" : it.state === "warn" ? "bg-warn" : "bg-fg-3"}`} />
          <span className="type-body min-w-0 flex-1 truncate">{it.label}</span>
          <button type="button" disabled={!canPick} className={cell} onClick={() => onPick({ kind: "status", label: it.label, field: "state" })} data-pick-status-field="state">{it.state}</button>
          {it.detail ? <button type="button" disabled={!canPick} className={`${cell} type-caption`} onClick={() => onPick({ kind: "status", label: it.label, field: "detail" })} data-pick-status-field="detail">{it.detail}</button> : null}
        </li>
      ))}
    </ul>
  );
}
