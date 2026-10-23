"use client";
// "Save to library" (spec 3.6.1): name, description and tags; data sources and controls become
// parameters on the server; the author may promote text, number, colour and boolean props.
import { useEffect, useId, useState } from "react";
import type { AppDocument, ComponentNode } from "@/core/contracts";
import { Button } from "@/features/shell";
import { isBinding } from "../bindings";

const inputCls = "w-full border border-line-strong bg-bg-hi px-2 py-1.5 type-body text-fg min-h-9 touch:min-h-11";

type Promotable = { nodeId: string; prop: string; kind: "text" | "number" | "color" | "boolean"; label: string };

function promotable(n: ComponentNode, out: Promotable[] = []): Promotable[] {
  for (const [k, v] of Object.entries(n.props)) {
    if (isBinding(v) || v === null || v === undefined) continue;
    const kind = typeof v === "boolean" ? "boolean" : typeof v === "number" ? "number" : typeof v === "string" ? (/^#[0-9a-f]{3,8}$/i.test(v) || /^token:/.test(v) ? "color" : "text") : null;
    if (kind && !["control", "html", "css", "js"].includes(k)) out.push({ nodeId: n.id, prop: k, kind, label: `${n.name ?? n.type} ${k}` });
  }
  for (const c of n.children ?? []) promotable(c, out);
  return out.slice(0, 30);
}

export function SaveToLibrary({ node, doc }: { node: ComponentNode; doc: AppDocument }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(node.name ?? "");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" | "error"; message?: string }>({ kind: "idle" });
  const [existing, setExisting] = useState<{ id: string; name: string; version: number; canUpdate: boolean }[]>([]);
  const [target, setTarget] = useState("");
  // Replacing another component's design is never one click away (gauntlet w2-r1 Fix 6).
  const [replaceOk, setReplaceOk] = useState(false);
  useEffect(() => {
    if (!open) return;
    void fetch("/api/library", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { components?: { id: string; name: string; version: number; canUpdate: boolean }[] } | null) => setExisting((j?.components ?? []).filter((c) => c.canUpdate)))
      .catch(() => {});
  }, [open]);
  if (node.type.startsWith("lib:")) return null;
  const options = promotable(node);
  if (!open) {
    return (
      <Button variant="secondary" className="w-full" onClick={() => setOpen(true)} data-save-to-library>
        Save to library
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-2 border border-line-strong p-2"
      data-save-form
      onSubmit={async (e) => {
        e.preventDefault();
        setState({ kind: "saving" });
        const promote = options.filter((o) => picked[`${o.nodeId}.${o.prop}`]).map((o) => ({ nodeId: o.nodeId, prop: o.prop, name: o.prop.replace(/[^A-Za-z0-9_]/g, "_"), label: o.label, kind: o.kind }));
        const res = await fetch("/api/library", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ ...(target ? { componentId: target } : {}), name, description, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), node, promote, sources: doc.dataSources.map((d) => d.name), controls: doc.controls.map((c) => ({ id: c.id, label: c.label })) }),
        }).catch(() => null);
        const json = (await res?.json().catch(() => null)) as { component?: { version: number }; error?: { message: string } } | null;
        if (res?.ok && json?.component) setState({ kind: "saved", message: `Saved as version ${json.component.version}.` });
        else setState({ kind: "error", message: json?.error?.message ?? "Could not save." });
      }}
    >
      {existing.length ? (
        <label className="flex flex-col gap-1">
          <span className="type-label text-fg-2">Save as</span>
          <select className={inputCls} value={target} onChange={(e) => {
            setTarget(e.target.value);
            setReplaceOk(false);
            const hit = existing.find((x) => x.id === e.target.value);
            if (hit) setName(hit.name);
          }} data-save-target>
            <option value="">A new library component</option>
            {existing.map((c) => (
              <option key={c.id} value={c.id}>{`Replace ${c.name} with this (makes v${c.version + 1})`}</option>
            ))}
          </select>
        </label>
      ) : null}
      {target ? (
        <label className="type-body flex items-start gap-2 border border-[color:var(--warn-ink)] p-2 text-fg" data-save-replace-confirm>
          <input type="checkbox" className="mt-1" checked={replaceOk} onChange={(e) => setReplaceOk(e.target.checked)} />
          <span>
            This is not an instance of {existing.find((x) => x.id === target)?.name ?? "that component"}. Saving makes its next version from this {node.type} instead. Apps that use it keep their version until someone updates them.
          </span>
        </label>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="type-label text-fg-2">Name</span>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="type-label text-fg-2">Description</span>
        <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="type-label text-fg-2">Tags (comma separated)</span>
        <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      {options.length ? (
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" aria-describedby={`${id}-h`}>
          <legend className="type-label text-fg-2">Let each use change</legend>
          <p id={`${id}-h`} className="type-caption m-0 text-fg-3">Data sources and controls always become parameters.</p>
          {options.map((o) => (
            <label key={`${o.nodeId}.${o.prop}`} className="type-body flex items-center gap-2 text-fg">
              <input type="checkbox" checked={!!picked[`${o.nodeId}.${o.prop}`]} onChange={(e) => setPicked((p) => ({ ...p, [`${o.nodeId}.${o.prop}`]: e.target.checked }))} />
              {o.label}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="ink" disabled={state.kind === "saving" || !name.trim() || (!!target && !replaceOk)}>
          Save
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      {state.message ? (
        <p role="status" className={`type-caption m-0 ${state.kind === "error" ? "text-[color:var(--bad)]" : "text-fg-2"}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
