"use client";
// Versions (design v4 "Versions"; spec "Versions", criteria 27 and 28): a timeline of version cards, a
// side-by-side preview of the selected version and the one before it (or any chosen version), and the
// readable diff grouped by page. Restore opens the publish review against the live version.
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppDocument, Principal, RenderContext, Theme } from "@/core/contracts";
import { Button, EmptyRoom, Screen, ScreenHeader, Tag, Window } from "@/features/shell";
import { AppFrame } from "@/features/builder/app-frame";
import type { DiffGroup } from "../diff";
import type { VersionCard } from "../service";
import { DiffLines } from "./diff-lines";
import { ReviewSheet } from "./review-sheet";
import { SelectMenu } from "@/features/settings/ui/controls";

type Rendered = { doc: AppDocument; pageId: string | null; theme: Theme; canvasCss: string; chromeCss: string; nodeCss: Record<string, string> };

function Preview({ appId, version, principal, label }: { appId: string; version: number | null; principal: Principal; label: string }) {
  const [r, setR] = useState<Rendered | null>(null);
  useEffect(() => {
    setR(null);
    if (!version) return;
    fetch(`/api/apps/${appId}/versions/${version}?render=1`, { credentials: "same-origin" }).then((x) => (x.ok ? x.json() : null)).then((j) => setR(j)).catch(() => {});
  }, [appId, version]);
  const page = r?.pageId ? r.doc.pages.find((p) => p.id === r.pageId) ?? null : null;
  // Nothing to compare with: one line, not an empty 320px frame (gauntlet w2-r1 item 18).
  if (!version) return <p className="flex min-h-11 flex-1 items-center self-start border border-dashed border-line px-3 type-body text-fg-2" data-version-preview="none">Nothing before this version.</p>;
  const ctx: RenderContext | null = r ? { mode: "view", principal, appId, pageId: page?.id ?? "", version: version ?? 0, values: { $data: {}, $page: { id: page?.id ?? "", slug: page?.slug ?? "", title: page?.title ?? "" }, $app: { id: appId, slug: "", name: r.doc.app.name }, $user: { kind: "user" }, $available: true } as RenderContext["values"], runControl: async () => ({ ok: false, code: "forbidden", message: "Previews do not run controls." }), confirm: async () => false, navigate: () => {} } : null;
  return (
    <Window title={label} className="min-w-0 flex-1" padded={false} data-version-preview={version ?? "none"}>
      <div className="relative h-[320px] overflow-hidden bg-bg-sunk">
        {!r || !ctx ? (
          <p className="p-4 type-body text-fg-2">Loading v{version}...</p>
        ) : (
          <div className="pointer-events-none absolute left-0 top-0 w-[200%] origin-top-left scale-50" inert>
            <AppFrame doc={r.doc} page={page} ctx={ctx} theme={r.theme} canvasCss={r.canvasCss} chromeCss={r.chromeCss} nodeCss={r.nodeCss} frameId={`v${version}`} hrefFor={() => "#"} className="min-h-[640px]" />
          </div>
        )}
      </div>
    </Window>
  );
}

export function VersionsScreen({ app, versions, principal }: { app: { id: string; slug: string; name: string }; versions: VersionCard[]; principal: Principal }) {
  const router = useRouter();
  const [selected, setSelected] = useState<number | null>(versions[0]?.version ?? null);
  const [compare, setCompare] = useState<number | "prev">("prev");
  const [groups, setGroups] = useState<DiffGroup[] | null>(null);
  const [restore, setRestore] = useState<number | null>(null);
  const against = useMemo(() => {
    if (!selected) return null;
    if (compare !== "prev") return compare;
    const older = versions.filter((v) => v.version < selected).map((v) => v.version);
    return older.length ? Math.max(...older) : null;
  }, [selected, compare, versions]);
  useEffect(() => {
    if (!selected) return;
    setGroups(null);
    fetch(`/api/apps/${app.id}/diff?a=${against ?? 0}&b=${selected}`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : { groups: [] })).then((j: { groups: DiffGroup[] }) => setGroups(j.groups)).catch(() => setGroups([]));
  }, [app.id, selected, against]);
  return (
    <Screen>
      <ScreenHeader title="Versions" lead={`Every published version of ${app.name}. Restoring publishes a copy as a new version.`} action={<Button variant="secondary" href={`/build/${app.slug}`}>Back to the builder</Button>} />
      {versions.length === 0 ? (
        <div className="mt-8"><EmptyRoom headingLevel={2} title="No versions yet." body="Publish to create v1." actions={<Button variant="primary" href={`/build/${app.slug}`}>Open the builder</Button>} /></div>
      ) : (
        <div className="mt-8 flex flex-col gap-8 pb-16 lg:flex-row">
          {/* A vertical timeline: a hairline spine with a dot per version; the selected card is raised. */}
          <ol className="relative flex w-full flex-col gap-3 pl-6 before:absolute before:bottom-2 before:left-[7px] before:top-2 before:w-px before:bg-line-strong lg:w-[320px] lg:flex-none" aria-label="Version timeline" data-version-timeline>
            {versions.map((v) => (
              <li key={v.version} className="relative">
                <span aria-hidden className={`absolute -left-[22px] top-4 h-3 w-3 border border-line-strong ${v.live ? "bg-accent" : selected === v.version ? "bg-fg" : "bg-bg-hi"}`} data-version-dot />
                <button type="button" onClick={() => setSelected(v.version)} aria-pressed={selected === v.version} className={`flex w-full flex-col gap-1 border bg-bg-hi p-3 text-left transition-[transform,box-shadow] duration-150 motion-reduce:transition-none ${selected === v.version ? "-translate-x-0.5 -translate-y-0.5 border-line-strong shadow-window" : "border-line hover:border-line-strong"}`} data-version-card={v.version}>
                  <span className="flex items-center gap-2"><span className="type-title-3">v{v.version}</span><Tag tone={v.source === "publish" ? "paper" : "ink"}>{v.source}</Tag>{v.live && <Tag tone="gold">live</Tag>}</span>
                  <span className="type-caption text-fg-2">{v.by} · {new Date(v.at).toLocaleString()}</span>
                  {v.note && <span className="type-body">{v.note}</span>}
                  {v.restoredFrom && <span className="font-mono text-[11px] text-fg-2">from v{v.restoredFrom}</span>}
                </button>
              </li>
            ))}
          </ol>
          {selected && (
            <div className="flex min-w-0 flex-1 flex-col gap-6">
              <div className="flex flex-wrap items-center gap-3">
                <div className="w-56" data-compare>
                  <SelectMenu label="Compare with" name="compare" value={String(compare)} onChange={(v) => setCompare(v === "prev" ? "prev" : Number(v))} options={[{ value: "prev", label: "the version before it" }, ...versions.filter((v) => v.version !== selected).map((v) => ({ value: String(v.version), label: `v${v.version}` }))]} />
                </div>
                <span className="ml-auto" />
                {!versions.find((v) => v.version === selected)?.live && <Button variant="secondary" onClick={() => setRestore(selected)} data-restore={selected}>Restore v{selected}</Button>}
              </div>
              <div className="flex flex-col gap-4 md:flex-row">
                <Preview appId={app.id} version={against} principal={principal} label={against ? `v${against}` : "before"} />
                <Preview appId={app.id} version={selected} principal={principal} label={`v${selected}`} />
              </div>
              <Window title={`diff / v${against ?? 0} to v${selected}`}>
                {groups ? <DiffLines groups={groups} empty="These two versions are the same." /> : <p className="type-body text-fg-2">Comparing...</p>}
              </Window>
            </div>
          )}
        </div>
      )}
      {restore && <ReviewSheet appId={app.id} open restore={restore} onClose={() => setRestore(null)} onDone={() => { setRestore(null); router.refresh(); }} />}
    </Screen>
  );
}
