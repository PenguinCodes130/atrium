"use client";
// Service tiles and the start page (Wave 2.9, direct-data-spec.md 3.5 and 3.7; Amendment 10, A10.5 to
// A10.8). Insert > Service tile asks which service (a connected integration, or "Just a link") and fills
// the tile: icon, name, address, a live status and the service's headline stats, all as managed sources.
// The start page lists every connected service ticked, takes plain links, and makes the whole page in one
// change; from the builder it is one undoable edit, from New app a fresh app opens on it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppDocument, CatalogueItem, CatalogueResponse, CatalogueService, DraftOp } from "@/core/contracts";
import { Button, Sheet } from "@/features/shell";
import { Checkbox } from "@/features/settings/ui/controls";
import { PackageIcon } from "@/features/integrations/ui/package-icon";
import { PICK_RETURN_KEY } from "@/features/integrations/ui/return-to-builder";
import { cleanLink, linkName } from "@/features/apps/start-page";
import type { BindableIntegration } from "./data-picker";
import { barItemOps, tileIcon, tileOps, type BarEndpoint, type ReadInfo } from "./direct-data";
import { choiceParams } from "./data-pick";
import { measureOf } from "@/features/data/measure";

const input = "h-11 w-full border border-line-strong bg-bg-hi px-3 type-body outline-none focus-visible:outline-2 focus-visible:outline-accent-ink";
const row = "flex min-h-11 w-full items-center gap-3 border border-line px-3 py-2 text-left hover:bg-bg-sunk focus-visible:outline-2 focus-visible:outline-accent-ink";
const KIND_WORDS: Record<string, string> = { containers: "Containers", media: "Media", monitoring: "Monitoring", network: "Network", "smart-home": "Smart home", storage: "Storage", other: "Other" };

/** The services the person may use (catalogue `services`), without Atrium's own. */
export function useServices(): { services: CatalogueService[] | null; error: string | null } {
  const [s, setS] = useState<{ services: CatalogueService[] | null; error: string | null }>({ services: null, error: null });
  useEffect(() => {
    let live = true;
    fetch("/api/data/catalogue?limit=1", { credentials: "same-origin" })
      .then(async (r) => { const j = (await r.json().catch(() => null)) as CatalogueResponse | null; if (live) setS(r.ok && j ? { services: j.services.filter((x) => x.integrationId !== "atrium"), error: null } : { services: [], error: "Your services could not be listed." }); })
      .catch(() => { if (live) setS({ services: [], error: "Atrium could not be reached." }); });
    return () => { live = false; };
  }, []);
  return s;
}

/** Read words and timing from the bindable listing (editors only), for managed source labels and refresh. */
export function readInfoFrom(bindable: BindableIntegration[] | null): ReadInfo {
  return (integrationId, endpointId) => {
    const e = bindable?.find((b) => b.integrationId === integrationId)?.endpoints.find((x) => x.id === endpointId);
    return e ? { label: e.label, shape: e.shape as never, defaultRefreshSec: e.defaultRefreshSec, minRefreshSec: e.minRefreshSec } : null;
  };
}

/** Insert > Service tile: which service is it? (spec 3.5) */
export function ServiceChooser({ nodeId, doc, bindable, apply, onClose }: { nodeId: string; doc: AppDocument; bindable: BindableIntegration[] | null; apply(ops: DraftOp[]): void; onClose(placed: boolean): void }) {
  const { services, error } = useServices();
  const [name, setName] = useState("");
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const info = readInfoFrom(bindable);
  const place = (svc: CatalogueService) => {
    const t = tileOps(doc, { integrationId: svc.integrationId, name: svc.name, packageId: svc.packageId, icon: tileIcon(svc.icon || svc.packageId), headline: svc.headline, ...(svc.openUrl ? { openUrl: svc.openUrl } : {}), description: KIND_WORDS[svc.kind] ?? "" }, info);
    apply([...t.ops, { op: "node.update", nodeId, patch: { name: svc.name.slice(0, 60), props: t.props } } as DraftOp]);
    onClose(true);
  };
  const placeLink = () => {
    const clean = cleanLink(href);
    if (!clean) { setLinkError("Type an http or https address, like http://10.0.0.5:8096."); return; }
    const n = linkName(name, clean);
    const t = tileOps(doc, { link: { name: n, href: clean } }, info);
    apply([...t.ops, { op: "node.update", nodeId, patch: { name: n.slice(0, 60), props: t.props } } as DraftOp]);
    onClose(true);
  };
  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(false); }} title="Which service?" path="builder / service tile" name="service-chooser" width={480}
      footer={<Button variant="quiet" onClick={() => onClose(false)} data-service-cancel>Cancel</Button>}>
      <div className="flex flex-col gap-4" data-service-chooser>
        {error && <p role="alert" className="type-body m-0 text-bad">{error}</p>}
        <section className="flex flex-col gap-1">
          <h3 className="type-caption m-0 font-medium text-fg-2">Your services</h3>
          {services === null ? <ul className="m-0 flex list-none flex-col gap-1 p-0">{[0, 1, 2].map((i) => <li key={i} className="h-11 border border-line bg-bg-sunk" />)}</ul>
            : services.length === 0 ? (
              <div className="flex flex-col gap-2 border border-line p-3" data-service-none>
                <p className="type-body m-0">Connect a service first, or make a tile for any address below.</p>
                <Button variant="secondary" href="/integrations/new" onClick={() => { try { window.sessionStorage.setItem(PICK_RETURN_KEY, JSON.stringify({ path: window.location.pathname, at: Date.now() })); } catch { /* blocked */ } }} data-pick-connect>Connect a service</Button>
              </div>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {services.map((s) => (
                  <li key={s.integrationId}>
                    <button type="button" className={row} onClick={() => place(s)} data-service-pick={s.integrationId}>
                      <PackageIcon id={s.icon || s.packageId} size={24} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="type-body truncate font-medium">{s.name}</span>
                        <span className="type-caption truncate text-fg-2">{KIND_WORDS[s.kind] ?? "Other"}{s.headline.length ? ` · ${s.headline.map((h) => h.label).join(", ")}` : ""}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </section>
        <section className="flex flex-col gap-2 border border-line p-3" data-service-link>
          <h3 className="type-label m-0">Just a link</h3>
          <p className="type-caption m-0 text-fg-2">Any service you run, even without an integration. The tile shows whether it answers, and how fast.</p>
          <label className="flex flex-col gap-1 type-caption">Name<input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Jellyfin" data-service-link-name /></label>
          <label className="flex flex-col gap-1 type-caption">Address<input className={input} value={href} inputMode="url" onChange={(e) => { setHref(e.target.value); setLinkError(null); }} onKeyDown={(e) => { if (e.key === "Enter") placeLink(); }} placeholder="http://10.0.0.5:8096" aria-invalid={!!linkError || undefined} data-service-link-href /></label>
          {linkError && <p role="alert" className="type-caption m-0 text-bad" data-service-link-error>{linkError}</p>}
          <Button variant="secondary" onClick={placeLink} disabled={!href.trim()} data-service-link-use>Make the tile</Button>
        </section>
      </div>
    </Sheet>
  );
}

/** The resource bar's machine choices: things that report CPU (Prometheus machines, Proxmox nodes). */
function useMachines(): { value: string; label: string; integrationId: string; name: string; service: string }[] {
  const [list, setList] = useState<{ value: string; label: string; integrationId: string; name: string; service: string }[]>([]);
  useEffect(() => {
    let live = true;
    fetch(`/api/data/catalogue?${new URLSearchParams({ measure: "cpu", fits: "stat", limit: "200" })}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<CatalogueResponse>) : null))
      .then((j) => {
        if (!live || !j) return;
        const seen = new Map<string, { value: string; label: string; integrationId: string; name: string; service: string }>();
        for (const it of j.items as CatalogueItem[]) {
          if (!it.thing || it.thing.value === "*" || it.shape !== "stat" || it.integrationId === "atrium") continue;
          // A thing named by its raw metric (no machine label) is not a machine a person would pick.
          if (/^[a-z][a-z0-9]*(_[a-z0-9]+){2,}$/.test(it.thing.label)) continue;
          const value = JSON.stringify([it.integrationId, it.thing.value]);
          if (!seen.has(value)) seen.set(value, { value, label: `${it.thing.label} (${it.integrationName})`, integrationId: it.integrationId, name: it.thing.label, service: it.integrationName });
        }
        setList([...seen.values()]);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return list;
}

export type StartChoice = { integrationIds: string[]; links: { name: string; href: string }[]; machine?: { integrationId: string; thing: string; label: string } };

/** The start page's form: services ticked, plain links, and which machine the resource bar shows (spec 3.7). */
/**
 * Round 2 (gauntlet r1, low): who made each integration, so "Your services" ticks only the person's own;
 * services other people share with them are listed after, unticked. Null while loading or unknown.
 */
function useMine(): Set<string> | null {
  const [mine, setMine] = useState<Set<string> | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/api/auth/get-session", { credentials: "same-origin" }).then((r) => (r.ok ? (r.json() as Promise<{ user?: { id?: string } } | null>) : null)),
      fetch("/api/integrations", { credentials: "same-origin" }).then((r) => (r.ok ? (r.json() as Promise<{ integrations?: { id: string; createdById?: string }[] }>) : null)),
    ]).then(([session, list]) => {
      if (!live) return;
      const me = session?.user?.id;
      if (!me || !list?.integrations) return setMine(new Set(["*"]));
      setMine(new Set(list.integrations.filter((i) => i.createdById === me).map((i) => i.id)));
    }).catch(() => { if (live) setMine(new Set(["*"])); });
    return () => { live = false; };
  }, []);
  return mine;
}

export function StartPageForm({ onChoice, busy, error }: { onChoice(c: StartChoice | null): void; busy?: boolean; error?: string | null }) {
  const { services: all } = useServices();
  const mine = useMine();
  const isMine = (id: string) => !mine || mine.has("*") || mine.has(id);
  // The person's own services first; other people's (shared with them) after, starting unticked.
  const services = useMemo(() => (all && mine ? [...all.filter((x) => isMine(x.integrationId)), ...all.filter((x) => !isMine(x.integrationId))] : all && !mine ? null : all), [all, mine]);
  const machines = useMachines();
  const [off, setOff] = useState<Set<string>>(new Set());
  const offSet = useRef(false);
  useEffect(() => {
    if (offSet.current || !services || !mine) return;
    offSet.current = true;
    setOff(new Set(services.filter((x) => !isMine(x.integrationId)).map((x) => x.integrationId)));
  }, [services, mine]);
  const [links, setLinks] = useState<{ name: string; href: string }[]>([]);
  const [name, setName] = useState("");
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [machine, setMachine] = useState("host");
  const ids = useMemo(() => (services ?? []).filter((s) => !off.has(s.integrationId)).map((s) => s.integrationId), [services, off]);
  const shownMachines = useMemo(() => machines.filter((m) => ids.includes(m.integrationId)), [machines, ids.join(",")]);
  // A machine of a service ticked off falls back to this server.
  useEffect(() => { if (machine !== "host" && !shownMachines.some((m) => m.value === machine)) setMachine("host"); }, [shownMachines, machine]);
  useEffect(() => {
    const m = machine === "host" ? null : (JSON.parse(machine) as [string, string]);
    const label = m ? machines.find((x) => x.value === machine)?.label.replace(/ \([^)]*\)$/, "") ?? m[1] : "";
    onChoice(ids.length || links.length ? { integrationIds: ids, links, ...(m ? { machine: { integrationId: m[0], thing: m[1], label } } : {}) } : null);
  }, [ids.join(","), JSON.stringify(links), machine]);
  const addLink = () => {
    const clean = cleanLink(href);
    if (!clean) { setLinkError("Type an http or https address, like http://10.0.0.5:8096."); return; }
    setLinks((l) => [...l, { name: linkName(name, clean), href: clean }]);
    setName("");
    setHref("");
  };
  return (
    <div className="flex flex-col gap-4" data-start-form>
      <section className="flex flex-col gap-1">
        <h3 className="type-label m-0">Your services</h3>
        {services === null ? <p className="type-caption m-0 text-fg-2">Loading your services…</p>
          : services.length === 0 ? (
            <div className="flex flex-col gap-2 border border-line p-3" data-start-none>
              <p className="type-body m-0">Connect a service first. Plain links below still work.</p>
              <Button variant="secondary" href="/integrations/new" data-pick-connect>Connect a service</Button>
            </div>
          ) : services.map((s, i) => (
            <div key={s.integrationId} className="contents">
              {!isMine(s.integrationId) && (i === 0 || isMine(services[i - 1]!.integrationId)) && <h4 className="type-caption m-0 mt-2 font-medium text-fg-2" data-start-shared-heading>Shared with you by other people</h4>}
              <Checkbox checked={!off.has(s.integrationId)} onCheckedChange={(on) => setOff((o) => { const n = new Set(o); if (on) n.delete(s.integrationId); else n.add(s.integrationId); return n; })} label={s.name} description={KIND_WORDS[s.kind] ?? "Other"} data-start-service={s.integrationId} data-start-service-mine={isMine(s.integrationId) ? "yes" : "no"} />
            </div>
          ))}
      </section>
      <section className="flex flex-col gap-2" data-start-links>
        <h3 className="type-label m-0">Plain links</h3>
        {links.map((l, i) => (
          <div key={`${l.href}-${i}`} className="flex items-center gap-2 border border-line px-3 py-1" data-start-link={i}>
            <span className="type-body min-w-0 flex-1 truncate">{l.name} · <span className="font-mono text-[12px] text-fg-2">{l.href}</span></span>
            <button type="button" className="inline-flex min-h-11 items-center px-2 type-caption underline" onClick={() => setLinks((x) => x.filter((_, j) => j !== i))} data-start-link-remove={i}>Remove</button>
          </div>
        ))}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr]">
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Link name" data-start-link-name />
          <input className={input} value={href} inputMode="url" onChange={(e) => { setHref(e.target.value); setLinkError(null); }} onKeyDown={(e) => { if (e.key === "Enter") addLink(); }} placeholder="http://10.0.0.5:8096" aria-label="Link address" aria-invalid={!!linkError || undefined} data-start-link-href />
        </div>
        {linkError && <p role="alert" className="type-caption m-0 text-bad">{linkError}</p>}
        <Button variant="secondary" onClick={addLink} disabled={!href.trim()} data-start-link-add>Add the link</Button>
      </section>
      <section className="flex flex-col gap-1" data-start-machine>
        {/* Round 2 item 17: a bounded list inside the sheet (the dropdown drew its options outside it and the
            wheel could not reach the person's machines), with only the machines of the services ticked above. */}
        <span className="type-label" id="start-machine-label">The resource bar shows</span>
        <div role="radiogroup" aria-labelledby="start-machine-label" className="flex max-h-60 flex-col overflow-y-auto overscroll-contain border border-line-strong" data-start-machine-list>
          {[{ value: "host", label: "This Atrium server", name: "This Atrium server", service: "" }, ...shownMachines].map((m) => {
            const on = machine === m.value;
            return (
              <button key={m.value} type="button" role="radio" aria-checked={on} onClick={() => setMachine(m.value)} className={`flex min-h-11 w-full flex-none items-center gap-3 border-b border-line px-3 text-left last:border-b-0 hover:bg-bg-sunk focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-ink ${on ? "bg-bg-sunk" : ""}`} data-start-machine-option={m.value}>
                <span aria-hidden className={`inline-flex size-4 flex-none items-center justify-center rounded-full border border-[color:var(--ink)] dark:border-line-strong`}>{on ? <span className="size-2 rounded-full bg-[color:var(--ink)] dark:bg-fg" /> : null}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="type-body truncate">{m.name}</span>
                  {m.service ? <span className="type-caption truncate text-fg-2">{m.service}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      {error && <p role="alert" className="type-body m-0 text-bad" data-start-error>{error}</p>}
      {busy && <p className="type-caption m-0 text-fg-2">Making the page…</p>}
    </div>
  );
}

/** Insert > Start page in the builder: the ops are planned on the server and applied here as one undoable edit. */
export function StartPageSheet({ appId, apply, onClose, onMade }: { appId: string; apply(ops: DraftOp[]): void; onClose(): void; onMade(pageId: string): void }) {
  const [choice, setChoice] = useState<StartChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/apps/${encodeURIComponent(appId)}/start-page`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...choice, plan: true }) }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { ops?: DraftOp[]; pageId?: string; error?: { message?: string } } | null;
    setBusy(false);
    if (!r?.ok || !j?.ops || !j.pageId) { setError(j?.error?.message ?? "The start page could not be made."); return; }
    apply(j.ops);
    onMade(j.pageId);
  };
  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }} title="Start page from your services" path="builder / start page" name="start-page" width={520}
      footer={<div className="flex gap-2"><Button variant="primary" onClick={() => void make()} disabled={!choice || busy} data-start-make>Make the page</Button><Button variant="quiet" onClick={onClose} data-start-cancel>Cancel</Button></div>}>
      <div className="flex flex-col gap-3" data-start-sheet>
        <p className="type-body m-0 text-fg-2">A resource bar on top, then a group for each kind of service with a tile per service and its live numbers. Everything stays editable, and one undo takes it all back.</p>
        <StartPageForm onChoice={setChoice} busy={busy} error={error} />
      </div>
    </Sheet>
  );
}

/** Insert > Resource bar: which machine it shows (spec 3.6), then its CPU, memory, disk and uptime fill in. */
export function MachineChooser({ nodeId, doc, bindable, apply, onClose }: { nodeId: string; doc: AppDocument; bindable: BindableIntegration[] | null; apply(ops: DraftOp[]): void; onClose(): void }) {
  const machines = useMachines();
  const fill = (integrationId: string, machine: { thing: string; label: string } | null) => {
    const eps = (bindable?.find((b) => b.integrationId === integrationId)?.endpoints ?? []) as unknown as BarEndpoint[];
    const r = barItemOps(doc, integrationId, eps, machine, (e) => measureOf({ measure: e.measure as never, label: e.label, group: e.group, shape: e.shape as never }), (e) => choiceParams(e.params)[0]?.key ?? null);
    if (r.items.length) apply([...r.ops, { op: "node.update", nodeId, patch: { props: { items: r.items } } } as DraftOp]);
    onClose();
  };
  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }} title="Which machine?" path="builder / resource bar" name="machine-chooser" width={440}
      footer={<Button variant="quiet" onClick={onClose} data-machine-cancel>Leave it empty</Button>}>
      <div className="flex flex-col gap-2" data-machine-chooser>
        <p className="type-caption m-0 text-fg-2">The bar shows its CPU, memory, disk and uptime. Change any reading later from the Data group.</p>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          <li><button type="button" className={row} onClick={() => fill("atrium", null)} data-machine-pick="host"><span className="type-body font-medium">This Atrium server</span></button></li>
          {machines.map((m) => {
            const [integrationId, thing] = JSON.parse(m.value) as [string, string];
            return <li key={m.value}><button type="button" className={row} onClick={() => fill(integrationId, { thing, label: m.label.replace(/ \([^)]*\)$/, "") })} data-machine-pick={thing}><span className="type-body min-w-0 flex-1 truncate font-medium">{m.label}</span></button></li>;
          })}
        </ul>
      </div>
    </Sheet>
  );
}
