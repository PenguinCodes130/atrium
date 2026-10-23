"use client";
// Custom API by example (spec 3.5): paste a URL or a curl command, "Try it" on the server, click
// fields in the response tree, accept the proposed shape and component, name it and save.
// Round 2 (gauntlet r1): the tree is a list of full-width rows (44px on touch, 15px text) that
// collapse and filter, with no scroll box of its own; role choices explain themselves in text;
// a new Try it drops picks the new answer does not have and says so; a disabled Save always says
// why; pasted headers stay visible and are saved with the endpoint; the Name and refresh are
// suggested from the picked field and the API's rate limit; a second endpoint on a host that is
// already set up goes into that integration by default.
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import type { DataShapeKind } from "@/core/contracts";
import { Button, CloseIcon, LockIcon, Screen, ScreenHeader, SearchIcon, Window, usePageTitle, toast } from "@/features/shell";
import { ShapedPreview } from "@/features/data/ui";
import { evaluate, proposeComponent, proposeShape, readablePath, shapeFromFields, type DataComponentType, type FieldPick, type Role, type TreeNode } from "../shape";
import { originOf } from "../config-ui";
import type { AddressEntry } from "../service";
import { api, ApiFailure, Chevron, ErrorCallout, Field, Input, inputClass, Spinner, urlInputProps, type ApiError } from "./common";
import { keepFocusedInView } from "./setup-form";
import { builderReturnFor } from "./return-to-builder";
import { SpecImport } from "./spec-import";

type SecretField = { key: string; label: string; hint: string; auth: { as: string; name?: string } };
type Echo = { method: "GET" | "POST"; url: string; headers: Record<string, string>; body?: string; verifyTls: boolean; droppedHeaders?: string[] };
type RateHint = { limit: number; windowSec: number; refreshSec: number };
type TryOk = { ok: true; status: number; tree: TreeNode; request: Echo; secretFields: SecretField[]; pendingId?: string; redactedCurl?: string; basicUser?: string; rateLimit?: RateHint };
type TryFail = { ok: false; heading: string; error: ApiError; request?: Echo; secretFields?: SecretField[]; pendingId?: string; redactedCurl?: string };
type Queued = { method: string; path: string; summary: string; shape: string };

const ROLES: Role[] = ["value", "label", "time", "status", "column"];
const ROLE_NAME: Record<Role, string> = { value: "Value", label: "Name", time: "Time", status: "Status", column: "Column" };
const ROLE_HELP: Record<Role, string> = {
  value: "The number or text to show",
  label: "The name of each item",
  time: "When each point happened",
  status: "Up, down or warning",
  column: "One column of a table",
};
const SHAPE_NAME: Record<DataShapeKind, string> = { stat: "One value", series: "Values over time", table: "A table", status: "Up and down list" };
const COMPONENTS: Record<DataShapeKind, DataComponentType[]> = { stat: ["stat"], series: ["chart"], table: ["table", "list"], status: ["status", "stat"] };
const COMPONENT_NAME: Record<string, string> = { stat: "Big number", chart: "Line chart", table: "Table", list: "List", status: "Status list" };
const COLLAPSE_DEPTH = 2;

function treeToJson(n: TreeNode): unknown {
  if (n.type === "object") return Object.fromEntries(n.children.map((c) => [String(c.key), treeToJson(c)]));
  if (n.type === "array") return n.children.map(treeToJson);
  return n.value;
}

/** True when this node or any child has a key or value containing the filter text. */
function matches(n: TreeNode, q: string): boolean {
  if (!q) return true;
  if (n.key !== undefined && String(n.key).toLowerCase().includes(q)) return true;
  if ("value" in n && String(n.value).toLowerCase().includes(q)) return true;
  return "children" in n && n.children.some((c) => matches(c, q));
}

const keyLabel = (n: TreeNode) => (n.key === undefined ? "Response" : typeof n.key === "number" ? `item ${n.key + 1}` : n.key);

function RolePicker({ path, onPick }: { path: string; onPick: (role: Role) => void }) {
  return (
    <div role="group" aria-label={`Use ${readablePath(path)} as`} className="glass-thick elevated-2 grid grid-cols-1 gap-1 rounded-md p-2 sm:grid-cols-2" data-role-picker>
      {ROLES.map((r) => (
        <button key={r} type="button" onClick={() => onPick(r)} data-role={r}
          className="flex min-h-11 min-w-11 flex-col items-start justify-center rounded-sm px-3 py-1 text-left hover:bg-line">
          <span className="type-callout text-fg touch:type-body">{ROLE_NAME[r]}</span>
          <span className="type-caption text-glass-muted" data-role-help>{ROLE_HELP[r]}</span>
        </button>
      ))}
    </div>
  );
}

function Leaf({ n, depth, picks, onPick }: { n: Extract<TreeNode, { value: unknown }>; depth: number; picks: FieldPick[]; onPick: (path: string, role: Role, label: string) => void }) {
  const [open, setOpen] = useState(false);
  const picked = picks.find((p) => p.path === n.path);
  const shown = n.type === "string" ? `"${n.value}"` : String(n.value);
  return (
    <li className="flex flex-col gap-1">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-tree-leaf={n.path}
        style={{ paddingLeft: `calc(${depth} * var(--tree-indent, 12px) + 8px)` }}
        className={`flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm pr-2 text-left touch:min-h-11 ${picked ? "bg-accent text-accent-fg" : "text-fg hover:bg-line"}`}>
        <span className={`shrink-0 font-mono type-caption touch:type-body ${picked ? "" : "text-glass-muted"}`}>{keyLabel(n)}</span>
        <span className="min-w-0 flex-1 truncate font-mono type-caption touch:type-body" data-leaf-value>{shown}{n.type === "string" && n.truncated ? " (cut short)" : ""}</span>
        {picked && <span className="shrink-0 type-caption" data-picked-as>{ROLE_NAME[picked.role]}</span>}
      </button>
      {open && <RolePicker path={n.path} onPick={(r) => { onPick(n.path, r, String(n.key ?? r)); setOpen(false); }} />}
    </li>
  );
}

function Branch({ n, depth, picks, onPick, filter }: { n: TreeNode; depth: number; picks: FieldPick[]; onPick: (path: string, role: Role, label: string) => void; filter: string }) {
  // Nested objects and lists past depth 2 start collapsed.
  const [open, setOpen] = useState(depth <= COLLAPSE_DEPTH);
  if (!matches(n, filter)) return null;
  if (!("children" in n)) return <Leaf n={n} depth={depth} picks={picks} onPick={onPick} />;
  const expanded = open || !!filter;
  const summary = n.type === "array" ? `list of ${n.length}` : `${n.children.length} field${n.children.length === 1 ? "" : "s"}`;
  return (
    <li className="flex flex-col">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={expanded} data-tree-branch={n.path}
        style={{ paddingLeft: `calc(${depth} * var(--tree-indent, 12px) + 8px)` }}
        className="flex min-h-8 w-full items-center gap-2 rounded-sm pr-2 text-left text-fg hover:bg-line touch:min-h-11">
        <Chevron open={expanded} />
        <span className="font-mono type-caption touch:type-body">{keyLabel(n)}</span>
        <span className="type-caption text-glass-muted">{summary}</span>
      </button>
      {expanded && <ul className="flex flex-col">{n.children.map((c) => <Branch key={c.path} n={c} depth={depth + 1} picks={picks} onPick={onPick} filter={filter} />)}</ul>}
    </li>
  );
}

/**
 * A readable name from the picked field: "temperature_2m" gives "Temperature", "wind_speed_10m"
 * gives "Wind speed" (usability r3: unit and height suffixes such as _2m, _10m, _ms, _pct dropped).
 */
export function suggestName(picks: FieldPick[]): string {
  const p = picks.find((x) => x.role === "value") ?? picks[0];
  if (!p) return "";
  const words = p.label.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s_.-]+/).filter(Boolean);
  const UNIT = /^(\d+(m|cm|mm|km|h|s|d|min)|ms|pct|percent|c|f|kb|mb|gb|kbps|mbps|hpa)$/i;
  while (words.length > 1 && UNIT.test(words[words.length - 1]!)) words.pop();
  const text = words.join(" ").toLowerCase().slice(0, 80);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function ByExample({ initialUrl, integrationId, queue, existing = [], specUrl }: { initialUrl?: string; integrationId?: string; queue?: Queued[]; existing?: AddressEntry[]; specUrl?: string }) {
  usePageTitle("Custom API");
  const router = useRouter();
  const [input, setInput] = useState(initialUrl ?? "");
  const [method, setMethod] = useState<"GET" | "POST">("GET");
  // Non-secret parts of a pasted curl command, kept (and saved) once the box shows the plain URL.
  const [extra, setExtra] = useState<{ headers: Record<string, string>; body?: string; verifyTls: boolean; dropped: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TryOk | null>(null);
  const [fail, setFail] = useState<TryFail | null>(null);
  const [secretFields, setSecretFields] = useState<SecretField[]>([]);
  const [pendingId, setPendingId] = useState<string | undefined>();
  const [basicUser, setBasicUser] = useState<string | undefined>();
  const [picks, setPicks] = useState<FieldPick[]>([]);
  const [pruned, setPruned] = useState<string[]>([]);
  const [shapeOverride, setShapeOverride] = useState<DataShapeKind | null>(null);
  const [widgetOverride, setWidgetOverride] = useState<DataComponentType | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [refresh, setRefresh] = useState("30");
  const [refreshTouched, setRefreshTouched] = useState(false);
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<string>("auto");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  const isCurl = input.trim().startsWith("curl");
  const json = useMemo(() => (res ? treeToJson(res.tree) : undefined), [res]);
  const proposal = useMemo(() => proposeShape(picks), [picks]);
  const shape = shapeOverride ?? proposal.shape;
  const fields = shapeOverride && shapeOverride !== proposal.shape ? proposeShape(picks).fields : proposal.fields;
  const shownName = name || (nameTouched ? "" : suggestName(picks));
  const preview = useMemo(() => {
    if (!res || picks.length === 0) return null;
    try { return shapeFromFields(json, shape, fields, shownName || "Value"); } catch (e) { return (e as Error).message; }
  }, [res, json, picks, shape, fields, shownName]);
  const suggested = preview && typeof preview !== "string" ? proposeComponent(preview) : COMPONENTS[shape][0]!;
  const widget = widgetOverride && COMPONENTS[shape].includes(widgetOverride) ? widgetOverride : suggested;
  const refreshNum = Number(refresh);
  const refreshError = !Number.isFinite(refreshNum) || refreshNum < 10 ? "Refresh must be at least 10 seconds." : undefined;
  const origin = res ? originOf(res.request.url) : undefined;
  const sameHost = !integrationId && origin ? existing.filter((e) => e.origin === origin) : [];
  const addTo = integrationId ?? (target === "auto" ? sameHost[0]?.id : target === "new" ? undefined : target);
  // (A pasted credential always starts a new integration, so it is sealed for this address.)
  // Fix List r2 item 6: the shown answer must come from the address in the box. After a failed Try it,
  // or once the box changes, the old answer is dimmed and Save waits for a Try it that succeeds.
  const stale = !!res && (!!fail || (!isCurl && input.trim() !== res.request.url));
  const saveWhy = saving ? null : stale ? (fail ? "The last Try it failed. Save stays off until a Try it on the address in the box succeeds." : "The address in the box changed. Try it again to save this one.") : picks.length === 0 ? "Pick at least one field in the response." : typeof preview === "string" ? `The picks do not fit the answer: ${preview}. Remove the picks marked above or choose other fields.` : refreshError ?? null;

  async function tryIt(e?: React.FormEvent) {
    e?.preventDefault();
    if (!input.trim() || busy) return;
    setBusy(true);
    setFail(null);
    try {
      const body = isCurl
        ? { curl: input }
        : { url: input.trim(), method, ...(extra ? { headers: extra.headers, verifyTls: extra.verifyTls, ...(extra.body !== undefined && method === "POST" ? { body: extra.body } : {}) } : {}), ...(pendingId ? { auth: { pendingId } } : integrationId ? { auth: { integrationId } } : {}) };
      const r = await api<TryOk | TryFail>("/api/integrations/try", { body });
      if (r.secretFields?.length) setSecretFields(r.secretFields);
      if (r.pendingId) setPendingId(r.pendingId);
      if (r.ok && r.basicUser !== undefined) setBasicUser(r.basicUser);
      if (r.request) {
        // The box now shows the plain URL; credentials never come back to the browser.
        setInput(r.request.url);
        setMethod(r.request.method);
        if (isCurl) setExtra({ headers: r.request.headers, ...(r.request.body !== undefined ? { body: r.request.body } : {}), verifyTls: r.request.verifyTls, dropped: r.request.droppedHeaders ?? [] });
      }
      if (r.ok) {
        // Keep only the picks the new answer still has, and say which went.
        const next = treeToJson(r.tree);
        const kept = picks.filter((p) => { try { return evaluate(next, p.path).length > 0; } catch { return false; } });
        setPruned(picks.filter((p) => !kept.includes(p)).map((p) => readablePath(p.path)));
        setPicks(kept);
        setRes(r);
        if (r.rateLimit && !refreshTouched) setRefresh(String(Math.max(30, r.rateLimit.refreshSec)));
      } else setFail(r);
    } catch (err) {
      setFail({ ok: false, heading: "Not permitted", error: err instanceof ApiFailure ? err.error : { code: "unreachable", message: "Try it did not finish." } });
    } finally {
      setBusy(false);
    }
  }

  function onPick(path: string, role: Role, label: string) {
    setPicks((p) => [...p.filter((x) => x.path !== path), { path, role, label }]);
    setPruned([]);
    setShapeOverride(null);
  }

  async function save() {
    if (!res || saveWhy) return;
    setSaving(true);
    setSaveError(null);
    const u = new URL(res.request.url);
    const label = shownName || u.pathname;
    let body: unknown;
    if (res.request.method === "POST" && res.request.body !== undefined) { try { body = JSON.parse(res.request.body); } catch { body = res.request.body; } }
    const endpoint = {
      id: (label || "endpoint").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "endpoint",
      label,
      method: res.request.method,
      path: u.pathname,
      ...(u.search ? { query: Object.fromEntries(u.searchParams) } : {}),
      ...(secretFields[0] ? { auth: secretFields[0].key } : {}),
      ...(Object.keys(extra?.headers ?? {}).length ? { headers: extra!.headers } : {}),
      ...(body !== undefined ? { body } : {}),
      fields,
      shape,
      refreshSec: Math.round(refreshNum),
    };
    try {
      if (integrationId || (addTo && !pendingId)) {
        await api(`/api/integrations/${addTo}/endpoints`, { body: endpoint });
        toast({ kind: "success", title: `Added ${endpoint.label}` });
        router.push(`/integrations/${addTo}`);
      } else {
        const config = { baseUrl: u.origin, verifyTls: res.request.verifyTls, ...(basicUser !== undefined ? { username: basicUser } : {}) };
        const t = await api<{ ok: boolean; passId?: string; heading?: string; error?: ApiError }>("/api/integrations/test", { body: { packageId: "custom-api", config, pendingId, customEndpoints: [endpoint] } });
        if (!t.ok) { setSaveError(t.error ?? { code: "bad_response", message: "The test failed." }); return; }
        const created = await api<{ id: string }>("/api/integrations", { body: { packageId: "custom-api", name: u.host, config, pendingId, passId: t.passId, endpoints: [endpoint] } });
        toast({ kind: "success", title: `Saved ${endpoint.label}` });
        router.push(builderReturnFor(created.id) ?? `/integrations/${created.id}`);
      }
    } catch (e) {
      setSaveError(e instanceof ApiFailure ? e.error : { code: "internal", message: "Saving failed." });
    } finally {
      setSaving(false);
    }
  }

  const headerList = Object.entries(extra?.headers ?? {});
  return (
    <Screen data-by-example onFocus={keepFocusedInView}>
      <ScreenHeader title="Set up by example" lead="Paste one endpoint or a curl command. Atrium runs it once on the server, then you pick the fields you want." />

      {/* Wave 2.8 spec import v2: a whole API spec at once, no Try it per read. */}
      <SpecImport {...(initialUrl ? { initialAddress: originOf(initialUrl) ?? initialUrl } : {})} {...(specUrl ? { initialSpecUrl: specUrl } : {})} {...(integrationId ? { integrationId } : {})} />

      {queue && queue.length > 0 && (
        <Window title="integrations / new / custom-api / endpoints to add" padded={false} data-queue>
          <div className="flex flex-col gap-2 p-4">
          <p className="type-callout text-fg">Endpoints from the API spec</p>
          <div className="flex flex-wrap gap-2">
            {queue.map((q) => (
              <Button key={q.method + q.path} variant="quiet" onClick={() => { const base = new URL(input || initialUrl || "http://localhost").origin; setInput(`${base}${q.path}`); setMethod(q.method === "POST" ? "POST" : "GET"); setName(q.summary); setNameTouched(!!q.summary); setPicks([]); setRes(null); }}>
                <span className="font-mono">{q.method} {q.path}</span>
              </Button>
            ))}
          </div>
        </div></Window>
      )}

      <Window title="integrations / new / custom-api" padded={false}>
      <form onSubmit={tryIt} className="flex flex-col gap-3 p-5 max-sm:p-4" aria-label="Try a request">
        <Field label="URL or curl command" htmlFor="try-input">
          {/* The box grows with a pasted curl command so it can be read back, on touch too (mobile r2). */}
          <textarea id="try-input" rows={isCurl ? 4 : 1} className={`${inputClass} h-auto touch:h-auto [field-sizing:content] ${isCurl ? "min-h-30" : "min-h-9 touch:min-h-11"} max-h-96 py-2 font-mono`} value={input} onChange={(e) => setInput(e.target.value)} {...urlInputProps} placeholder="http://10.0.0.9:8080/api/status  or  curl -H 'Authorization: Bearer ...' http://..." data-try-input />
        </Field>
        {headerList.length > 0 && !isCurl && (
          <div className="flex flex-col gap-1" data-kept-headers>
            <p className="type-callout text-fg">Headers from your command, sent now and saved with the endpoint</p>
            <ul className="flex flex-wrap gap-2">
              {headerList.map(([k, v]) => (
                <li key={k} className="flex min-h-8 items-center gap-1 rounded-xs border border-line pl-2 font-mono type-caption text-fg touch:min-h-11" data-kept-header={k}>
                  {k}: {v}
                  <Button variant="quiet" iconOnly aria-label={`Do not send ${k}`} onClick={() => setExtra((x) => x && { ...x, headers: Object.fromEntries(Object.entries(x.headers).filter(([h]) => h !== k)) })}><CloseIcon width={14} height={14} aria-hidden /></Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {extra && extra.dropped.length > 0 && !isCurl && (
          <p className="type-caption text-glass-muted" data-dropped-headers>Not sent and not saved, because Atrium sets these itself: {extra.dropped.join(", ")}.</p>
        )}
        {extra?.body !== undefined && method === "POST" && !isCurl && <p className="break-all type-caption text-glass-muted" data-kept-body>Body sent and saved: <span className="font-mono">{extra.body.slice(0, 300)}</span></p>}
        <div className="flex flex-wrap items-end gap-2">
          {!isCurl && (
            <label className="flex flex-col gap-1">
              <span className="type-callout text-fg">Method</span>
              <select className={`${inputClass} w-28`} value={method} onChange={(e) => setMethod(e.target.value as "GET" | "POST")}><option>GET</option><option>POST</option></select>
            </label>
          )}
          <Button type="submit" variant="secondary" disabled={busy || !input.trim()} aria-busy={busy} data-try-button>{busy && <Spinner label="Trying" />} Try it</Button>
        </div>
        {method === "POST" && !isCurl && <p className="type-caption text-glass-muted">POST is only sent to public APIs. To addresses on your network Atrium only sends plain GET requests, so it cannot change anything there.</p>}
      </form>
      </Window>

      {secretFields.length > 0 && (
        <ul className="flex flex-col gap-1" data-secret-fields>
          {secretFields.map((s) => (
            <li key={s.key} className="flex items-center gap-2 type-body text-fg">
              <span className="text-accent-ink"><LockIcon width={16} height={16} aria-hidden /></span>
              {s.label}: kept on the server from your command, never shown again.
            </li>
          ))}
        </ul>
      )}

      {fail && <ErrorCallout heading={fail.heading} error={fail.error} />}

      {!res && !fail && (
        // Where the answer will appear (premium-feel r2 low): a ghost window with skeleton rows.
        <Window title="integrations / new / custom-api / preview" live={false} padded={false} aria-hidden data-ghost-preview>
          <div className="flex flex-col gap-3 p-5 max-sm:p-4">
            <p className="type-body text-fg-2">The answer shows here as a tree. Pick the fields you want, and they become your data source.</p>
            {[72, 48, 60, 36].map((w) => <div key={w} className="h-4 bg-bg-sunk" style={{ width: `${w}%` }} />)}
          </div>
        </Window>
      )}

      {res && stale && (
        <p role="status" className="type-body text-fg-2" data-stale-response>From the previous address: <span className="break-all font-mono">{res.request.url}</span>. Try it again on the address in the box to save.</p>
      )}

      {res && (
        <div className={`grid grid-cols-1 gap-6 lg:grid-cols-2 ${stale ? "opacity-50" : ""}`} data-response-stale={stale ? "true" : undefined}>
          <Window as="section" title="integrations / new / custom-api / response" padded={false} aria-labelledby="tree-title" data-response-tree>
            <div className="flex min-w-0 flex-col gap-3 p-4 max-sm:px-2">
            <h2 id="tree-title" className="type-title-3 text-fg">Response <span className="type-caption text-glass-muted">HTTP {res.status}. Tap a field to use it.</span></h2>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-glass-muted"><SearchIcon width={16} height={16} aria-hidden /></span>
              <Input aria-label="Find a field" placeholder="Find a field" value={filter} onChange={(e) => setFilter(e.target.value)} className="pl-9" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-tree-filter />
            </div>
            {/* No scroll box of its own: the tree scrolls with the page (mobile r1 finding 1). */}
            <ul className="flex flex-col" data-tree-list><Branch n={res.tree} depth={0} picks={picks} onPick={onPick} filter={filter.trim().toLowerCase()} /></ul>
          </div></Window>

          <Window as="section" id="data-source" title="integrations / new / custom-api / data source" padded={false} aria-labelledby="picks-title" className="scroll-mt-[calc(var(--topbar-height)+env(safe-area-inset-top,0px)+8px)]" data-proposal>
            <div className="flex min-w-0 flex-col gap-4 p-4">
            <h2 id="picks-title" className="type-title-3 text-fg">Your data source</h2>
            {pruned.length > 0 && (
              <p role="status" className="type-caption text-glass-muted" data-pruned>
                {pruned.length === 1 ? "1 earlier pick was removed" : `${pruned.length} earlier picks were removed`}, because this answer does not have {pruned.length === 1 ? "it" : "them"}: {pruned.join(", ")}.
              </p>
            )}
            {picks.length === 0 ? <p className="type-body text-glass-muted">No fields picked yet. Tap a value in the response.</p> : (
              <ul className="flex flex-col gap-1" data-picks>
                {picks.map((p) => (
                  <li key={p.path} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate type-body text-fg" title={p.path} data-pick-path={p.path}>{readablePath(p.path)}</span>
                    <span className="type-caption text-glass-muted">{ROLE_NAME[p.role]}</span>
                    <Button variant="quiet" iconOnly aria-label={`Remove ${readablePath(p.path)}`} onClick={() => setPicks((x) => x.filter((y) => y.path !== p.path))}><CloseIcon width={14} height={14} aria-hidden /></Button>
                  </li>
                ))}
              </ul>
            )}
            {picks.length > 0 && (
              <>
                <p className="type-body text-fg" data-proposed>Shown as: <span className="type-callout">{COMPONENT_NAME[widget] ?? widget}</span> <span className="type-caption text-glass-muted">({SHAPE_NAME[shape].toLowerCase()})</span></p>
                <div className="rounded-md border border-line p-3" data-preview>
                  {typeof preview === "string" ? <p className="type-caption text-warning">{preview}</p> : preview ? <ShapedPreview data={preview} /> : null}
                </div>
                <div>
                  <button type="button" className="flex min-h-8 items-center gap-1 type-callout text-accent-ink touch:min-h-11" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)} data-advanced-toggle>
                    <Chevron open={advanced} /> Advanced
                  </button>
                  {advanced && (
                    <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Data type" htmlFor="ep-shape" hint="How Atrium reads the picked fields.">
                        <select id="ep-shape" className={inputClass} value={shape} onChange={(e) => setShapeOverride(e.target.value as DataShapeKind)} data-shape-select>
                          {(["stat", "series", "table", "status"] as const).map((s) => <option key={s} value={s}>{SHAPE_NAME[s]}</option>)}
                        </select>
                      </Field>
                      <Field label="Component" htmlFor="ep-widget" hint="How a page will draw it.">
                        <select id="ep-widget" className={inputClass} value={widget} onChange={(e) => setWidgetOverride(e.target.value as DataComponentType)} data-widget-select>
                          {COMPONENTS[shape].map((w) => <option key={w} value={w}>{COMPONENT_NAME[w] ?? w}</option>)}
                        </select>
                      </Field>
                    </div>
                  )}
                </div>
                <Field label="Name" htmlFor="ep-name" hint={!nameTouched && shownName ? "Suggested from the field you picked." : undefined}>
                  <Input id="ep-name" value={shownName} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} placeholder="Name this endpoint" maxLength={80} data-ep-name />
                </Field>
                <Field label="Refresh every (seconds)" htmlFor="ep-refresh" hint={res.rateLimit ? `This API allows ${res.rateLimit.limit} requests per ${res.rateLimit.windowSec >= 3600 ? `${Math.round(res.rateLimit.windowSec / 3600)} hour${res.rateLimit.windowSec >= 7200 ? "s" : ""}` : `${res.rateLimit.windowSec} seconds`}, so every ${res.rateLimit.refreshSec} seconds keeps well inside it. At least 10 seconds.` : "At least 10 seconds."} error={refreshError}>
                  <Input id="ep-refresh" type="number" min={10} value={refresh} onChange={(e) => { setRefresh(e.target.value); setRefreshTouched(true); }} aria-invalid={!!refreshError} inputMode="numeric" data-refresh />
                </Field>
                {!integrationId && sameHost.length > 0 && !pendingId && (
                  <fieldset className="flex flex-col gap-1" data-save-target>
                    <legend className="type-callout text-fg">Save to</legend>
                    {[...sameHost.map((h) => ({ id: h.id, text: `Add to the existing ${h.name} integration` })), { id: "new", text: "A new integration" }].map((o, i) => (
                      <label key={o.id} className="flex min-h-8 cursor-pointer items-center gap-3 touch:min-h-11">
                        <input type="radio" name="save-target" className="h-5 w-5 accent-accent" checked={target === o.id || (target === "auto" && i === 0)} onChange={() => setTarget(o.id)} data-save-target-option={o.id} />
                        <span className="type-body text-fg">{o.text}</span>
                      </label>
                    ))}
                  </fieldset>
                )}
                {saveError && <ErrorCallout error={saveError} />}
                <div className="flex flex-col gap-1">
                  <div><Button variant="primary" onClick={() => void save()} disabled={!!saveWhy || saving} aria-describedby={saveWhy ? "save-why" : undefined} data-save-endpoint>{saving && <Spinner label="Saving" />} Save endpoint</Button></div>
                  {saveWhy && <SaveWhy>{saveWhy}</SaveWhy>}
                </div>
              </>
            )}
          </div></Window>
        </div>
      )}

      {res && picks.length > 0 && (
        // One column (mobile r2, r3: every width up to 1023px, where the grid stacks): the data source
        // sits under the whole tree, so a sticky bar says how many fields are picked and jumps to it.
        // It sits above the tab bar under 640px and on the bottom safe area where there is none.
        <div className="fixed inset-x-0 z-20 flex items-center justify-between gap-3 border-t border-line-strong bg-bg-hi py-2 pr-[max(var(--gutter),env(safe-area-inset-right,0px))] pl-[max(var(--gutter),env(safe-area-inset-left,0px))] shadow-window-sm bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom,0px))] sm:bottom-0 sm:pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] lg:hidden" data-picks-bar>
          <span className="type-callout text-fg">Picks ({picks.length})</span>
          <Button variant="primary" onClick={() => document.getElementById("data-source")?.scrollIntoView({ block: "start" })} data-picks-review>Review</Button>
        </div>
      )}
      {res && picks.length > 0 && <div aria-hidden className="h-16 lg:hidden" />}
    </Screen>
  );
}

function SaveWhy({ children }: { children: ReactNode }) {
  return <p id="save-why" className="type-caption text-glass-muted" data-save-why>{children}</p>;
}
