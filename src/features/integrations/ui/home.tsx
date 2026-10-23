"use client";
// The Integrations page: saved integrations, declarative packages and packages with problems.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { PackageProblem } from "@/core/contracts";
import { Button, PlusIcon, Screen, ScreenHeader, Window, usePageTitle, toast } from "@/features/shell";
import type { IntegrationView, PackageCard } from "../service";
import { AddIntegration } from "./gallery";
import { api, ApiFailure, ErrorCallout, formatDate, HealthLine, HealthStatus, integrationPath, LockedNotice, packageSegment, UntestedBadge, type ApiError } from "./common";
import { PackageIcon } from "./package-icon";
import { integrationsTabs } from "./view-tabs";

export function IntegrationCard({ i }: { i: IntegrationView }) {
  // Design v4 title bar: a readable path (package, then the name as a slug) and the health on the right.
  return (
    <Window as="li" title={integrationPath(i)} status={<HealthStatus i={i} />} live={!!i.lastHealth && i.lastHealth.status !== "down" && i.status === "active"} padded={false} data-integration-card={i.id}>
      <Link href={`/integrations/${i.id}`} className="flex items-start gap-4 p-5 hover:bg-bg-sunk max-sm:p-4">
        <span className="flex size-12 flex-none items-center justify-center bg-bg-sunk"><PackageIcon id={i.packageId} size={28} /></span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 type-title-3 text-fg">
            <span className="min-w-0 break-words">{i.name}</span>
            {i.status !== "active" && <span className="border border-line-strong px-1.5 type-label text-fg-2" data-status-badge={i.status}>{i.status === "draft" ? "Draft" : "Disabled"}</span>}
          </p>
          <p className="type-body text-fg-2">{i.packageName}</p>
          <div className="mt-2 flex flex-col gap-1">
            {i.locked ? <LockedNotice /> : i.lastHealth ? <HealthLine {...i.lastHealth} /> : <UntestedBadge />}
            {i.packageMissing && <p className="type-caption text-warn-ink">The package for this integration is not installed.</p>}
          </div>
        </div>
      </Link>
    </Window>
  );
}

export function IntegrationsHome({ integrations, packages, declarative, problems, canEdit }: { integrations: IntegrationView[]; packages: PackageCard[]; declarative: PackageCard[]; problems: PackageProblem[]; canEdit: boolean }) {
  usePageTitle("Integrations");
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function importFile(f: File) {
    setError(null);
    try {
      const card = await api<PackageCard>("/api/integrations/packages", { body: await f.text() });
      toast({ kind: "success", title: `Imported ${card.name}` });
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.error : { code: "internal", message: "The import failed." });
    }
  }

  async function remove(id: string) {
    if (!window.confirm(`Delete the package ${id}? Integrations that use it stop working until it is imported again.`)) return;
    try {
      await api(`/api/integrations/packages/${id.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" });
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.error : { code: "internal", message: "Delete failed." });
    }
  }

  return (
    <Screen data-integrations-home>
      <ScreenHeader
        title="Integrations"
        lead={integrations.length === 0 ? <span data-empty-line>Connect your first service</span> : "The services Atrium reads from, and what they can change."}
        action={canEdit && integrations.length > 0 ? <Button variant="primary" href="/integrations/new"><PlusIcon width={16} height={16} aria-hidden /> Add integration</Button> : undefined}
        tabs={integrationsTabs("services")}
      />
      {integrations.length === 0 ? (
        <AddIntegration packages={packages} canEdit={canEdit} embedded />
      ) : (
        <section aria-label="Your integrations" className="flex flex-col gap-4">
          <ul className="grid grid-cols-1 gap-6 md:grid-cols-2" data-integrations-list>{integrations.map((i) => <IntegrationCard key={i.id} i={i} />)}</ul>
        </section>
      )}

      <section aria-labelledby="packages" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="packages" className="type-title-3 text-fg">Your packages</h2>
          {canEdit && (
            <>
              <Button variant="secondary" onClick={() => file.current?.click()}>Import package</Button>
              <input ref={file} type="file" accept=".json,application/json" className="sr-only" aria-label="Package file" data-import-input onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
            </>
          )}
        </div>
        {error && <ErrorCallout error={error} heading="Package problem" />}
        {declarative.length === 0 ? (
          <p className="type-body text-glass-muted">Packages you save from a Custom API, or that an agent makes, show here. You can export them to share.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {declarative.map((p) => (
              <Window as="li" key={p.id} title={`integrations / packages / ${packageSegment(p.id)}`} status={p.status === "draft" ? "draft" : undefined} padded={false} data-declarative={p.id}>
                <div className="flex flex-wrap items-center gap-3 p-3">
                <PackageIcon id={p.id} size={22} />
                <div className="min-w-0 flex-1">
                  <p className="type-callout text-fg">{p.name} {p.status === "draft" && <span className="type-caption text-glass-muted">(draft)</span>}</p>
                  <p className="type-caption text-glass-muted font-mono">{p.id}</p>
                </div>
                <Button variant="quiet" href={`/integrations/new/${p.id}`}>Use</Button>
                <a className="inline-flex h-9 items-center rounded-sm px-3 type-callout text-glass-muted hover:bg-line" href={`/api/integrations/packages/${p.id}`} download>Export</a>
                {canEdit && <Button variant="destructive" onClick={() => void remove(p.id)}>Delete</Button>}
              </div></Window>
            ))}
          </ul>
        )}
      </section>

      {problems.length > 0 && (
        <section aria-labelledby="problems" className="flex flex-col gap-3" data-package-problems>
          <h2 id="problems" className="type-title-3 text-fg">Packages with problems</h2>
          <Window title="integrations / packages with problems" padded={false}>
            <div className="overflow-x-auto p-4">
            <table className="w-full type-body text-fg">
              <thead><tr className="text-left type-callout text-glass-muted"><th className="pr-4">Package</th><th className="pr-4">Source</th><th className="pr-4">Problem</th><th>Since</th></tr></thead>
              <tbody>
                {problems.map((p) => (
                  <tr key={`${p.packageId}${p.reason}`} data-problem={p.packageId}>
                    <td className="pr-4 font-mono">{p.packageId}</td>
                    <td className="pr-4">{p.source}</td>
                    <td className="pr-4">{p.reason}</td>
                    <td className="font-mono">{formatDate(p.at)} {new Date(p.at).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></Window>
        </section>
      )}
    </Screen>
  );
}
