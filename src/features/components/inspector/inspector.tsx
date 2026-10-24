"use client";
// InspectorPanels (spec 3.3 and 3.2.3, design v4 "The Builder"): the Content, Data, Control, Style
// and Advanced groups for one selected component. app-builder owns the inspector frame and its Layout
// group around it. A newly selected component opens on Content and Data (plus Control); Style stays
// closed and empty until "Override theme" is on; Advanced (CSS box, visibility rule) is closed.
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AppDocument, ComponentNode, DraftOp, LibraryComponent, PropValue, RenderContext, StyleProps } from "@/core/contracts";
import { AnimatePresence, motion } from "motion/react";
import { Button, Switch, Tag, Window, transitionFor, useReducedMotion } from "@/features/shell";
import { evaluateTemplate, isBinding, parseTemplate, rootsOf, sourcesInTemplate, text as textOf } from "../bindings";
import { metaFor } from "../catalogue/meta";
import { declarations, LAYOUT_LIMITS, SHADOW_REACH_MAX, THEME_TOKENS, type StyleRefusal } from "../style/compile";
import { isLayoutType, LAYOUT_CSS_REFUSAL } from "../style/node-css-policy";
import { compileNodeStylesAction } from "../actions";
import { fieldsFor, type FieldSpec } from "./fields";
import { FIELD_WORDS } from "./labels";
import { DATA_NOTICE } from "../render/html-block";
import { detachInstance, libraryDiff } from "../library-instance";
import { blockLogs, clearBlockLogs, codeFieldProblem, subscribeBlockLogs } from "../sandbox/bridge";
import { SaveToLibrary } from "./save-to-library";
import { SOURCE_CHOICE_EVENT, takeSourceChoice } from "../render/render-node";
import { createPortal } from "react-dom";
import type { PageScope } from "../render/resolve";
import { Chevron, MoreFold } from "./more";
import { chipFrom, chipLine, chipValue, chipWords, dataSentence, lastReadWords, unknownRootSentence, unknownSourceSentence, type BindingDescriber } from "./binding-words";
import { MediaField } from "@/features/uploads/client";
import { PicturePanel } from "./picture-panel";
import { BarItemsEditor, BookmarksEditor, IconField, LinesEditor, StatsEditor, type ListEnv } from "./lists";

type Patch = Partial<Omit<ComponentNode, "id" | "children">>;
export type InspectorProps = {
  node: ComponentNode;
  doc: AppDocument;
  onChange(patch: Patch): void;
  ctx: RenderContext;
  /** Optional: raw draft ops, used by Detach (it replaces the instance with a plain subtree). */
  onOps?(ops: DraftOp[]): void;
  /**
   * Optional (Wave 2.5 data picking): opens the builder's data picker for this node, for one prop or (no
   * prop) for its whole data. When given, Data shows "Connect data" and bindable fields show "Pick data".
   */
  onConnectData?(prop?: string): void;
  /** Optional: what this node is connected to, drawn at the top of Data (spec 3.8). */
  dataSummary?: ReactNode;
  /** Optional (Wave 2.6): words for templates and facts about sources, for the data chips and the Data sentence. */
  describe?: BindingDescriber;
};

const inputCls = "w-full border border-line-strong bg-bg-hi px-2 py-1.5 type-body text-fg placeholder:text-fg-3 min-h-9 touch:min-h-11 disabled:opacity-40 aria-invalid:border-[color:var(--bad)]";
const monoCls = `${inputCls} font-mono text-[12px] leading-[18px]`;
const labelCls = "type-label text-fg-2";
const linkBtn = "self-start min-h-8 touch:min-h-11 type-caption text-accent-ink underline underline-offset-2 hover:text-fg";

// ---------- folding groups ----------

function Group({ title, open, onToggle, children, tag, groupId }: { title: string; open: boolean; onToggle(): void; children: ReactNode; tag?: ReactNode; /** The stable group id (data-inspector-group) when the title is not it. */ groupId?: string }) {
  const id = useId();
  const reduced = useReducedMotion();
  return (
    <section className="border-b border-line" data-inspector-group={groupId ?? title.toLowerCase()} data-open={open ? "" : undefined}>
      <h3 className="m-0">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} className="flex w-full min-h-10 items-center gap-2 px-3 py-2 text-left type-label text-fg hover:bg-bg-sunk">
          <Chevron open={open} />
          <span className="flex flex-1 items-center gap-2">
            {title}
            {tag}
          </span>
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="body"
            id={id}
            data-fold-body
            className="overflow-hidden"
            initial={{ height: 0, opacity: reduced ? 0 : 1 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: reduced ? 0 : 1 }}
            transition={transitionFor("sheet", reduced)}
          >
            <div className="flex flex-col gap-3 px-3 pb-4 pt-1">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

// ---------- inspector header ----------

/** The plain name a person sees for a node: its own name, or its library component's name, or its type title. Never an id. */
export function nodeDisplayName(node: ComponentNode, library?: Record<string, LibraryComponent>): { name: string; tag: string } {
  if (node.type.startsWith("lib:")) {
    const lib = node.libraryRef ? library?.[`${node.libraryRef.componentId}@${node.libraryRef.version}`] : undefined;
    return { name: node.name?.trim() || lib?.name || "Library component", tag: lib ? `library v${lib.version}` : "library" };
  }
  if (node.type.startsWith("pkg:")) return { name: node.name?.trim() || node.type.split("/").pop() || "Package component", tag: "package" };
  const meta = metaFor(node.type);
  return { name: node.name?.trim() || meta?.title || node.type, tag: node.type };
}

/** The inspector's 36px header: the node's name with a mono type tag (gauntlet w2-r1 Fix 13). app-builder mounts it. */
export function InspectorHeader({ node, library }: { node: ComponentNode; library?: Record<string, LibraryComponent> }) {
  const { name, tag } = nodeDisplayName(node, library);
  return (
    <div className="flex h-9 items-center gap-2 border-b border-line px-3" data-inspector-header>
      <span className="min-w-0 flex-1 truncate type-label text-fg">{name}</span>
      <span className="flex-none border border-line px-1.5 font-mono text-[11px] leading-4 text-fg-2" data-type-tag>
        {tag}
      </span>
    </div>
  );
}

// ---------- binding field with live value ----------

export const PREVIEW_DEBOUNCE_MS = 200;
/** A value coming back to what it was within this long after a save is the server refusing it. */
const REFUSAL_WINDOW_MS = 4000;
const ALLOWED_ROOTS = new Set(["$item", "$index", "$input", "$page", "$app", "$viewer", "$user", "$now", "$param", "$data"]);

function preview(v: unknown): string {
  if (v === undefined) return "(empty)";
  if (typeof v === "string") return v === "" ? "(empty text)" : `"${v.length > 120 ? `${v.slice(0, 117)}...` : v}"`;
  if (Array.isArray(v)) return `list of ${v.length}`;
  if (v && typeof v === "object") {
    const k = (v as { kind?: unknown }).kind;
    return typeof k === "string" ? `${k} data` : `object with ${Object.keys(v).length} fields`;
  }
  return String(v);
}

/**
 * Whether a template can be saved into the draft now: it parses, and every data source it names
 * exists. Anything else is held in the field (and kept across reselection) with the reason shown, and
 * saved by itself once it becomes valid, for example when the source it names is added.
 */
export function bindingHoldReason(template: string, sources: readonly string[] | undefined): string | null {
  if (!template.trim()) return null;
  // A half-typed binding ("{", "{{ cpu.va") is held like any unfinished template, never saved as text.
  if (/[{}]/.test(template.replace(/\{\{[\s\S]*?\}\}/g, ""))) return "The binding is not finished: write it as {{ source.value }}.";
  try {
    parseTemplate(template);
  } catch (e) {
    return (e as Error).message;
  }
  if (!sources) return null;
  for (const r of rootsOf(template)) {
    if (r.startsWith("$")) {
      if (!ALLOWED_ROOTS.has(r)) return unknownRootSentence(r);
      continue;
    }
    if (!sources.includes(r)) return unknownSourceSentence(r, sources);
  }
  return null;
}

/** An evaluation error in words: an unknown source or root names the closest real one (spec 3.2). */
export function bindingErrorWords(template: string, error: { code: string; message: string }, sources: readonly string[] | undefined): string {
  if (error.code !== "binding.unknown_source" && error.code !== "binding.unknown_root") return error.message;
  let roots: string[] = [];
  try {
    roots = rootsOf(template);
  } catch {
    return error.message;
  }
  if (error.code === "binding.unknown_root") {
    const r = roots.find((x) => x.startsWith("$") && !ALLOWED_ROOTS.has(x));
    return r ? unknownRootSentence(r) : error.message;
  }
  const r = roots.find((x) => !x.startsWith("$") && !(sources ?? []).includes(x));
  return r ? unknownSourceSentence(r, sources ?? []) : error.message;
}

/** Where a syntax error sits, as a short quote of the text there ("near ..."). */
function near(template: string, position?: number): string {
  if (position === undefined || position < 0 || position > template.length) return "";
  const bit = template.slice(position, position + 12).trim();
  return bit ? ` Near "${bit}".` : " At the end.";
}

const held = new Map<string, string>();
/** Test hook: forget held bindings. */
export function clearHeldBindings(): void {
  held.clear();
}
function forgetHeld(key: string): void {
  held.delete(key);
}

/**
 * "Use a fixed value": the literal the binding already holds (plain text, or a constant expression such
 * as {{ 512 }}), converted for the field; a binding that reads data has no literal, so the field empties.
 */
export function fixedValueOf(template: string, spec: Pick<FieldSpec, "field">): PropValue | null {
  const t = template.trim();
  if (!t) return null;
  let v: unknown = t;
  if (t.includes("{{")) {
    try {
      if (rootsOf(t).length) return null;
    } catch {
      return null;
    }
    const r = evaluateTemplate(t, {} as PageScope);
    if (!r.ok || r.value === undefined || r.value === null || typeof r.value === "object") return null;
    v = r.value;
  }
  if (spec.field.kind === "number") {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (spec.field.kind === "boolean") return v === true || v === "true";
  return typeof v === "string" ? v : String(v);
}

/** The Data panel's template box: shows the live value (or the error and where it is) within 300ms. */
export function BindingField({ label, value, onChange, scope, description, name, sources, holdKey }: { label: string; value: string; onChange(t: string): void; scope: PageScope; description?: string; name?: string; sources?: readonly string[]; holdKey?: string }) {
  const id = useId();
  const [draft, setDraft] = useState(() => (holdKey && held.has(holdKey) ? held.get(holdKey)! : value));
  const [shown, setShown] = useState<{ ok: boolean; text: string }>({ ok: true, text: "" });
  const [refused, setRefused] = useState(false);
  const sent = useRef<{ text: string; before: string; at: number } | null>(null);
  const lastValue = useRef(value);
  // External changes (undo, another editor, an agent) replace the text; the echo of our own save and a
  // refusal that sends the old value back do not.
  useEffect(() => {
    const prev = lastValue.current;
    lastValue.current = value;
    if (value === prev) return;
    const s = sent.current;
    if (s && value === s.text) return;
    if (s && value === s.before && Date.now() - s.at < REFUSAL_WINDOW_MS && draft === s.text) {
      setRefused(true);
      if (holdKey) held.set(holdKey, draft);
      return;
    }
    sent.current = null;
    setRefused(false);
    if (holdKey) held.delete(holdKey);
    setDraft(value);
  }, [value]);
  const holdReason = bindingHoldReason(draft, sources);
  const commit = (t: string) => {
    if (bindingHoldReason(t, sources)) {
      if (holdKey) held.set(holdKey, t);
      return;
    }
    if (holdKey) held.delete(holdKey);
    if (t === value) return;
    sent.current = { text: t, before: value, at: Date.now() };
    setRefused(false);
    onChange(t);
  };
  // A held binding saves itself once it becomes valid (the source it names was added).
  const sourcesKey = (sources ?? []).join("\u0000");
  useEffect(() => {
    if (draft !== value && !bindingHoldReason(draft, sources) && holdKey && held.has(holdKey)) commit(draft);
  }, [sourcesKey]);
  useEffect(() => {
    const h = setTimeout(() => {
      if (!draft.trim()) return setShown({ ok: true, text: "" });
      const r = evaluateTemplate(draft, scope);
      setShown(r.ok ? { ok: true, text: preview(r.value) } : { ok: false, text: `${bindingErrorWords(draft, r.error, sources)}${r.error.code === "binding.syntax" ? near(draft, r.error.position) : ""}` });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [draft, scope]);
  const pending = holdReason !== null || refused;
  return (
    <div className="flex flex-col gap-1" data-binding-field={name ?? label} data-binding-held={pending ? "" : undefined}>
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      <textarea
        id={id}
        rows={Math.min(4, Math.max(1, Math.ceil(draft.length / 34)))}
        className={monoCls}
        value={draft}
        spellCheck={false}
        placeholder="{{ source.value }}"
        aria-invalid={!shown.ok || pending || undefined}
        aria-describedby={`${id}-v ${id}-h`}
        onChange={(e) => {
          setDraft(e.target.value);
          commit(e.target.value);
        }}
      />
      <p id={`${id}-v`} role="status" aria-live="polite" className={`type-caption m-0 font-mono ${shown.ok ? "text-fg-2" : "text-[color:var(--bad)]"}`} data-live-value={shown.ok ? "ok" : "error"}>
        {shown.text ? (shown.ok ? `= ${shown.text}` : shown.text) : null}
      </p>
      <p id={`${id}-h`} className="type-caption m-0 text-[color:var(--warn-ink)]" data-binding-hold>
        {holdReason ? `Not saved yet: ${holdReason} It is kept here and saves once it works.` : refused ? "Not saved: Atrium refused this binding. It is kept here; fix it and it saves." : null}
      </p>
      {description ? <p className="type-caption m-0 text-fg-3">{description}</p> : null}
    </div>
  );
}

// ---------- switch rows ----------

/**
 * A switch row with the inspector's own label: mono `--type-label` at the field's left edge, sentence
 * case, the description under it and the switch on the right (gauntlet w2-r2 Fix 13). The label is a
 * real <label> for the switch, so a click on it toggles.
 */
export function SwitchRow({ label, description, checked, onCheckedChange, id: given }: { label: string; description?: string; checked: boolean; onCheckedChange(c: boolean): void; id?: string }) {
  const auto = useId();
  const id = given ?? `sw-${auto}`;
  return (
    <div className="flex items-center justify-between gap-3" data-switch-field>
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className={`${labelCls} cursor-pointer`} data-switch-label>
          {label}
        </label>
        {description ? <span className="type-caption text-fg-3">{description}</span> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} aria-label={label} className="flex-none" />
    </div>
  );
}

// ---------- literal fields ----------

function LiteralField({ spec, value, onChange }: { spec: FieldSpec; value: PropValue | undefined; onChange(v: PropValue | null): void }) {
  const id = useId();
  const f = spec.field;
  const label = (
    <label htmlFor={id} className={labelCls} title={spec.description || undefined}>
      {spec.label}
    </label>
  );
  const help = spec.hint ? <p className="type-caption m-0 text-fg-3" data-field-hint>{spec.hint}</p> : null;
  switch (f.kind) {
    case "boolean":
      return (
        <div className="flex flex-col gap-1">
          <SwitchRow id={id} checked={value === true} onCheckedChange={(c) => onChange(c)} label={spec.label} description={spec.hint || undefined} />
        </div>
      );
    case "number":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <input id={id} type="number" className={inputCls} value={typeof value === "number" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
          {help}
        </div>
      );
    case "enum":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <select id={id} className={inputCls} value={value === undefined || value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : f.options.find((o) => String(o) === e.target.value) ?? e.target.value)}>
            <option value="">Default</option>
            {f.options.map((o) => (
              <option key={String(o)} value={String(o)}>
                {spec.optionWords?.[String(o)] ?? String(o)}
              </option>
            ))}
          </select>
          {help}
        </div>
      );
    case "strings":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <input id={id} className={inputCls} value={Array.isArray(value) ? value.join(", ") : ""} onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
          {help}
        </div>
      );
    case "options": {
      const opts = (Array.isArray(value) ? value : []) as { label: string; value: string }[];
      return (
        <div className="flex flex-col gap-1">
          <span className={labelCls}>{spec.label}</span>
          {opts.map((o, i) => (
            <div key={i} className="flex gap-1">
              <input aria-label={`Option ${i + 1} label`} className={inputCls} value={o.label} onChange={(e) => onChange(opts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <input aria-label={`Option ${i + 1} value`} className={monoCls} value={o.value} onChange={(e) => onChange(opts.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <Button variant="quiet" aria-label={`Remove option ${i + 1}`} onClick={() => onChange(opts.filter((_, j) => j !== i))}>
                ×
              </Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => onChange([...opts, { label: `Option ${opts.length + 1}`, value: `option${opts.length + 1}` }])}>
            Add option
          </Button>
          {help}
        </div>
      );
    }
    case "json":
    case "data":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <input id={id} className={monoCls} value={value === undefined ? "" : JSON.stringify(value)} onChange={(e) => {
            try {
              onChange(e.target.value === "" ? null : (JSON.parse(e.target.value) as PropValue));
            } catch {
              /* keep typing */
            }
          }} />
          {help}
        </div>
      );
    default:
      return (
        <div className="flex flex-col gap-1">
          {label}
          {f.long ? (
            <textarea id={id} rows={3} className={inputCls} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />
          ) : (
            <input id={id} className={inputCls} value={typeof value === "string" || typeof value === "number" ? String(value) : ""} onChange={(e) => onChange(e.target.value)} />
          )}
          {help}
        </div>
      );
  }
}

/** Template edits shown under a chip, per node and field (kept while the inspector is open). */
const editingTemplate = new Set<string>();

/**
 * The data chip (spec 3.3): what a bound field shows in words, its value now and where it comes from
 * ("Lights on · 4 · Home Assistant, every 10 s"). A failing source shows its last value with the failing
 * mark and when it was last read. Clicking it opens the data picker on this field.
 */
export function DataChip({ prop, template, scope, describe, onOpen }: { prop: string; template: string; scope: PageScope; describe?: BindingDescriber; onOpen?(): void }) {
  const src = sourcesInTemplate(template)[0] ?? "";
  const facts = describe?.source?.(src) ?? null;
  const r = evaluateTemplate(template, scope);
  const value = r.ok ? chipValue(r.value) : "no value yet";
  const failing = facts?.state === "failed" || facts?.state === "stale";
  const line = chipLine(chipWords(template, src, describe), value, chipFrom(src, facts));
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden className={`h-2 w-2 flex-none ${failing ? "bg-[color:var(--bad)]" : facts?.state === "fresh" ? "bg-[color:var(--ok)]" : "bg-fg-3"}`} />
        <span className="min-w-0 type-caption text-fg" data-chip-line>{line}</span>
      </span>
      {failing ? (
        <span className="type-caption text-[color:var(--bad)]" data-chip-stale>
          {facts?.state === "failed" ? "Failing" : "Out of date"}: {lastReadWords(facts?.fetchedAt)}
        </span>
      ) : null}
    </>
  );
  const cls = "flex w-full flex-col items-start gap-0.5 border border-line-strong bg-bg-sunk px-2 py-1.5 text-left min-h-9 touch:min-h-11";
  return onOpen ? (
    <button type="button" className={`${cls} hover:border-fg`} onClick={onOpen} title="Change what this shows" data-data-chip={prop} data-chip-state={facts?.state ?? "unknown"}>
      {body}
    </button>
  ) : (
    <div className={cls} data-data-chip={prop} data-chip-state={facts?.state ?? "unknown"}>
      {body}
    </div>
  );
}

/** A bound field's template reads only sources that exist and saves as it is: it can show as a chip. */
export function chipFits(template: string, sources: readonly string[] | undefined): boolean {
  if (!template.trim() || bindingHoldReason(template, sources)) return false;
  try {
    const s = sourcesInTemplate(template);
    return s.length > 0 && s.every((x) => !sources || sources.includes(x));
  } catch {
    return false;
  }
}

/** A prop field: a literal editor, or (switched with "Live data") a binding, shown as a data chip. */
function PropField({ spec, node, scope, setProp, sources, onPick, describe, inlineLive = true }: { spec: FieldSpec; node: ComponentNode; scope: PageScope; setProp(k: string, v: PropValue | null): void; sources?: readonly string[]; onPick?(prop: string): void; describe?: BindingDescriber; /** False on a data widget's simple fields: their Pick data and Live data sit under More settings (data ease spec 3.1). */ inlineLive?: boolean }) {
  const value = node.props[spec.key];
  const bound = isBinding(value) || spec.field.kind === "data";
  const holdKey = `${node.id}:${spec.key}`;
  const [asTemplate, setAsTemplate] = useState(() => editingTemplate.has(holdKey) || held.has(holdKey));
  if (bound) {
    const template = isBinding(value) ? value.$bind : "";
    const chip = !asTemplate && chipFits(template, sources);
    // An empty data field with the picker at hand offers "Pick data" first, not a raw template box.
    if (spec.field.kind === "data" && !template.trim() && onPick && !asTemplate) {
      return (
        <div className="flex flex-col gap-1" data-field={spec.key} data-data-empty={spec.key}>
          <span className={labelCls} title={spec.description || undefined}>{spec.label}</span>
          {spec.hint ? <p className="type-caption m-0 text-fg-3" data-field-hint>{spec.hint}</p> : null}
          <span className="flex flex-wrap items-center gap-x-3">
            <button type="button" className={linkBtn} data-pick-button={spec.key} onClick={() => onPick(spec.key)}>
              Pick data
            </button>
            <button type="button" className={linkBtn} data-edit-template={spec.key} onClick={() => setAsTemplate(true)}>
              Write a template
            </button>
          </span>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1" data-field={spec.key}>
        {chip ? (
          <div className="flex flex-col gap-1" data-binding-chip-field={spec.key}>
            <span className={labelCls} title={spec.description || undefined}>{spec.label}</span>
            <DataChip prop={spec.key} template={template} scope={scope} describe={describe} {...(onPick && spec.bindable ? { onOpen: () => onPick(spec.key) } : {})} />
            {spec.hint ? <p className="type-caption m-0 text-fg-3" data-field-hint>{spec.hint}</p> : null}
            <button
              type="button"
              className={linkBtn}
              data-edit-template={spec.key}
              onClick={() => {
                editingTemplate.add(holdKey);
                setAsTemplate(true);
              }}
            >
              Edit as template
            </button>
          </div>
        ) : (
          // Once the person works in the template box it stays a box (no chip appears mid-typing).
          <div className="contents" onFocus={() => setAsTemplate(true)}>
          <BindingField
            name={spec.key}
            label={spec.label}
            description={spec.hint}
            value={template}
            scope={scope}
            sources={sources}
            holdKey={holdKey}
            // Emptying a bound field saves an empty binding (it stays a binding until "Type it in").
            onChange={(t) => setProp(spec.key, t.trim() ? { $bind: t } : spec.field.kind === "data" ? null : { $bind: "" })}
          />
          </div>
        )}
        {asTemplate && chipFits(template, sources) ? (
          <button
            type="button"
            className={linkBtn}
            data-show-chip={spec.key}
            onClick={() => {
              editingTemplate.delete(holdKey);
              setAsTemplate(false);
            }}
          >
            Show in words
          </button>
        ) : null}
        {spec.field.kind !== "data" ? (
          <button
            type="button"
            className={linkBtn}
            data-unbind={spec.key}
            onClick={() => {
              forgetHeld(holdKey);
              editingTemplate.delete(holdKey);
              setProp(spec.key, fixedValueOf(template, spec));
            }}
          >
            Type it in
          </button>
        ) : null}
        {onPick && spec.bindable && !chip ? (
          <button type="button" className={linkBtn} data-pick-button={spec.key} onClick={() => onPick(spec.key)}>
            Pick data
          </button>
        ) : null}
      </div>
    );
  }
  // Text that looks like a binding in a plain field offers to become one (gauntlet w2-r2 Fix 10).
  const looksBound = spec.bindable && typeof value === "string" && value.trim().startsWith("{{");
  return (
    <div className="flex flex-col gap-1" data-field={spec.key}>
      <LiteralField spec={spec} value={value} onChange={(v) => setProp(spec.key, v)} />
      {looksBound ? (
        <p role="note" className="type-caption m-0 flex flex-wrap items-center gap-x-2 text-fg-2" data-looks-bound={spec.key}>
          This looks like live data.
          <button type="button" className={linkBtn} data-bind-it={spec.key} onClick={() => setProp(spec.key, { $bind: String(value) })}>
            Use it as live data
          </button>
        </p>
      ) : null}
      {inlineLive && spec.bindable && !looksBound ? <LiveDataLinks spec={spec} value={value} setProp={setProp} {...(onPick ? { onPick } : {})} /> : null}
    </div>
  );
}

/** "Pick data" and "Live data" for one literal field: under the field, or (data widgets) under More settings. */
function LiveDataLinks({ spec, value, setProp, onPick, withLabel }: { spec: FieldSpec; value: PropValue | undefined; setProp(k: string, v: PropValue | null): void; onPick?(prop: string): void; withLabel?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3" data-live-links={spec.key}>
      {withLabel ? <span className="type-caption text-fg-2">{spec.label}:</span> : null}
      {onPick ? (
        <button type="button" className={linkBtn} data-pick-button={spec.key} onClick={() => onPick(spec.key)}>
          Pick data
        </button>
      ) : null}
      <button type="button" className={linkBtn} data-bind-button={spec.key} title="Show a value from your data instead, written as a template" onClick={() => setProp(spec.key, { $bind: value === undefined || value === null ? "" : `{{ ${JSON.stringify(value).replace(/"/g, "'")} }}` })}>
        Live data
      </button>
    </span>
  );
}

// ---------- style ----------
// The Style group without writing CSS (gauntlet w2-r1 Fix 5): the common properties first with
// pickers (theme colour swatches by name, steppers, a slider, choices), plain-language labels, and the
// rest under "More". Every value still goes through the same per-property check as before.

const STYLE_LABELS: Partial<Record<keyof StyleProps, string>> = {
  background: "Background", color: "Text colour", borderWidth: "Border width", borderColor: "Border colour", borderRadius: "Corners", padding: "Padding", boxShadow: "Shadow",
  margin: "Outer spacing", width: "Width", height: "Height", minHeight: "Minimum height", maxWidth: "Maximum width", gap: "Space between items", display: "Layout", flexDirection: "Direction",
  alignItems: "Align items", justifyContent: "Distribute items", overflow: "Overflowing content", backgroundImage: "Background image", opacity: "Opacity", backdropFilter: "Blur behind",
  filter: "Filter", mixBlendMode: "Blend mode", border: "Border (full)", outline: "Outline", fontFamily: "Font", fontSize: "Text size", fontWeight: "Weight", lineHeight: "Line height",
  letterSpacing: "Letter spacing", textAlign: "Text alignment", textTransform: "Capitals", fontVariantNumeric: "Number style", textShadow: "Text shadow", transition: "Transition",
  transform: "Transform", animation: "Animation",
};
const styleLabel = (p: keyof StyleProps) => STYLE_LABELS[p] ?? p.replace(/([A-Z])/g, " $1").toLowerCase();

const TOKEN_NAMES: Record<(typeof THEME_TOKENS)[number], string> = { surface: "Surface", surfaceText: "Surface text", surfaceMuted: "Muted text", canvasText: "Page text", accent: "Accent", accentText: "Text on accent", ok: "Good", warn: "Warning", bad: "Problem", info: "Info", line: "Line" };
const TOKEN_FALLBACK: Record<string, string> = { surface: "#FBF9F3", surfaceText: "#15130F", surfaceMuted: "#5E584C", canvasText: "#15130F", accent: "#E9B949", accentText: "#15130F", ok: "#2E7D4F", warn: "#B5770C", bad: "#B23A2B", info: "#2F6FB0", line: "#D9D3C4" };
const kebabTok = (t: string) => t.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The theme's colours as the canvas resolves them, for the swatches (read from the canvas on screen). */
function useThemeSwatches(): Record<string, string> {
  const [sw, setSw] = useState<Record<string, string>>(TOKEN_FALLBACK);
  useEffect(() => {
    const el = document.querySelector("[data-atrium-canvas]");
    if (!el) return;
    const cs = getComputedStyle(el);
    const out: Record<string, string> = { ...TOKEN_FALLBACK };
    for (const t of THEME_TOKENS) {
      const v = cs.getPropertyValue(`--theme-${kebabTok(t)}`).trim();
      if (v) out[t] = v;
    }
    setSw(out);
  }, []);
  return sw;
}

const ENUM_CHOICES: Partial<Record<keyof StyleProps, { value: string; label: string }[]>> = {
  display: [{ value: "block", label: "Block" }, { value: "flex", label: "Row or column" }, { value: "grid", label: "Grid" }, { value: "inline-block", label: "Inline" }, { value: "none", label: "Hidden" }],
  flexDirection: [{ value: "row", label: "Across" }, { value: "column", label: "Down" }],
  alignItems: [{ value: "start", label: "Start" }, { value: "center", label: "Centre" }, { value: "end", label: "End" }, { value: "stretch", label: "Stretch" }],
  justifyContent: [{ value: "start", label: "Start" }, { value: "center", label: "Centre" }, { value: "end", label: "End" }, { value: "space-between", label: "Spread" }],
  overflow: [{ value: "visible", label: "Show" }, { value: "hidden", label: "Cut off" }, { value: "auto", label: "Scroll" }],
  textAlign: [{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }],
  textTransform: [{ value: "none", label: "As typed" }, { value: "uppercase", label: "ALL CAPS" }, { value: "lowercase", label: "lower" }, { value: "capitalize", label: "Title" }],
  fontVariantNumeric: [{ value: "tabular-nums", label: "Even width" }, { value: "proportional-nums", label: "Natural" }],
  fontWeight: [{ value: "400", label: "Regular" }, { value: "500", label: "Medium" }, { value: "600", label: "Semibold" }, { value: "700", label: "Bold" }],
  animation: [{ value: "none", label: "None" }, { value: "fade-in", label: "Fade in" }, { value: "rise", label: "Rise" }, { value: "pulse", label: "Pulse" }, { value: "glow", label: "Glow" }],
  mixBlendMode: [{ value: "normal", label: "Normal" }, { value: "multiply", label: "Multiply" }, { value: "screen", label: "Screen" }, { value: "overlay", label: "Overlay" }],
};
const LENGTHS = new Set<keyof StyleProps>(["padding", "margin", "width", "height", "minHeight", "maxWidth", "gap", "borderWidth", "borderRadius", "fontSize", "letterSpacing"]);
const SHADOWS: { value: string; label: string }[] = [
  { value: "", label: "Theme" },
  { value: "none", label: "None" },
  { value: "0 12px 32px rgb(0 0 0 / 0.14)", label: "Soft" },
  { value: "6px 6px 0 0 token:surfaceText", label: "Hard" },
];
/** The short style set (spec 3.2): no theme knowledge needed. Border is its width and colour together. */
const COMMON: (keyof StyleProps)[] = ["background", "color", "borderRadius", "padding", "borderWidth", "borderColor", "boxShadow", "fontSize"];
const MORE: (keyof StyleProps)[] = ["fontWeight", "textAlign", "textTransform", "lineHeight", "letterSpacing", "fontVariantNumeric", "fontFamily", "margin", "width", "height", "minHeight", "maxWidth", "gap", "display", "flexDirection", "alignItems", "justifyContent", "overflow", "opacity", "animation", "mixBlendMode", "backgroundImage", "border", "outline", "backdropFilter", "filter", "textShadow", "transition", "transform"];

/** True inside the Style panel of a layout node: its sizes are bounded (style/compile.ts LAYOUT_LIMITS). */
const LayoutStyle = createContext(false);

function refusalOf(prop: keyof StyleProps, v: unknown, layout = false): string | null {
  if (v === undefined || v === "") return null;
  const r: StyleRefusal[] = [];
  declarations({ [prop]: v } as StyleProps, { slot: "x" }, r, { layout });
  return r[0]?.reason ?? null;
}

function Refused({ prop, reason }: { prop: string; reason: string | null }) {
  return reason ? (
    <p role="alert" className="type-caption m-0 text-[color:var(--bad)]" data-style-refused={prop}>
      Not applied: {reason}
    </p>
  ) : null;
}

/** A free-text value with the per-property check (for gradients, filters and the rare properties). */
function TextStyle({ prop, value, onChange, placeholder, label }: { prop: keyof StyleProps; value: unknown; onChange(v: unknown): void; placeholder?: string; label?: string }) {
  const id = useId();
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  const layout = useContext(LayoutStyle);
  const parse = (raw: string): unknown => (raw === "" ? undefined : (prop === "opacity" || prop === "lineHeight") && /^-?\d*\.?\d+$/.test(raw) ? Number(raw) : prop === "fontWeight" && /^\d+$/.test(raw) ? Number(raw) : raw);
  const reason = refusalOf(prop, parse(draft.trim()), layout);
  return (
    <>
      {label ? <label htmlFor={id} className="sr-only">{label}</label> : null}
      <input
        id={id}
        className={monoCls}
        value={draft}
        data-style-text
        aria-label={label ? undefined : `${styleLabel(prop)} (CSS value)`}
        aria-invalid={reason ? true : undefined}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = parse(e.target.value.trim());
          if (!refusalOf(prop, v, layout)) onChange(v); // a refused value is not applied
        }}
      />
      <Refused prop={prop} reason={reason} />
    </>
  );
}

/** Theme colours by name, a custom colour picker, and the CSS value for gradients. */
function SwatchField({ prop, value, onChange, swatches }: { prop: keyof StyleProps; value: unknown; onChange(v: unknown): void; swatches: Record<string, string> }) {
  const current = typeof value === "string" ? value : "";
  const hex = /^#[0-9a-f]{6}$/i.test(current) ? current : "#000000";
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0" data-style-field={prop}>
      <legend className={`${labelCls} mb-1`}>{styleLabel(prop)}</legend>
      <div className="flex flex-wrap gap-1" role="group" aria-label={`${styleLabel(prop)}: theme colours`}>
        {THEME_TOKENS.map((t) => {
          const on = current === `token:${t}`;
          return (
            <button
              key={t}
              type="button"
              aria-pressed={on}
              title={TOKEN_NAMES[t]}
              aria-label={TOKEN_NAMES[t]}
              data-swatch={t}
              onClick={() => onChange(on ? undefined : `token:${t}`)}
              className={`h-7 w-7 touch:h-11 touch:w-11 border ${on ? "border-2 border-fg outline outline-1 outline-offset-1 outline-accent-ink" : "border-line-strong"}`}
              style={{ background: swatches[t] }}
            />
          );
        })}
        <label className="relative h-7 w-7 touch:h-11 touch:w-11 cursor-pointer border border-dashed border-line-strong" title="Custom colour" data-swatch-custom>
          <span className="sr-only">Custom colour</span>
          <input type="color" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" value={hex} onChange={(e) => onChange(e.target.value)} />
          <span aria-hidden className="absolute inset-1" style={{ background: current && !current.startsWith("token:") ? current : "transparent" }} />
        </label>
      </div>
      {current.startsWith("token:") ? <p className="type-caption m-0 text-fg-2">{TOKEN_NAMES[current.slice(6) as keyof typeof TOKEN_NAMES] ?? current}</p> : null}
      <TextStyle prop={prop} value={value} onChange={onChange} placeholder={prop === "color" ? "#15130F or token:accent" : "#E9B949, a gradient or token:accent"} />
    </fieldset>
  );
}

/** A number with a unit, a stepper (and a slider for corner radius). */
function LengthField({ prop, value, onChange }: { prop: keyof StyleProps; value: unknown; onChange(v: unknown): void }) {
  const id = useId();
  const layout = useContext(LayoutStyle);
  const [tooBig, setTooBig] = useState<string | null>(null);
  const m = typeof value === "number" ? { n: value, u: "px" } : typeof value === "string" ? (/^(-?\d*\.?\d+)(px|rem|em|%)?$/.exec(value.trim()) ? { n: Number(/^(-?\d*\.?\d+)/.exec(value.trim())![1]), u: /(px|rem|em|%)$/.exec(value.trim())?.[1] ?? "px" } : null) : { n: NaN, u: "px" };
  if (m === null) {
    // A multi-value length (for example "8px 16px") keeps its text box.
    return (
      <div className="flex flex-col gap-1" data-style-field={prop}>
        <span className={labelCls}>{styleLabel(prop)}</span>
        <TextStyle prop={prop} value={value} onChange={onChange} />
      </div>
    );
  }
  const max = Math.min(prop === "borderRadius" ? 32 : prop === "borderWidth" ? 8 : 400, layout ? LAYOUT_LIMITS[prop] ?? 400 : 400);
  // On a layout a size past its limit is refused (and named), never applied (gauntlet w2-r3 item 3).
  const set = (n: number, u = m.u) => {
    const v = Number.isFinite(n) ? (u === "px" ? n : `${n}${u}`) : undefined;
    const why = refusalOf(prop, v, layout);
    setTooBig(why);
    if (!why) onChange(v);
  };
  return (
    <div className="flex flex-col gap-1" data-style-field={prop}>
      <label htmlFor={id} className={labelCls}>
        {styleLabel(prop)}
      </label>
      <div className="flex items-center gap-1">
        <Button variant="quiet" aria-label={`Less ${styleLabel(prop).toLowerCase()}`} onClick={() => set(Math.max(prop === "margin" || prop === "letterSpacing" ? -max : 0, (Number.isFinite(m.n) ? m.n : 0) - 1))} data-step="down">
          −
        </Button>
        <input id={id} type="number" inputMode="decimal" className={`${monoCls} w-20`} value={Number.isFinite(m.n) ? m.n : ""} placeholder="theme" data-style-number onChange={(e) => (e.target.value === "" ? onChange(undefined) : set(Number(e.target.value)))} />
        <Button variant="quiet" aria-label={`More ${styleLabel(prop).toLowerCase()}`} onClick={() => set(Math.min(max, (Number.isFinite(m.n) ? m.n : 0) + 1))} data-step="up">
          +
        </Button>
        <select aria-label={`${styleLabel(prop)} unit`} className={`${inputCls} w-20`} value={m.u} onChange={(e) => Number.isFinite(m.n) && set(m.n, e.target.value)} data-style-unit>
          {["px", "rem", "em", "%"].map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      </div>
      {prop === "borderRadius" || prop === "borderWidth" ? (
        <input type="range" min={0} max={max} step={1} aria-label={`${styleLabel(prop)} slider`} value={Number.isFinite(m.n) && m.u === "px" ? m.n : 0} onChange={(e) => set(Number(e.target.value), "px")} data-style-slider className="w-full accent-[var(--accent)] touch:h-11 max-sm:h-11" />
      ) : null}
      <Refused prop={prop} reason={tooBig} />
    </div>
  );
}

function ChoiceField({ prop, value, onChange }: { prop: keyof StyleProps; value: unknown; onChange(v: unknown): void }) {
  const choices = ENUM_CHOICES[prop] ?? [];
  const current = value === undefined ? "" : String(value);
  const few = choices.length <= 4;
  return (
    <div className="flex flex-col gap-1" data-style-field={prop}>
      <span className={labelCls} id={`sl-${prop}`}>{styleLabel(prop)}</span>
      {few ? (
        <div role="radiogroup" aria-labelledby={`sl-${prop}`} className="flex flex-wrap gap-1">
          {[{ value: "", label: "Theme" }, ...choices].map((c) => (
            <button key={c.value || "theme"} type="button" role="radio" aria-checked={current === c.value} data-choice={c.value || "theme"} onClick={() => onChange(c.value === "" ? undefined : prop === "fontWeight" ? Number(c.value) : c.value)} className={`min-h-8 touch:min-h-11 border px-2 type-caption ${current === c.value ? "border-fg bg-fg text-bg" : "border-line-strong text-fg"}`}>
              {c.label}
            </button>
          ))}
        </div>
      ) : (
        <select aria-labelledby={`sl-${prop}`} className={inputCls} value={current} onChange={(e) => onChange(e.target.value === "" ? undefined : prop === "fontWeight" ? Number(e.target.value) : e.target.value)} data-style-choice>
          <option value="">Theme</option>
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function OpacityField({ value, onChange }: { value: unknown; onChange(v: unknown): void }) {
  const id = useId();
  const v = typeof value === "number" ? value : 1;
  return (
    <div className="flex flex-col gap-1" data-style-field="opacity">
      <label htmlFor={id} className={labelCls}>
        {styleLabel("opacity")} <span className="font-mono">{Math.round(v * 100)}%</span>
      </label>
      <input id={id} type="range" min={0} max={1} step={0.05} value={v} onChange={(e) => onChange(Number(e.target.value) === 1 ? undefined : Number(e.target.value))} className="w-full accent-[var(--accent)]" data-style-slider />
    </div>
  );
}

function ShadowField({ value, onChange }: { value: unknown; onChange(v: unknown): void }) {
  const current = typeof value === "string" ? value : "";
  const preset = SHADOWS.find((s) => s.value === current);
  return (
    <div className="flex flex-col gap-1" data-style-field="boxShadow">
      <span className={labelCls} id="sl-boxShadow">{styleLabel("boxShadow")}</span>
      <div role="radiogroup" aria-labelledby="sl-boxShadow" className="flex flex-wrap gap-1">
        {SHADOWS.map((s) => (
          <button key={s.label} type="button" role="radio" aria-checked={(preset?.value ?? null) === s.value} data-choice={s.label.toLowerCase()} onClick={() => onChange(s.value === "" ? undefined : s.value)} className={`min-h-8 touch:min-h-11 border px-2 type-caption ${(preset?.value ?? null) === s.value ? "border-fg bg-fg text-bg" : "border-line-strong text-fg"}`}>
            {s.label}
          </button>
        ))}
      </div>
      {!preset ? <TextStyle prop="boxShadow" value={value} onChange={onChange} /> : null}
      <p className="type-caption m-0 text-fg-3" data-shadow-reach>
        A shadow may reach up to {SHADOW_REACH_MAX}px past the component (offset, blur and spread together). It is never cut off.
      </p>
    </div>
  );
}

function StyleControl({ prop, value, onChange, swatches }: { prop: keyof StyleProps; value: unknown; onChange(v: unknown): void; swatches: Record<string, string> }) {
  if (prop === "background" || prop === "color" || prop === "borderColor") return <SwatchField prop={prop} value={value} onChange={onChange} swatches={swatches} />;
  if (prop === "boxShadow") return <ShadowField value={value} onChange={onChange} />;
  if (prop === "opacity") return <OpacityField value={value} onChange={onChange} />;
  if (ENUM_CHOICES[prop]) return <ChoiceField prop={prop} value={value} onChange={onChange} />;
  if (LENGTHS.has(prop)) return <LengthField prop={prop} value={value} onChange={onChange} />;
  return (
    <div className="flex flex-col gap-1" data-style-field={prop}>
      <span className={labelCls}>{styleLabel(prop)}</span>
      <TextStyle prop={prop} value={value} onChange={onChange} placeholder={prop === "backgroundImage" ? "url(/uploads/...) or a gradient" : undefined} />
    </div>
  );
}

const SLOT_LABELS: Record<string, string> = { icon: "Icon", name: "Name", badge: "Status badge", stat: "Each number", bar: "Small bar", search: "Search box", clock: "Clock", domain: "Domain", root: "Whole component", value: "Value", label: "Label", unit: "Unit", delta: "Change", title: "Title", body: "Body", tab: "Tabs", panel: "Panel", description: "Description", item: "Each item", legend: "Legend", axis: "Axes", header: "Header row", row: "Rows", cell: "Cells", detail: "Detail", track: "Track", fill: "Fill", thumb: "Handle", field: "Field", time: "Time", date: "Date" };
const STATE_LABELS: Record<string, string> = { hover: "Pointer over", active: "Pressed", focus: "Keyboard focus", on: "On", off: "Off", disabled: "Disabled" };

const STYLE_HINTS: Partial<Record<keyof StyleProps, string>> = {
  background: "The colour or picture behind the component",
  color: "The colour of its words",
  borderRadius: "How round the corners are",
  padding: "Space between the edge and what is inside",
  boxShadow: "A shadow under the component",
  fontSize: "How big the words are",
};

function StylePanel({ node, onChange }: { node: ComponentNode; onChange(p: Patch): void }) {
  const meta = metaFor(node.type);
  const slots = meta?.styleSlots ?? ["root"];
  const states = meta?.states ?? [];
  const [slot, setSlot] = useState(slots[0]!);
  const [state, setState] = useState<string>("");
  const [mobile, setMobile] = useState(false);
  const swatches = useThemeSwatches();
  const source = mobile ? node.responsive?.mobile?.style ?? {} : node.style ?? {};
  const slotStyle = (source[slot] ?? {}) as StyleProps & { states?: Record<string, StyleProps> };
  const current: StyleProps = state ? slotStyle.states?.[state] ?? {} : slotStyle;
  const set = (prop: keyof StyleProps, v: unknown) => {
    const nextCurrent = { ...current, [prop]: v };
    if (v === undefined) delete (nextCurrent as Record<string, unknown>)[prop];
    const nextSlot = state ? { ...slotStyle, states: { ...(slotStyle.states ?? {}), [state]: nextCurrent } } : { ...nextCurrent, ...(slotStyle.states ? { states: slotStyle.states } : {}) };
    const next = { ...source, [slot]: nextSlot };
    if (mobile) onChange({ responsive: { ...(node.responsive ?? {}), mobile: { ...(node.responsive?.mobile ?? {}), style: next } } });
    else onChange({ style: next });
  };
  const moreSet = MORE.filter((p) => (current as Record<string, unknown>)[p] !== undefined).length + (slot !== slots[0] ? 1 : 0) + (state ? 1 : 0) + (mobile ? 1 : 0);
  const key = `${slot}-${state}-${mobile}`;
  const layout = isLayoutType(node.type);
  // While More style points the short set at a part, a state or phones, the short set says so.
  const target = [slot !== slots[0] ? SLOT_LABELS[slot] ?? slot : null, state ? STATE_LABELS[state] ?? state : null, mobile ? "on phones" : null].filter(Boolean);
  const control = (p: keyof StyleProps) => <StyleControl key={`${key}-${p}`} prop={p} value={(current as Record<string, unknown>)[p]} onChange={(v) => set(p, v)} swatches={swatches} />;
  return (
    <LayoutStyle.Provider value={layout}>
    <div className="flex flex-col gap-4" data-style-panel>
      {layout ? (
        <p className="type-caption m-0 text-fg-3" data-layout-style-note>
          Sizes on a layout are capped (heights at 1200px, spacing at 160px), so one layout cannot stretch the page.
        </p>
      ) : null}
      {target.length ? (
        <p className="type-caption m-0 border-l-2 border-accent-ink pl-2 text-fg-2" data-style-target>
          Styling: {target.join(", ")}. Change it under More style.
        </p>
      ) : null}
      <div className="flex flex-col gap-4" data-style-common>
        {COMMON.filter((p) => p !== "borderWidth" && p !== "borderColor").flatMap((p) => {
          const out = [
            <div key={`w-${p}`} className="flex flex-col gap-1">
              {control(p)}
              {STYLE_HINTS[p] ? <p className="type-caption m-0 text-fg-3">{STYLE_HINTS[p]}</p> : null}
            </div>,
          ];
          // Border (its width and colour) sits after Padding.
          if (p === "padding")
            out.push(
              <fieldset key="border" className="m-0 flex flex-col gap-3 border-0 p-0" data-style-border>
                <legend className={`${labelCls} mb-1`}>Border</legend>
                {control("borderWidth")}
                {control("borderColor")}
              </fieldset>,
            );
          return out;
        })}
      </div>
      <MoreFold group="style" label="More style" count={moreSet} toggleAttr="data-style-more-toggle">
        <div className="flex flex-col gap-3" data-style-more>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Part</span>
              <select className={inputCls} value={slot} onChange={(e) => setSlot(e.target.value)} data-style-slot>
                {slots.map((s) => (
                  <option key={s} value={s}>
                    {SLOT_LABELS[s] ?? s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelCls}>When</span>
              <select className={inputCls} value={state} onChange={(e) => setState(e.target.value)} data-style-state>
                <option value="">Always</option>
                {states.map((s) => (
                  <option key={s} value={s}>
                    {STATE_LABELS[s] ?? s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <SwitchRow checked={mobile} onCheckedChange={setMobile} label="Phones only" description="Styles here replace the desktop ones under 640px." />
          {MORE.map((p) => control(p))}
        </div>
      </MoreFold>
    </div>
    </LayoutStyle.Provider>
  );
}

// ---------- advanced: CSS box and visibility ----------

/**
 * Layouts take the Style panel only (final pass after gauntlet w2-r3 item 3): the CSS field refuses, says
 * why, and shows CSS saved earlier as ignored, with a way to remove it.
 */
function LayoutCssRefusal({ node, onChange }: { node: ComponentNode; onChange(p: Patch): void }) {
  const id = useId();
  const saved = (node.css ?? "").trim();
  return (
    <div className="flex flex-col gap-1" data-css-box data-css-refused>
      <span className={labelCls} id={id}>
        CSS for this component
      </span>
      <p role="note" aria-labelledby={id} className="type-caption m-0 text-fg-2" data-css-layout-note>
        {LAYOUT_CSS_REFUSAL}
      </p>
      {saved ? (
        <>
          <p className="type-caption m-0 font-mono text-[color:var(--warn-ink)]" data-css-ignored>
            Ignored: the CSS saved here earlier no longer applies.
          </p>
          <textarea aria-label="Ignored CSS (read only)" readOnly rows={3} className={`${monoCls} opacity-70`} value={saved} />
          <button type="button" className={linkBtn} data-css-remove onClick={() => onChange({ css: null } as unknown as Patch)}>
            Remove the ignored CSS
          </button>
        </>
      ) : null}
    </div>
  );
}

function CssBox({ node, onChange }: { node: ComponentNode; onChange(p: Patch): void }) {
  if (isLayoutType(node.type)) return <LayoutCssRefusal node={node} onChange={onChange} />;
  return <CssBoxField node={node} onChange={onChange} />;
}

function CssBoxField({ node, onChange }: { node: ComponentNode; onChange(p: Patch): void }) {
  const id = useId();
  const [draft, setDraft] = useState(node.css ?? "");
  const [removed, setRemoved] = useState<string[]>([]);
  useEffect(() => setDraft(node.css ?? ""), [node.css]);
  useEffect(() => {
    const h = setTimeout(async () => {
      try {
        const out = await compileNodeStylesAction([{ id: node.id, type: node.type, css: draft, overrideTheme: node.overrideTheme, style: node.style, responsive: node.responsive }]);
        setRemoved(out[node.id]?.removed ?? []);
      } catch {
        setRemoved([]);
      }
    }, 300);
    return () => clearTimeout(h);
  }, [draft, node.id, node.type, node.overrideTheme, node.style, node.responsive]);
  const tooLong = draft.length > 65536;
  return (
    <div className="flex flex-col gap-1" data-css-box>
      <label htmlFor={id} className={labelCls}>
        CSS for this component
      </label>
      <textarea id={id} rows={6} className={monoCls} spellCheck={false} value={draft} aria-invalid={tooLong || undefined} placeholder={":scope { }\n.value { letter-spacing: -0.02em }"} onChange={(e) => {
        setDraft(e.target.value);
        if (e.target.value.length <= 65536) onChange({ css: e.target.value || null } as unknown as Patch);
      }} />
      <p className="type-caption m-0 text-fg-3">Applies only inside this component. :scope is the component itself.</p>
      {tooLong ? <p role="alert" className="type-caption m-0 text-[color:var(--bad)]">CSS is limited to 64 KB.</p> : null}
      {removed.length ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" data-css-removed aria-label="Removed from this CSS">
          {removed.map((r, i) => (
            <li key={i} className="type-caption font-mono text-[color:var(--warn-ink)]">
              Removed: {r}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------- html block ----------

/** The HTML block's pictures (spec 3.1): a list of uploads, each with Upload and Your uploads. */
function HtmlImages({ images, setImages }: { images: string[]; setImages(v: string[]): void }) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" data-field="images" data-html-images>
      <legend className={labelCls}>{FIELD_HTML.images.label}</legend>
      <p className="type-caption m-0 text-fg-3" data-field-hint>{FIELD_HTML.images.hint}</p>
      {images.map((src, i) => (
        <div key={`${i}-${src}`} className="flex flex-col gap-1 border-l-2 border-line pl-2" data-html-image={i}>
          <MediaField value={src} accept="image" label={`Picture ${i + 1}`} onChange={(path) => setImages(images.map((x, j) => (j === i ? path : x)))}>
            <input aria-label={`Picture ${i + 1} address`} className={monoCls} defaultValue={src} placeholder="/uploads/plan.png" onBlur={(e) => e.target.value.trim().startsWith("/uploads/") && e.target.value.trim() !== src && setImages(images.map((x, j) => (j === i ? e.target.value.trim() : x)))} data-html-image-path={i} />
          </MediaField>
          <button type="button" className={`${linkBtn} text-[color:var(--bad)]`} aria-label={`Remove picture ${i + 1}`} onClick={() => setImages(images.filter((_, j) => j !== i))} data-html-image-remove={i}>
            Remove
          </button>
        </div>
      ))}
      {images.length < 20 ? <AddPicture onAdd={(path) => setImages([...images, path])} /> : null}
    </fieldset>
  );
}

/** "Add a picture": an empty media field whose first choice joins the list. */
function AddPicture({ onAdd }: { onAdd(path: string): void }) {
  const [n, setN] = useState(0);
  const [typed, setTyped] = useState("");
  const add = (path: string) => {
    if (!path.startsWith("/uploads/")) return;
    onAdd(path);
    setTyped("");
    setN((x) => x + 1);
  };
  return (
    <div className="flex flex-col gap-1" data-html-image-add>
      <MediaField key={n} accept="image" label="Add a picture" onChange={add}>
        <div className="flex gap-1">
          <input aria-label="Image paths" className={monoCls} value={typed} placeholder="/uploads/plan.png" onChange={(e) => setTyped(e.target.value.trim())} data-html-image-typed />
          <Button variant="secondary" disabled={!typed.startsWith("/uploads/")} onClick={() => add(typed)}>
            Add
          </Button>
        </div>
      </MediaField>
    </div>
  );
}

const FIELD_HTML = FIELD_WORDS.html.fields;

function HtmlContent({ node, doc, setProp }: { node: ComponentNode; doc: AppDocument; setProp(k: string, v: PropValue | null): void; scope: PageScope }) {
  const data = (node.props.data && typeof node.props.data === "object" && !Array.isArray(node.props.data) ? node.props.data : {}) as Record<string, PropValue>;
  const height = node.props.height;
  const libs = (Array.isArray(node.props.libs) ? node.props.libs : []) as string[];
  const images = (Array.isArray(node.props.images) ? node.props.images : []) as string[];
  const [newName, setNewName] = useState("");
  const mode = height === "fill" ? "fill" : height === "auto" || height === undefined ? "auto" : "fixed";
  return (
    <div className="flex flex-col gap-3" data-html-content>
      <p className="type-body m-0 border border-line-strong bg-bg-sunk px-3 py-2 text-fg" data-html-notice>
        {DATA_NOTICE}
      </p>
      {!node.name?.trim() ? (
        <p role="note" className="type-caption m-0 text-[color:var(--warn-ink)]" data-html-unnamed>
          This block has no name. Give it one in the layers panel: it becomes the frame&apos;s accessible title.
        </p>
      ) : null}
      <div className="flex flex-col gap-1" data-field="height">
        <span className={labelCls}>{FIELD_HTML.height.label}</span>
        <div className="flex gap-2">
          <select aria-label="Height mode" className={inputCls} value={mode} onChange={(e) => setProp("height", e.target.value === "auto" ? "auto" : e.target.value === "fill" ? "fill" : 240)} data-html-height-mode>
            <option value="auto">Auto (fits the content)</option>
            <option value="fill">Fill the page</option>
            <option value="fixed">Fixed</option>
          </select>
          {typeof height === "number" ? <input aria-label="Height in px" type="number" min={20} max={4000} className={inputCls} value={height} onChange={(e) => setProp("height", Math.min(4000, Math.max(20, Number(e.target.value) || 20)))} /> : null}
        </div>
        <p className="type-caption m-0 text-fg-3" data-field-hint>
          {mode === "fill" ? "As tall as the window below the app's navigation, and it grows with the window." : FIELD_HTML.height.hint}
        </p>
      </div>
      <HtmlImages images={images} setImages={(v) => setProp("images", v.filter((x) => x.startsWith("/uploads/")))} />
      <MoreFold group="content" count={(libs.length ? 1 : 0) + (Object.keys(data).length ? 1 : 0)}>
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" data-field="libs">
          <legend className={labelCls}>{FIELD_HTML.libs.label}</legend>
          <p className="type-caption m-0 text-fg-3" data-field-hint>{FIELD_HTML.libs.hint}</p>
          {(["uplot", "d3", "motion"] as const).map((l) => (
            <label key={l} className="type-body flex items-center gap-2 text-fg">
              <input type="checkbox" checked={libs.includes(l)} onChange={(e) => setProp("libs", e.target.checked ? [...libs, l] : libs.filter((x) => x !== l))} />
              {l}
            </label>
          ))}
        </fieldset>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" data-html-data-map data-field="data">
          <legend className={labelCls}>Data the block can read (atrium.data)</legend>
          <p className="type-caption m-0 text-fg-3" data-field-hint>{FIELD_HTML.data.hint}</p>
          {Object.entries(data).map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <code className="type-label text-fg">{k}</code>
                <Button variant="quiet" onClick={() => {
                  const next = { ...data };
                  delete next[k];
                  setProp("data", next);
                }}>
                  Remove
                </Button>
              </div>
              <input aria-label={`Binding for ${k}`} className={monoCls} value={isBinding(v) ? v.$bind : ""} onChange={(e) => setProp("data", { ...data, [k]: { $bind: e.target.value } })} />
            </div>
          ))}
          <div className="flex gap-1">
            <input aria-label="New data name" className={monoCls} placeholder="name" value={newName} onChange={(e) => setNewName(e.target.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 32))} />
            <Button variant="secondary" disabled={!/^[A-Za-z_]/.test(newName) || newName in data} onClick={() => {
              setProp("data", { ...data, [newName]: { $bind: doc.dataSources[0] ? `{{ ${doc.dataSources[0].name}.value }}` : "" } });
              setNewName("");
            }}>
              Add
            </Button>
          </div>
        </fieldset>
      </MoreFold>
    </div>
  );
}

// ---------- library instance ----------

function InstancePanel({ node, doc, onChange, onOps }: { node: ComponentNode; doc: AppDocument; onChange(p: Patch): void; onOps?(ops: DraftOp[]): void }) {
  const ref = node.libraryRef;
  const [pinned, setPinned] = useState<LibraryComponent | null>(null);
  const [latest, setLatest] = useState<LibraryComponent | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  useEffect(() => {
    if (!ref) return;
    let gone = false;
    void fetch(`/api/library/${encodeURIComponent(ref.componentId)}?version=${ref.version}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { component?: LibraryComponent; latest?: LibraryComponent } | null) => {
        if (gone || !j) return;
        setPinned(j.component ?? null);
        setLatest(j.latest ?? null);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [ref?.componentId, ref?.version]);
  if (!ref) return <p className="type-body m-0 text-fg-2">This instance has no library reference.</p>;
  const params = pinned?.params ?? [];
  const set = (k: string, v: PropValue) => onChange({ props: { ...node.props, [k]: v } });
  const newer = latest && pinned && latest.version > pinned.version ? latest : null;
  return (
    <div className="flex flex-col gap-3" data-instance-panel>
      <p className="type-caption m-0 font-mono text-fg-2">
        {pinned?.name ?? ref.componentId} · v{ref.version}
        {pinned?.containsCode ? " · contains code" : ""}
      </p>
      {params.map((p) => (
        <label key={p.name} className="flex flex-col gap-1" data-param={p.name}>
          <span className={labelCls}>{p.label}</span>
          {p.kind === "data" ? (
            <select className={inputCls} value={typeof node.props[p.name] === "string" ? (node.props[p.name] as string) : ""} onChange={(e) => set(p.name, e.target.value)}>
              <option value="">Choose a data source</option>
              {doc.dataSources.map((d) => (
                <option key={d.name}>{d.name}</option>
              ))}
            </select>
          ) : p.kind === "control" ? (
            <select className={inputCls} value={typeof node.props[p.name] === "string" ? (node.props[p.name] as string) : ""} onChange={(e) => set(p.name, e.target.value)}>
              <option value="">Choose a control</option>
              {doc.controls.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : p.kind === "boolean" ? (
            <input type="checkbox" checked={node.props[p.name] === true} onChange={(e) => set(p.name, e.target.checked)} />
          ) : (
            <input className={inputCls} type={p.kind === "number" ? "number" : "text"} value={node.props[p.name] === undefined ? "" : String(node.props[p.name])} onChange={(e) => set(p.name, p.kind === "number" ? Number(e.target.value) : e.target.value)} />
          )}
        </label>
      ))}
      {newer ? (
        <div className="flex flex-col gap-2 border border-line-strong p-2" data-library-update>
          <div className="flex items-center justify-between gap-2">
            <span className="type-body text-fg">Version {newer.version} is available</span>
            <Button variant="quiet" aria-expanded={showDiff} onClick={() => setShowDiff((s) => !s)}>
              {showDiff ? "Hide changes" : "Show changes"}
            </Button>
          </div>
          {showDiff ? (
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5" data-library-diff>
              {libraryDiff(pinned!, newer).map((l, i) => (
                <li key={i} className="type-caption text-fg-2">
                  {l}
                </li>
              ))}
            </ul>
          ) : null}
          <Button variant="ink" onClick={() => onChange({ libraryRef: { componentId: ref.componentId, version: newer.version } })} data-library-update-button>
            Update to v{newer.version}
          </Button>
        </div>
      ) : null}
      {onOps && pinned ? (
        <Button
          variant="secondary"
          data-library-detach
          onClick={() => {
            const parent = findParent(doc, node.id);
            if (!parent) return;
            const detached = detachInstance(node, pinned);
            onOps([{ op: "node.remove", nodeId: node.id }, { op: "node.add", parentId: parent.parent.id, index: parent.index, node: { ...detached, ...(node.slot ? { slot: node.slot } : {}) } }]);
          }}
        >
          Detach
        </Button>
      ) : null}
    </div>
  );
}

function findParent(doc: AppDocument, id: string): { parent: ComponentNode; index: number } | null {
  const walk = (n: ComponentNode): { parent: ComponentNode; index: number } | null => {
    const i = (n.children ?? []).findIndex((c) => c.id === id);
    if (i >= 0) return { parent: n, index: i };
    for (const c of n.children ?? []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  for (const p of doc.pages) {
    const hit = walk(p.root);
    if (hit) return hit;
  }
  return null;
}

// ---------- the Picture panel's frame (media layout spec 3.1): Style's short set, shown there too ----------

function MediaFrameControls({ node, onChange }: { node: ComponentNode; onChange(p: Patch): void }) {
  const swatches = useThemeSwatches();
  const root = ((node.overrideTheme ? node.style?.root : undefined) ?? {}) as StyleProps;
  // A merge patch on the root part's style; turning the look on applies nothing else (criterion 11).
  const set = (prop: keyof StyleProps, v: unknown) => onChange({ overrideTheme: true, style: { root: { [prop]: v === undefined || v === "" ? null : v } } } as unknown as Patch);
  return (
    <div className="flex flex-col gap-3" data-media-frame-style>
      <LengthField prop="borderWidth" value={root.borderWidth} onChange={(v) => set("borderWidth", v)} />
      <SwatchField prop="borderColor" value={root.borderColor} onChange={(v) => set("borderColor", v)} swatches={swatches} />
      <ShadowField value={root.boxShadow} onChange={(v) => set("boxShadow", v)} />
    </div>
  );
}

// ---------- the panels ----------

type OpenState = { content: boolean; data: boolean; control: boolean; style: boolean; advanced: boolean };

export function InspectorPanels({ node, doc, onChange, ctx, onOps, onConnectData, dataSummary, describe }: InspectorProps) {
  const meta = metaFor(node.type);
  const scope = ctx.values as PageScope;
  const initial = (): OpenState => ({ content: true, data: true, control: true, style: false, advanced: false });
  const [open, setOpen] = useState<OpenState>(initial);
  const lastId = useRef(node.id);
  useEffect(() => {
    if (lastId.current !== node.id) {
      lastId.current = node.id;
      setOpen(initial());
    }
  }, [node.id]);
  const toggle = (k: keyof OpenState) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const fields = useMemo(() => (meta ? fieldsFor(meta.type) : []), [meta]);
  const sourceNames = useMemo(() => doc.dataSources.map((d) => d.name), [doc.dataSources]);
  // "Choose a data source" on a sample in the canvas: open Data and focus the source picker.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focus = () => {
      setOpen((o) => ({ ...o, data: true }));
      // The builder settles its own focus after a selection; try again until the picker keeps it.
      const tryFocus = (left: number) => {
        const el = rootRef.current?.querySelector<HTMLElement>("[data-source-picker], [data-inspector-group=data] textarea");
        if (el && document.activeElement !== el) el.focus();
        if (left > 0) setTimeout(() => tryFocus(left - 1), 120);
      };
      requestAnimationFrame(() => tryFocus(4));
    };
    // With the builder's data picker the builder answers the request itself (Wave 2.5).
    if (onConnectData) return;
    if (takeSourceChoice(node.id)) focus();
    const on = (e: Event) => {
      if ((e as CustomEvent<{ nodeId: string }>).detail?.nodeId === node.id && takeSourceChoice(node.id)) focus();
    };
    window.addEventListener(SOURCE_CHOICE_EVENT, on);
    return () => window.removeEventListener(SOURCE_CHOICE_EVENT, on);
  }, [node.id]);
  // The draft applies patches as merge patches: a prop is removed by sending it as null (a missing key
  // means "unchanged"), so clearing or unbinding a field saves (gauntlet w2-r2 Fix 3).
  const setProp = (k: string, v: PropValue | null) => onChange({ props: { ...node.props, [k]: v } } as unknown as Patch);

  if (node.type.startsWith("lib:")) {
    return (
      <div data-inspector data-node-id={node.id}>
        <Group title="Content" open={open.content} onToggle={() => toggle("content")}>
          <InstancePanel node={node} doc={doc} onChange={onChange} onOps={onOps} />
        </Group>
        <Group title="Code and conditions" groupId="advanced" open={open.advanced} onToggle={() => toggle("advanced")}>
          <CssBox node={node} onChange={onChange} />
        </Group>
      </div>
    );
  }
  if (!meta) return <p className="type-body p-3 text-fg-2">This component type has no inspector.</p>;
  // A tile's integrationId is a builder reference (A10.7): never shown or typed.
  const content = fields.filter((f) => f.group === "content" && f.key !== "showUpdated" && !(node.type === "html") && !(node.type === "service-tile" && f.key === "integrationId"));
  // Pictures and videos open on their own Picture (or Video) panel (media layout spec 3.1).
  const media = node.type === "image" || node.type === "video";
  const dataWidget = meta.category === "data";
  // A chart with lines (A10.2) no longer reads its single Series field, so the field is not shown.
  const hasLines = node.type === "chart" && Array.isArray(node.props.lines) && node.props.lines.length > 0;
  const data = fields.filter((f) => (f.group === "data" || f.key === "showUpdated") && !(hasLines && f.key === "data"));
  const control = fields.filter((f) => f.group === "control");
  const LIST_TYPES = ["service-tile", "resource-bar"];
  const sourcesBox = meta.category === "data" && !LIST_TYPES.includes(node.type) && !hasLines && data.some((f) => f.key === "data" || f.key === "items");
  const connectBox = sourcesBox || LIST_TYPES.includes(node.type);
  const pick = onConnectData ? { onPick: (k: string) => onConnectData(k) } : {};
  // Wave 2.9 list props (A10.2, A10.7): their own editors, with Pick data per entry by prop path.
  const listEnv: ListEnv = { node, scope, sources: sourceNames, ...(describe ? { describe } : {}), ...(onConnectData ? { onPick: (p: string) => onConnectData(p) } : {}), setProp, setProps: (p) => onChange({ props: { ...node.props, ...p } } as unknown as Patch) };
  // With the builder's own data summary (its picker-led lines and numbers, Wave 2.9 app-builder), these
  // full editors (labels, formats, icons, templates) fold under "by hand", so each list has one main path.
  // The wrapper names the prop (data-fields) so the folded view still counts it as shown: the fold stands for it.
  const byHand = (key: string, label: string, el: ReactNode) => (dataSummary ? <div key={key} data-fields={key}><MoreFold group={`${key}-by-hand`} label={label}>{el}</MoreFold></div> : el);
  const LIST_EDITORS: Record<string, () => ReactNode> = {
    "service-tile.stats": () => byHand("stats", "Edit the numbers by hand", <StatsEditor key="stats" env={listEnv} />),
    "resource-bar.items": () => byHand("items", "Edit the readings by hand", <BarItemsEditor key="items" env={listEnv} />),
    "bookmarks.items": () => <BookmarksEditor key="items" env={listEnv} />,
    "chart.lines": () => byHand("lines", "Edit the lines by hand", <LinesEditor key="lines" env={listEnv} doc={doc} {...(onOps ? { onOps } : {})} />),
    "service-tile.icon": () => <div key="icon" data-field="icon"><IconField label="Icon" path="icon" value={node.props.icon} onSet={(v) => setProp("icon", v ?? "server")} hint="A built-in icon, the service's own, or an uploaded picture" /></div>,
  };
  const field = (f: FieldSpec) => {
    const custom = LIST_EDITORS[`${node.type}.${f.key}`];
    if (custom) return custom();
    const pf = (spec: FieldSpec) => <PropField key={`${node.id}:${f.key}`} spec={spec} node={node} scope={scope} setProp={setProp} sources={sourceNames} describe={describe} inlineLive={!(dataWidget && spec.simple)} {...pick} />;
    // Pictures and videos (spec 3.1): Upload, Your uploads, and the typed or live address folded under "Paste an address".
    if ((node.type === "image" || node.type === "video") && f.key === "src") {
      const v = node.props.src;
      return (
        <div key={f.key} className="flex flex-col gap-1" data-field="src" data-media-src>
          <MediaField value={typeof v === "string" ? v : undefined} accept={node.type} label={f.label} hint={f.hint} onChange={(path) => (path ? onChange({ props: { ...node.props, src: path, fit: "contain" } } as unknown as Patch) : setProp("src", null))}>
            {pf({ ...f, label: "Address", hint: node.type === "image" ? "An uploaded file (/uploads/...) or a web address" : "An uploaded file (/uploads/...)" })}
          </MediaField>
        </div>
      );
    }
    return pf(f);
  };
  const isSet = (f: FieldSpec) => node.props[f.key] !== undefined && node.props[f.key] !== null;
  /** A group's fields: the simple set first, the rest under "More settings" (spec 3.2). */
  const split = (group: string, list: FieldSpec[]) => {
    const simple = list.filter((f) => f.simple);
    const more = list.filter((f) => !f.simple);
    // A data widget's simple fields keep their Pick data and Live data here, folded (data ease spec 3.1).
    const live = dataWidget ? simple.filter((f) => f.bindable && f.field.kind !== "data" && !isBinding(node.props[f.key]) && !(typeof node.props[f.key] === "string" && String(node.props[f.key]).trim().startsWith("{{"))) : [];
    return (
      <>
        {simple.map(field)}
        {more.length || live.length ? (
          <MoreFold group={group} count={more.filter(isSet).length}>
            {live.length ? (
              <div className="flex flex-col gap-1" data-live-data-fields={group}>
                <span className={labelCls}>Live data for one field</span>
                <p className="type-caption m-0 text-fg-3">Show a value from your data in just this field, set apart from what the widget shows.</p>
                {live.map((f) => <LiveDataLinks key={f.key} spec={f} value={node.props[f.key]} setProp={setProp} withLabel {...(onConnectData ? { onPick: (k: string) => onConnectData(k) } : {})} />)}
              </div>
            ) : null}
            {more.map(field)}
          </MoreFold>
        ) : null}
      </>
    );
  };
  // The Data sentence (spec 3.3): what the widget shows, built from its main binding.
  const primary = (() => {
    const keys = [...new Set(["data", "items", "value", ...Object.keys(node.props)])];
    for (const k of keys) {
      const v = node.props[k];
      if (isBinding(v) && chipFits(v.$bind, sourceNames)) return { key: k, template: v.$bind };
    }
    return null;
  })();
  const sentence = primary
    ? (() => {
        const src = sourcesInTemplate(primary.template)[0]!;
        const s = dataSentence(primary.template, src, describe, describe?.source?.(src) ?? null);
        return (
          <div className="flex flex-col gap-1" data-data-sentence={primary.key}>
            <p className="type-body m-0 text-fg" data-data-sentence-text>
              {s.sentence}
            </p>
            {s.custom ? <code className="type-caption block break-all font-mono text-fg-2" data-data-sentence-template>{primary.template}</code> : null}
          </div>
        );
      })()
    : null;
  // A field bound on its own (not through what the widget shows) says so under the Shows line (data ease 3.1).
  const separate = fields.filter((f) => f.field.kind !== "data" && f.key !== primary?.key && isBinding(node.props[f.key]) && (node.props[f.key] as { $bind: string }).$bind.trim());
  const separately = separate.length ? (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-set-separately-list>
      {separate.map((f) => (
        <li key={f.key} className="type-caption text-fg-2" data-set-separately={f.key}>
          {f.label} is set separately
        </li>
      ))}
    </ul>
  ) : null;
  return (
    <div data-inspector data-node-id={node.id} ref={rootRef}>
      <div className="flex flex-col gap-2 border-b border-line px-3 py-2" data-inspector-actions>
        <SaveToLibrary node={node} doc={doc} />
      </div>
      <Group title={media ? (node.type === "video" ? "Video" : "Picture") : "Content"} groupId="content" open={open.content} onToggle={() => toggle("content")}>
        {/* A component without a Data group (a text bound to a source) shows what it reads here (Wave 2.5). */}
        {!data.length ? sentence : null}
        {!data.length ? dataSummary : null}
        {node.type === "html" ? <div data-field="html" data-fields="html css js"><HtmlCodeButton node={node} onChange={onChange} /></div> : null}
        {node.type === "html" ? (
          <HtmlContent node={node} doc={doc} setProp={setProp} scope={scope} />
        ) : media ? (
          <PicturePanel
            node={node}
            doc={doc}
            onChange={onChange}
            {...(onOps ? { onOps } : {})}
            field={(k) => {
              const f = fields.find((x) => x.key === k);
              return f ? field(f) : null;
            }}
            file={field(fields.find((x) => x.key === "src")!)}
            frame={<MediaFrameControls node={node} onChange={onChange} />}
            words={(FIELD_WORDS as unknown as Record<string, { fields: Record<string, import("./labels").FieldWords> }>)[node.type]!.fields}
            simple={(FIELD_WORDS as unknown as Record<string, { simple: readonly string[] }>)[node.type]!.simple}
          />
        ) : content.length ? split("content", content) : <p className="type-caption m-0 text-fg-3">Nothing to set here.</p>}
      </Group>
      {data.length ? (
        <Group title="Data" open={open.data} onToggle={() => toggle("data")}>
          {sentence}
          {dataSummary}
          {dataWidget ? separately : null}
          {onConnectData && connectBox ? (
            <button type="button" className="inline-flex min-h-9 items-center justify-center border border-line-strong px-3 type-label hover:bg-bg-sunk touch:min-h-11" onClick={() => onConnectData()} data-connect-data>
              Connect data
            </button>
          ) : null}
          {sourcesBox ? (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Source</span>
              <select className={inputCls} value="" data-source-picker onChange={(e) => {
                if (!e.target.value) return;
                const key = data.some((f) => f.key === "data") ? "data" : "items";
                setProp(key, { $bind: key === "items" ? `{{ ${e.target.value}.rows }}` : `{{ ${e.target.value} }}` });
              }}>
                <option value="">Pick a data source</option>
                {doc.dataSources.map((d) => (
                  <option key={d.name}>{d.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          {split("data", data)}
        </Group>
      ) : null}
      {control.length ? (
        <Group title="Control" open={open.control} onToggle={() => toggle("control")}>
          {control.map((f) =>
            node.type === "html" ? (
              <fieldset key={f.key} className="m-0 flex flex-col gap-1 border-0 p-0" data-field={f.key}>
                <legend className={labelCls}>{f.label}</legend>
                <p className="type-caption m-0 text-fg-3" data-field-hint>{f.hint}</p>
                {doc.controls.length ? (
                  doc.controls.map((c) => {
                    const list = (Array.isArray(node.props.controls) ? node.props.controls : []) as string[];
                    return (
                      <label key={c.id} className="type-body flex items-center gap-2 text-fg">
                        <input type="checkbox" checked={list.includes(c.id)} onChange={(e) => setProp("controls", e.target.checked ? [...list, c.id] : list.filter((x) => x !== c.id))} />
                        {c.label}
                      </label>
                    );
                  })
                ) : (
                  <p className="type-caption m-0 text-fg-3">This app has no controls yet.</p>
                )}
              </fieldset>
            ) : (
              <label key={f.key} className="flex flex-col gap-1" data-field={f.key}>
                <span className={labelCls} title={f.description || undefined}>{f.label}</span>
                <select className={inputCls} value={typeof node.props.control === "string" ? node.props.control : ""} onChange={(e) => setProp("control", e.target.value || null)} data-control-picker>
                  <option value="">Choose a control</option>
                  {doc.controls.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <span className="type-caption text-fg-3" data-field-hint>{f.hint}</span>
              </label>
            ),
          )}
        </Group>
      ) : null}
      <Group title="Style" open={open.style} onToggle={() => toggle("style")} tag={node.overrideTheme ? <Tag tone="gold">customised</Tag> : null}>
        <SwitchRow
          checked={node.overrideTheme === true}
          onCheckedChange={(c) => onChange({ overrideTheme: c })}
          label="Customise the look"
          description="Off: follows the app's theme. On: your settings below win."
        />
        {/* Nothing is applied by turning it on: every field starts empty (the theme's value) until set (criterion 11). */}
        {node.overrideTheme ? <StylePanel node={node} onChange={onChange} /> : node.style || node.responsive?.mobile?.style ? <p className="type-caption m-0 text-fg-3" data-style-kept>Your earlier settings are kept and come back when this is on.</p> : null}
      </Group>
      <Group title="Code and conditions" groupId="advanced" open={open.advanced} onToggle={() => toggle("advanced")}>
        <CssBox node={node} onChange={onChange} />
        <BindingField
          name="visibleWhen"
          label="Show only when"
          description="Hidden for viewers when this is false or fails; drawn faded with a hidden tag while you edit."
          value={isBinding(node.visibleWhen) ? node.visibleWhen.$bind : ""}
          scope={scope}
          sources={sourceNames}
          holdKey={`${node.id}:visibleWhen`}
          onChange={(t) => onChange({ visibleWhen: t.trim() ? { $bind: t } : null } as unknown as Patch)}
        />
      </Group>
    </div>
  );
}

// ---------- "Edit code": docks the HTML block's code window (gauntlet w2-r1 Fix 1) ----------

/**
 * The HTML block's "Edit code" action. The code window docks into the element app-builder marks with
 * `data-code-dock` (under the canvas, design v4 "The Builder"); without one it opens inside the
 * inspector, so the block can always be written. Edits go through onChange like every other prop, so
 * they save to the draft and the frame re-renders with the new code.
 */
export const CODE_DOCK_SELECTOR = "[data-code-dock]";
function HtmlCodeButton({ node, onChange }: { node: ComponentNode; onChange(p: Patch): void }) {
  const [open, setOpen] = useState(false);
  const [dock, setDock] = useState<Element | null>(null);
  useEffect(() => {
    setOpen(false);
  }, [node.id]);
  useEffect(() => {
    if (open) setDock(document.querySelector(CODE_DOCK_SELECTOR));
  }, [open]);
  const content = open ? (
    <div data-code-docked={dock ? "dock" : "inspector"} className={dock ? "w-full" : ""}>
      <HtmlCodeWindow node={node} onChange={onChange} onClose={() => setOpen(false)} />
    </div>
  ) : null;
  return (
    <div className="flex flex-col gap-2" data-html-code-action>
      <Button variant="ink" className="w-full" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-edit-code>
        {open ? "Close code" : "Edit code"}
      </Button>
      {open && dock ? createPortal(content, dock) : content}
    </div>
  );
}

// ---------- the HTML block's code window (docked under the canvas by app-builder) ----------

export function HtmlCodeWindow({ node, onChange, onClose }: { node: ComponentNode; onChange(patch: Patch): void; onClose?(): void }) {
  const [tab, setTab] = useState<"html" | "css" | "js">("html");
  // The text is the author's own while they type: the draft round trip never rewrites it under them.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => setDrafts({}), [node.id]);
  const [problem, setProblem] = useState<string | null>(null);
  const logs = useSyncExternalStore(
    (cb) => subscribeBlockLogs(node.id, cb),
    () => blockLogs(node.id),
    () => blockLogs(node.id),
  );
  const value = drafts[tab] ?? textOf(node.props[tab] ?? "");
  const id = useId();
  return (
    <Window tone="ink" title="html block / code" status={`${Math.ceil(new TextEncoder().encode(value).length / 1024)} / 64 KB`} padded={false} data-code-window aria-label="HTML block code">
      <div className="flex items-center gap-1 border-b border-line px-2">
        <div role="tablist" aria-label="Code" className="flex flex-1 items-center gap-1">
        {(["html", "css", "js"] as const).map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} aria-controls={id} data-code-tab={t} onClick={() => setTab(t)} className={`min-h-9 px-3 font-mono text-[12px] ${tab === t ? "text-accent underline underline-offset-4" : "opacity-75"}`}>
            {t}
          </button>
        ))}
        </div>
        {onClose ? (
          <button type="button" className="min-h-9 px-2 font-mono text-[12px] opacity-75 hover:opacity-100" onClick={onClose} data-code-close>
            close
          </button>
        ) : null}
      </div>
      <textarea
        id={id}
        role="tabpanel"
        aria-label={`${tab} code`}
        spellCheck={false}
        className="min-h-48 w-full resize-y bg-transparent p-3 font-mono text-[12px] leading-[18px] text-inherit outline-none"
        value={value}
        data-code-editor={tab}
        onChange={(e) => {
          const p = codeFieldProblem(tab, e.target.value);
          setProblem(p);
          setDrafts((d) => ({ ...d, [tab]: e.target.value }));
          if (!p) onChange({ props: { ...node.props, ...Object.fromEntries(Object.entries(drafts).filter(([k]) => !codeFieldProblem(k as "html", drafts[k]!))), [tab]: e.target.value } });
        }}
      />
      {problem ? (
        <p role="alert" className="m-0 px-3 py-1 font-mono text-[12px] text-[color:var(--bad)]" data-code-limit>
          {problem}
        </p>
      ) : null}
      <div className="border-t border-line" data-console>
        <div className="flex items-center justify-between px-3 py-1">
          <span className="font-mono text-[11px] opacity-75">console</span>
          <button type="button" className="font-mono text-[11px] opacity-75" onClick={() => clearBlockLogs(node.id)}>
            clear
          </button>
        </div>
        <ol className="m-0 max-h-40 list-none overflow-auto px-3 pb-2" aria-live="polite">
          {logs.map((l, i) => (
            <li key={i} data-log-level={l.level} data-log-stale={l.stale ? "" : undefined} className={`font-mono text-[12px] ${l.stale ? "opacity-45" : l.level === "error" ? "text-[color:var(--bad)]" : l.level === "warn" ? "text-[color:var(--warn-ink)]" : ""}`}>
              {l.stale ? <span className="mr-1 border border-current px-1 text-[10px]">earlier run</span> : null}
              {l.level !== "info" ? `${l.level}: ` : ""}
              {l.message}
            </li>
          ))}
        </ol>
      </div>
    </Window>
  );
}
