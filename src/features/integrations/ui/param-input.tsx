"use client";
// One endpoint setting on the integration page (Wave 2.7, Amendment 8 A8.2 and A8.3): an enum is a
// dropdown that shows its x-atrium-labels words and stores the value; a setting with live choices is
// a dropdown filled from GET /api/data/choices (value stored, name shown, "Every ..." first when the
// read allows it), with "Type it in" kept for when the list is wrong or the service is down.
import { useEffect, useState } from "react";
import { api, ApiFailure, inputClass, Input } from "./common";

export type ParamProp = { type?: string; title?: string; default?: unknown; placeholder?: string; examples?: string[]; enum?: unknown[]; "x-atrium-labels"?: Record<string, string>; "x-atrium-choices"?: { endpointId?: string; every?: boolean; params?: Record<string, string> } };
type Choice = { value: string; label: string; detail?: string };
type Loaded = { state: "loading" } | { state: "ready"; choices: Choice[]; every: boolean; total: number } | { state: "error"; message: string; waiting?: boolean };

export const TYPE_IT_IN = "__type_it_in__";

/** "Every machine", "Every VM or container": the setting's own title after "Every". */
export function everyLabel(title: string): string {
  const t = title.trim();
  return `Every ${/^[A-Z][a-z]/.test(t) ? t[0]!.toLowerCase() + t.slice(1) : t}`;
}

function optionText(c: Choice): string {
  const d = c.detail && c.detail !== c.label ? ` · ${c.detail}` : "";
  const text = `${c.label}${d}`;
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

export function ParamInput({ id, k, p, value, onChange, integrationId, endpointId, all }: { id: string; k: string; p: ParamProp; value: string; onChange: (v: string) => void; integrationId: string; endpointId: string; all: Record<string, string> }) {
  const choices = p["x-atrium-choices"];
  if (choices?.endpointId) return <ChoiceInput id={id} k={k} p={p} value={value} onChange={onChange} integrationId={integrationId} endpointId={endpointId} all={all} />;
  if (Array.isArray(p.enum) && p.enum.length) {
    const labels = p["x-atrium-labels"] ?? {};
    return (
      <select id={id} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} data-param={k} data-param-kind="enum">
        {p.default === undefined && <option value="">Pick one</option>}
        {p.enum.map((v) => <option key={String(v)} value={String(v)}>{labels[String(v)] ?? String(v)}</option>)}
      </select>
    );
  }
  return <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={p.placeholder ?? (p.examples?.[0] ? `For example ${p.examples[0]}` : undefined)} className="font-mono" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-param={k} inputMode={p.type === "number" ? "decimal" : undefined} />;
}

function ChoiceInput({ id, k, p, value, onChange, integrationId, endpointId, all }: { id: string; k: string; p: ParamProp; value: string; onChange: (v: string) => void; integrationId: string; endpointId: string; all: Record<string, string> }) {
  const deps = Object.values(p["x-atrium-choices"]?.params ?? {});
  const depKey = deps.map((d) => all[d] ?? "").join("\u0000");
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    const missing = deps.filter((d) => !all[d] || all[d] === "*");
    if (missing.length) { setLoaded({ state: "error", message: `Pick ${missing.join(" and ")} first.`, waiting: true }); return; }
    const ctl = new AbortController();
    setLoaded({ state: "loading" });
    const current = Object.fromEntries(deps.map((d) => [d, all[d]]));
    const q = new URLSearchParams({ integrationId, endpointId, param: k, ...(deps.length ? { params: JSON.stringify(current) } : {}) });
    api<{ choices: Choice[]; every: boolean; total: number }>(`/api/data/choices?${q.toString()}`, { signal: ctl.signal })
      .then((r) => setLoaded({ state: "ready", ...r }))
      .catch((x: unknown) => { if (!ctl.signal.aborted) setLoaded({ state: "error", message: x instanceof ApiFailure ? x.error.message : "The list could not be loaded." }); });
    return () => ctl.abort();
    // depKey stands for the values this list depends on
  }, [integrationId, endpointId, k, depKey]);

  const title = p.title ?? k;
  const known = loaded.state === "ready" && (value === "" || value === "*" || loaded.choices.some((c) => c.value === value));
  if (typing || loaded.state === "error" || (loaded.state === "ready" && !known)) {
    return (
      <div className="flex flex-col gap-1" data-choice-typed={k}>
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-param={k} placeholder={`Type the ${title.toLowerCase()}`} />
        {loaded.state === "error" && <span className="type-caption text-glass-muted" data-choice-error={k}>{loaded.message}{loaded.waiting ? "" : " You can type it in instead."}</span>}
        {loaded.state === "ready" && <button type="button" className="self-start type-caption text-accent-ink underline min-h-8 touch:min-h-11" onClick={() => { setTyping(false); if (!known) onChange(""); }} data-choice-back={k}>Pick from the list instead</button>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <select id={id} className={inputClass} value={loaded.state === "ready" ? value : ""} disabled={loaded.state === "loading"} aria-busy={loaded.state === "loading"} onChange={(e) => { if (e.target.value === TYPE_IT_IN) { setTyping(true); return; } onChange(e.target.value); }} data-param={k} data-param-kind="choices" data-choices-state={loaded.state}>
        {loaded.state === "loading" ? <option value="">Loading the list...</option> : (
          <>
            <option value="">{loaded.choices.length ? `Pick ${/^[aeiou]/i.test(title) ? "an" : "a"} ${title.toLowerCase()}` : `Nothing to pick yet`}</option>
            {loaded.every && <option value="*">{everyLabel(title)}</option>}
            {loaded.choices.map((c) => <option key={c.value} value={c.value}>{optionText(c)}</option>)}
            <option value={TYPE_IT_IN}>Type it in...</option>
          </>
        )}
      </select>
      {loaded.state === "ready" && loaded.total > loaded.choices.length && <span className="type-caption text-glass-muted">Showing {loaded.choices.length} of {loaded.total}. Type it in for the rest.</span>}
    </div>
  );
}
