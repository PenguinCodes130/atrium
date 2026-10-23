// Server loading for the builder routes (/build/<slug>/...): editors only; everyone else gets the
// not-found room, so a builder address never reveals that an app exists (criteria 6 and 32).
import "server-only";
import { notFound } from "next/navigation";
import type { App, Principal } from "@/core/contracts";
import { requireUser } from "@/features/auth";
import { canEdit, canOpen } from "./access";
import { insertCatalogue } from "./deps";
import { pageBySlug } from "./doc";
import { renderPage } from "./load";
import { registerAppBuilder } from "./register";
import * as repo from "./repo";
import { agentNodeIds, describeChanges } from "@/features/versions/service";

export async function editorFor(slug: string): Promise<{ app: App; principal: Extract<Principal, { kind: "user" }>; userName: string }> {
  registerAppBuilder();
  const { principal, user } = await requireUser();
  const app = /^[a-z0-9-]{1,40}$/.test(slug) ? repo.getAppBySlug(slug) : null;
  if (!app || !canOpen(app, principal) || !canEdit(app, principal)) notFound();
  return { app, principal, userName: user.name };
}

export async function loadBuilder(slug: string, pageSlug?: string) {
  const { app, principal } = await editorFor(slug);
  const draft = repo.getDraft(app.id);
  if (!draft) notFound();
  const page = pageBySlug(draft.doc, pageSlug);
  if (!page) notFound();
  const r = await renderPage(app, draft.doc, page, "editor", { connectLinks: true });
  const { authors } = describeChanges(repo.pendingChanges(app.id));
  let catalogue: unknown[] = [];
  try {
    catalogue = insertCatalogue(principal) as unknown[];
  } catch {
    catalogue = [];
  }
  return {
    app: { id: app.id, slug: app.slug, name: app.name, publishedVersion: app.publishedVersion ?? null },
    principal,
    initial: { rev: draft.rev, doc: draft.doc, agentNodes: agentNodeIds(app.id), pending: authors.reduce((n, a) => n + a.count, 0), authors },
    pageId: page.id,
    render: { theme: r.theme, canvasCss: r.canvasCss, chromeCss: r.chromeCss, chromeRemoved: r.chromeRemoved, nodeCss: r.nodeCss, sources: r.sources, unmapped: r.unmapped, library: r.library, signedUrls: r.signedUrls },
    catalogue,
  };
}
