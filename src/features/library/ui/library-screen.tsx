"use client";
// The /library screen (spec 3.6.3 and 3.6.4, design v4 "Versions, Library and Publish"): a grid of
// small windows, each rendering its component with default parameters, a `contains code` tag on
// HTML-block components, and Use, Export and Delete. Import checks the file first and shows its
// parameters, plus the code notice, before anything is saved.
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ControlRunResponse, LibraryComponent, LibraryParam, Principal, RenderContext } from "@/core/contracts";
import { Button, buttonClass, Canvas, PlusIcon, Screen, ScreenHeader, Tag, Window, toast, usePageTitle } from "@/features/shell";
import { RenderNode } from "@/features/components/render/render-node";
import { libraryCardNode } from "../card";
import type { PageScope } from "@/features/components/render/resolve";
import { NodeCssProvider } from "@/features/components/render/context";
import { sampleFor } from "@/features/components/catalogue/samples";
import { templatesIn } from "@/features/components/bindings";
import type { ComponentNode, PropValue } from "@/core/contracts";
import { CONTAINS_CODE_NOTICE } from "../file";

type Item = LibraryComponent & { canUpdate: boolean };
export const EMPTY_LIBRARY = "Nothing saved yet. Select a component in the builder and choose Save to library.";

const refuse = async (): Promise<ControlRunResponse> => ({ ok: false, code: "forbidden", message: "Controls do not run in the library." });

/** The type of the first node that reads a data parameter, so its sample has the right shape. */
function readerType(node: ComponentNode, param: string): string | undefined {
  const re = new RegExp(`\\$param\\.${param}\\b`);
  const walk = (n: ComponentNode): string | undefined => {
    if (templatesIn(n.props as PropValue, "").some((t) => re.test(t.template))) return n.type;
    for (const ch of n.children ?? []) {
      const hit = walk(ch);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(node);
}

/** Library cards render with sample data for data parameters (gauntlet w2-r1 Fix 14), marked "sample". */
function previewCtx(c: Item, principal: Principal): RenderContext {
  const dataParams = c.params.filter((p) => p.kind === "data");
  const sourceOf = (p: LibraryParam) => (typeof p.default === "string" && p.default ? p.default : p.name);
  const values: PageScope = {
    $data: Object.fromEntries(dataParams.map((p) => [sourceOf(p), sampleFor(readerType(c.node, p.name) ?? "stat")])),
    $sources: Object.fromEntries(dataParams.map((p) => [sourceOf(p), { state: "fresh" as const }])),
    $page: { id: "p_libraryxxx", slug: "library", title: "Library" },
    $app: { id: "", slug: "", name: "Library" },
    $user: { kind: "user" },
    $library: { [`${c.id}@${c.version}`]: c },
    $controls: Object.fromEntries(c.params.filter((p) => p.kind === "control" && typeof p.default === "string").map((p) => [p.default as string, { label: p.label }])),
  } as PageScope;
  return { mode: "agent-render", principal, appId: "", pageId: "p_libraryxxx", version: "draft", values, runControl: refuse, confirm: async () => false, navigate: () => {} };
}

function Card({ c, principal, apps, onDeleted, css }: { c: Item; principal: Principal; apps: { slug: string; name: string }[]; onDeleted(): void; css: Record<string, string> }) {
  const node = useMemo(() => libraryCardNode(c), [c]);
  const ctx = useMemo(() => previewCtx(c, principal), [c, principal]);
  const [confirming, setConfirming] = useState(false);
  const [using, setUsing] = useState(false);
  return (
    // The card's window is the only title bar (the component's own bars are hidden in the preview, Fix 4);
    // its status is neutral: "sample" when the preview shows sample data, never "live" (Fix 12).
    <Window as="li" title={`library / ${c.name.toLowerCase().replace(/\s+/g, "-")}`} status={c.params.some((p) => p.kind === "data") ? `sample · v${c.version}` : `v${c.version}`} live={false} padded={false} data-library-card={c.id}>
      <div className="pointer-events-none max-h-56 overflow-hidden border-b border-line" aria-hidden="true" inert data-library-preview>
        <Canvas className="!min-h-0">
          <div className="p-4">
            <NodeCssProvider css={css}>
              <RenderNode node={node} ctx={ctx} />
            </NodeCssProvider>
          </div>
        </Canvas>
      </div>
      <div className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="type-title-3 m-0 text-fg">{c.name}</h2>
          {c.containsCode ? <span data-contains-code><Tag>contains code</Tag></span> : null}
          {c.source === "imported" ? <Tag tone="paper">imported</Tag> : null}
          {c.params.some((p) => p.kind === "data") ? <span data-library-sample><Tag tone="paper">sample data</Tag></span> : null}
        </div>
        {c.description ? <p className="type-body m-0 text-fg-2">{c.description}</p> : null}
        <ParamList params={c.params} />
        <div className="mt-1 flex flex-wrap gap-2">
          <Button variant="ink" onClick={() => setUsing((u) => !u)} aria-expanded={using} data-library-use>
            Use
          </Button>
          <a className={buttonClass("secondary")} href={`/api/library/${encodeURIComponent(c.id)}/export`} data-library-export download>
            Export
          </a>
          {c.canUpdate ? (
            <Button variant="destructive" onClick={() => setConfirming(true)} data-library-delete>
              Delete
            </Button>
          ) : null}
        </div>
        {using ? (
          <div className="flex flex-col gap-1 border border-line-strong p-2" data-library-use-menu>
            <p className="type-caption m-0 text-fg-2">Insert it into an app:</p>
            {apps.length ? (
              <ul className="m-0 flex list-none flex-col p-0">
                {apps.map((a) => (
                  <li key={a.slug}>
                    <a className="type-body text-accent-ink underline underline-offset-2" href={`/build/${encodeURIComponent(a.slug)}?insert=${encodeURIComponent(`lib:${c.id}`)}`}>
                      {a.name}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="type-caption m-0 text-fg-3">You can edit no apps yet. In the builder, it is in the Insert tab under Library.</p>
            )}
          </div>
        ) : null}
        {confirming ? (
          <div role="alertdialog" aria-label={`Delete ${c.name}`} className="flex flex-col gap-2 border border-[color:var(--bad)] p-2" data-library-delete-confirm>
            <p className="type-body m-0 text-fg">Delete {c.name}? Apps that use it keep a plain copy, so nothing breaks.</p>
            <div className="flex gap-2">
              <Button
                variant="destructive-confirm"
                onClick={async () => {
                  const res = await fetch(`/api/library/${encodeURIComponent(c.id)}`, { method: "DELETE", credentials: "same-origin" });
                  if (res.ok) {
                    const j = (await res.json()) as { detached: number };
                    toast({ kind: "success", title: `Deleted ${c.name}`, description: j.detached ? `${j.detached} instances became plain copies.` : undefined });
                    onDeleted();
                  } else toast({ kind: "error", title: "Could not delete", description: ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message });
                }}
              >
                Delete
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Window>
  );
}

function ParamList({ params }: { params: LibraryParam[] }) {
  if (!params.length) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label="Parameters">
      {params.map((p) => (
        <li key={p.name} className="border border-line px-1.5 font-mono text-[11px] text-fg-2">
          {p.kind} · {p.label}
        </li>
      ))}
    </ul>
  );
}

type Check = { name: string; description: string; params: LibraryParam[]; containsCode: boolean; notice?: string; match?: { id: string; name: string; version: number; canUpdate: boolean } | null; copyName?: string };

export function LibraryScreen({ components, principal, apps, css = {} }: { components: Item[]; principal: Principal; apps: { slug: string; name: string }[]; css?: Record<string, Record<string, string>> }) {
  usePageTitle("Library");
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ text: string; check: Check } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(f: File) {
    setError(null);
    setPending(null);
    const text = await f.text();
    const res = await fetch("/api/library/import?check=1", { method: "POST", body: text, credentials: "same-origin", headers: { "content-type": "application/json" } });
    const j = (await res.json().catch(() => ({}))) as Check & { error?: { message: string } };
    if (!res.ok) return setError(j.error?.message ?? "This file could not be read.");
    setPending({ text, check: j });
  }
  async function confirmImport(mode: "copy" | "update" = "copy") {
    if (!pending) return;
    const res = await fetch(`/api/library/import${mode === "update" ? "?mode=update" : ""}`, { method: "POST", body: pending.text, credentials: "same-origin", headers: { "content-type": "application/json" } });
    const j = (await res.json().catch(() => ({}))) as { error?: { message: string } };
    if (!res.ok) return setError(j.error?.message ?? "The import failed.");
    toast({ kind: "success", title: mode === "update" ? `Updated ${pending.check.match?.name ?? pending.check.name}` : `Imported ${pending.check.copyName ?? pending.check.name}` });
    setPending(null);
    router.refresh();
  }

  return (
    <Screen>
      <ScreenHeader
        title="Library"
        lead="Components you saved, with their bindings and style, ready to reuse in any app."
        action={
          <>
            <input ref={file} type="file" accept=".atrium-component,application/json" className="sr-only" aria-label="Import a component file" data-library-file onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
            <Button variant="primary" onClick={() => file.current?.click()} data-library-import>
              <PlusIcon width={16} height={16} aria-hidden />
              Import
            </Button>
          </>
        }
      />
      {error ? (
        <p role="alert" className="type-body mt-6 border border-[color:var(--bad)] bg-bg-hi p-3 text-fg" data-library-error>
          {error}
        </p>
      ) : null}
      {pending ? (
        <Window title="library / import" className="mt-6" data-library-import-review>
          <div className="flex flex-col gap-3">
            <p className="type-title-3 m-0 text-fg">{pending.check.name}</p>
            {pending.check.description ? <p className="type-body m-0 text-fg-2">{pending.check.description}</p> : null}
            <ParamList params={pending.check.params} />
            {pending.check.containsCode ? (
              <p role="note" className="type-body m-0 border border-line-strong bg-bg-sunk p-3 text-fg" data-contains-code-notice>
                {CONTAINS_CODE_NOTICE}
              </p>
            ) : null}
            {pending.check.match ? (
              <p className="type-body m-0 text-fg" data-library-import-match>
                This file is {pending.check.match.name}, which is already in your library at v{pending.check.match.version}.
              </p>
            ) : pending.check.copyName && pending.check.copyName !== pending.check.name ? (
              <p className="type-body m-0 text-fg-2" data-library-import-rename>
                A component named {pending.check.name} already exists, so this one is saved as {pending.check.copyName}.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {pending.check.match?.canUpdate ? (
                <Button variant="ink" onClick={() => void confirmImport("update")} data-library-import-update>
                  Update {pending.check.match.name} to v{pending.check.match.version + 1}
                </Button>
              ) : null}
              <Button variant={pending.check.match?.canUpdate ? "secondary" : "ink"} onClick={() => void confirmImport("copy")} data-library-import-confirm>
                {pending.check.match ? `Save as ${pending.check.copyName ?? "a copy"}` : "Import"}
              </Button>
              <Button variant="quiet" onClick={() => setPending(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </Window>
      ) : null}
      {components.length ? (
        <ul className="mt-10 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-6 p-0" data-library-grid>
          {components.map((c) => (
            <Card key={c.id} c={c} principal={principal} apps={apps} css={css[c.id] ?? {}} onDeleted={() => router.refresh()} />
          ))}
        </ul>
      ) : (
        <p className="type-body-lg mt-10 text-fg-2" data-library-empty>
          {EMPTY_LIBRARY}
        </p>
      )}
    </Screen>
  );
}
