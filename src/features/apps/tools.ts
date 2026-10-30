// app-builder's agent tools (architecture v3 section 9b.1). Every edit tool changes only the draft
// through applyDraftOps, takes an optional expected revision and answers { rev, changed }, or fails with
// a conflict (current rev) or a plain-English problem list. No tool publishes, restores, runs a control,
// changes access, deletes an app or touches guest links.
import "server-only";
import { z } from "zod";
import type { AppDocument, ControlDef, DataSourceDef, DraftOp, PageDoc, Principal, Problem, ToolDef } from "@/core/contracts";
import { NotFound } from "@/core/errors";
import { canEdit } from "./access";
import { buildAppFile, importAppFile, parseAppFile } from "./appfile";
import { validateDocument, guestWarnings } from "./checks";
import { emptyPage, newId, slugify } from "./doc";
import * as repo from "./repo";
import { appForEditor, appForViewer, appsFor, applyDraftOps, createApp } from "./service";
import { TEMPLATES, isTemplateId } from "./templates";
import { readableDocument } from "./view";
import { describeChanges } from "@/features/versions/service";
import { diffDocuments, readableDiff } from "@/features/versions/diff";
import { bindDataOps } from "./bind-data";
import { makeStartPage, parseStartInput } from "./start-page-server";

type Ctx = { principal: Principal; signal: AbortSignal };
const editOut = z.object({ rev: z.number(), changed: z.array(z.string()) });
const appRef = { appId: z.string().min(1).max(100).describe("The app's id (from apps.list).") };
const expectRev = { expectRev: z.number().int().optional().describe("The draft revision you last read. A stale revision fails with conflict and the current rev.") };

function tool<I, O>(t: ToolDef<I, O>): ToolDef<I, O> {
  return t;
}

function edit(p: Principal, appId: string, ops: DraftOp[], rev?: number) {
  const r = applyDraftOps({ appId, ops, by: p, ...(rev !== undefined ? { expectRev: rev } : {}) });
  return { rev: r.rev, changed: r.changed };
}

function resolveApp(p: Principal, appId: string) {
  return appForViewer(p, appId);
}

export const appTools: ToolDef<never, unknown>[] = [
  tool({
    name: "apps.list",
    title: "List apps",
    description: "Every app you can open: id, slug, name, published version and draft revision.",
    input: z.object({}),
    output: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), publishedVersion: z.number().nullable(), draftRev: z.number(), canEdit: z.boolean() })),
    scope: "atrium:read",
    effect: "none",
    surfaces: ["palette", "builtin-agent", "mcp"],
    minRole: "viewer",
    async handler({ principal }) {
      return appsFor(principal).map((a) => ({ id: a.id, slug: a.slug, name: a.name, publishedVersion: a.publishedVersion ?? null, draftRev: a.draftRev, canEdit: canEdit(a, principal) }));
    },
  }),
  tool({
    name: "apps.get",
    title: "Get an app",
    description: "An app's document: the draft (with rev) when you can edit it and ask for it, otherwise the published version.",
    input: z.object({ ...appRef, draft: z.boolean().optional().describe("true for the draft (editors only).") }),
    output: z.object({ appId: z.string(), source: z.string(), rev: z.number().optional(), version: z.number().optional(), doc: z.unknown() }),
    scope: "atrium:read",
    effect: "none",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "viewer",
    async handler({ principal }, input) {
      const app = resolveApp(principal, input.appId);
      if ((input.draft || app.publishedVersion == null) && canEdit(app, principal)) {
        const d = repo.getDraft(app.id)!;
        return { appId: app.id, source: "draft", rev: d.rev, doc: d.doc };
      }
      if (app.publishedVersion == null) throw new NotFound("This app has no published version yet.");
      return { appId: app.id, source: "published", version: app.publishedVersion, doc: readableDocument(app, principal, repo.getVersion(app.id, app.publishedVersion)!.doc) };
    },
  }),
  tool({
    name: "apps.templates",
    title: "App templates",
    description: "The built-in app templates and the integrations each one maps.",
    input: z.object({}),
    output: z.array(z.unknown()),
    scope: "atrium:read",
    effect: "none",
    surfaces: ["palette", "builtin-agent", "mcp"],
    minRole: "viewer",
    async handler() {
      return TEMPLATES;
    },
  }),
  tool({
    name: "apps.create",
    title: "Create an app",
    description: "Creates an app with a draft only (nothing published). Optional template; map each template integration to one of the user's integration ids or null to skip.",
    input: z.object({ name: z.string().min(1).max(80), slug: z.string().max(40).optional(), template: z.string().optional(), mappings: z.record(z.string(), z.string().nullable()).optional() }),
    output: z.object({ appId: z.string(), slug: z.string(), rev: z.number() }),
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      const template = input.template && isTemplateId(input.template) ? input.template : undefined;
      const { app, rev } = createApp(principal, { name: input.name, slug: input.slug ?? slugify(input.name), ...(template ? { template } : {}), ...(input.mappings ? { mappings: input.mappings } : {}) });
      return { appId: app.id, slug: app.slug, rev };
    },
  }),
  tool({
    name: "apps.update",
    title: "Update an app",
    description: "Changes the draft's app name, icon, home page or page order.",
    input: z.object({ ...appRef, ...expectRev, name: z.string().min(1).max(80).optional(), icon: z.string().max(200).optional(), homePage: z.string().optional(), pageOrder: z.array(z.string()).optional() }),
    output: editOut,
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      const { appId, expectRev: rev, ...patch } = input;
      return edit(principal, appId, [{ op: "app.update", patch }], rev);
    },
  }),
  tool({
    name: "pages.add",
    title: "Add a page",
    description: "Adds an empty page (a grid) to the draft.",
    input: z.object({ ...appRef, ...expectRev, title: z.string().min(1).max(80), slug: z.string().max(40).optional(), inNav: z.boolean().optional(), index: z.number().int().optional() }),
    output: editOut,
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      const page = emptyPage(input.title, input.slug ?? (slugify(input.title) || "page"));
      if (input.inNav === false) page.inNav = false;
      return edit(principal, input.appId, [{ op: "page.add", page, ...(input.index !== undefined ? { index: input.index } : {}) }], input.expectRev);
    },
  }),
  tool({
    name: "pages.update",
    title: "Update a page",
    description: "Changes a draft page's title, slug, icon, nav visibility or theme.",
    input: z.object({ ...appRef, ...expectRev, pageId: z.string(), patch: z.record(z.string(), z.unknown()) }),
    output: editOut,
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      return edit(principal, input.appId, [{ op: "page.update", pageId: input.pageId, patch: input.patch as Partial<PageDoc> }], input.expectRev);
    },
  }),
  tool({
    name: "pages.remove",
    title: "Remove a page",
    description: "Removes a page from the draft.",
    input: z.object({ ...appRef, ...expectRev, pageId: z.string() }),
    output: editOut,
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      return edit(principal, input.appId, [{ op: "page.remove", pageId: input.pageId }], input.expectRev);
    },
  }),
  tool({
    name: "pages.move",
    title: "Move a page",
    description: "Moves a page to a new position in the draft's page order.",
    input: z.object({ ...appRef, ...expectRev, pageId: z.string(), index: z.number().int().min(0) }),
    output: editOut,
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      return edit(principal, input.appId, [{ op: "page.move", pageId: input.pageId, index: input.index }], input.expectRev);
    },
  }),
  tool({
    name: "drafts.apply",
    title: "Apply draft operations",
    description: "Applies a raw batch of draft operations, all or nothing (page.*, node.*, source.*, control.*, app.update, theme.set, chrome.update).",
    input: z.object({ ...appRef, ...expectRev, ops: z.array(z.record(z.string(), z.unknown())).min(1).max(200) }),
    output: editOut,
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      return edit(principal, input.appId, input.ops as unknown as DraftOp[], input.expectRev);
    },
  }),
  tool({
    name: "drafts.changes",
    title: "Draft changes",
    description: "The changes since the last publish, with who made them (agents named).",
    input: z.object(appRef),
    output: z.unknown(),
    scope: "atrium:read",
    effect: "none",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      const app = appForEditor(principal, input.appId);
      return describeChanges(repo.pendingChanges(app.id));
    },
  }),
  tool({
    name: "versions.list",
    title: "List versions",
    description: "Every published version: number, who, when, note and source.",
    input: z.object(appRef),
    output: z.array(z.unknown()),
    scope: "atrium:read",
    effect: "none",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "viewer",
    async handler({ principal }, input) {
      const app = appForViewer(principal, input.appId);
      return repo.listVersions(app.id).map((v) => ({ version: v.version, by: v.publishedByName, at: v.publishedAt, note: v.note ?? null, source: v.source, restoredFrom: v.restoredFrom ?? null, live: v.version === app.publishedVersion }));
    },
  }),
  tool({
    name: "versions.get",
    title: "Get a version",
    description: "One published version's document.",
    input: z.object({ ...appRef, version: z.number().int().min(1) }),
    output: z.unknown(),
    scope: "atrium:read",
    effect: "none",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "viewer",
    async handler({ principal }, input) {
      const app = appForViewer(principal, input.appId);
      const v = repo.getVersion(app.id, input.version);
      if (!v) throw new NotFound(`Version ${input.version} does not exist.`);
      return { version: v.version, doc: readableDocument(app, principal, v.doc) };
    },
  }),
  tool({
    name: "versions.diff",
    title: "Diff versions",
    description: "The structural diff and readable lines between two versions, or a version and the draft (to: \"draft\").",
    input: z.object({ ...appRef, from: z.number().int().min(0).describe("0 for nothing published"), to: z.union([z.number().int().min(1), z.literal("draft")]) }),
    output: z.unknown(),
    scope: "atrium:read",
    effect: "none",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      const app = appForEditor(principal, input.appId);
      const a = input.from === 0 ? null : repo.getVersion(app.id, input.from)?.doc ?? null;
      const b = input.to === "draft" ? repo.getDraft(app.id)!.doc : repo.getVersion(app.id, input.to)?.doc;
      if (!b || (input.from !== 0 && !a)) throw new NotFound("That version does not exist.");
      return { diff: diffDocuments(a, b), lines: readableDiff(a, b) };
    },
  }),
  tool({
    name: "app_files.export",
    title: "Export an app file",
    description: "The Atrium app file tree as JSON (app.json, theme.json, data.json, controls.json, pages/*.json). No secrets, user ids or access settings.",
    input: z.object({ ...appRef, draft: z.boolean().optional() }),
    output: z.unknown(),
    scope: "atrium:read",
    effect: "none",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "viewer",
    async handler({ principal }, input) {
      const app = appForViewer(principal, input.appId);
      const doc = input.draft && canEdit(app, principal) ? repo.getDraft(app.id)!.doc : app.publishedVersion != null ? repo.getVersion(app.id, app.publishedVersion)!.doc : null;
      if (!doc) throw new NotFound("This app has nothing published to export yet.");
      return (await buildAppFile(readableDocument(app, principal, doc), app.slug)).json;
    },
  }),
  tool({
    name: "app_files.import",
    title: "Import an app file",
    description: "Creates a new app with a draft only from an app file tree. Map each named integration (key packageId::name) to one of the user's integration ids, or null to skip.",
    input: z.object({ files: z.record(z.string(), z.unknown()), name: z.string().max(80).optional(), mappings: z.record(z.string(), z.string().nullable()).optional() }),
    output: z.object({ appId: z.string(), slug: z.string(), rev: z.number(), skipped: z.array(z.string()) }),
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      const parsed = parseAppFile(input.files, "The app file");
      const r = importAppFile(principal, parsed, { ...(input.name ? { name: input.name } : {}), mappings: input.mappings ?? {} });
      return { appId: r.app.id, slug: r.app.slug, rev: r.rev, skipped: r.skipped };
    },
  }),
  tool({
    name: "validate",
    title: "Validate an app",
    description: "Checks the draft (or one page): schemas, bindings, grid, controls, targets, contrast. Publishing blocks on errors.",
    input: z.object({ ...appRef, pageId: z.string().optional() }),
    output: z.object({ ok: z.boolean(), problems: z.array(z.unknown()) }),
    scope: "atrium:read",
    effect: "none",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      const app = appForEditor(principal, input.appId);
      const doc: AppDocument = repo.getDraft(app.id)!.doc;
      let problems: Problem[] = [...validateDocument(doc, principal), ...guestWarnings(doc, app.access.guests)];
      if (input.pageId) problems = problems.filter((x) => !x.where.pageId || x.where.pageId === input.pageId);
      return { ok: !problems.some((x) => x.severity === "error"), problems };
    },
  }),
  tool({
    name: "data_sources.set",
    title: "Set a data source",
    description: "Adds or replaces a draft data source (name, integration, endpoint, params, refresh interval no lower than the endpoint's minimum).",
    input: z.object({ ...appRef, ...expectRev, source: z.object({ name: z.string(), integrationId: z.string(), endpointId: z.string(), params: z.record(z.string(), z.unknown()).optional(), refreshSec: z.number() }) }),
    output: editOut,
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      return edit(principal, input.appId, [{ op: "source.set", source: input.source as DataSourceDef }], input.expectRev);
    },
  }),
  tool({
    name: "data_sources.remove",
    title: "Remove a data source",
    description: "Removes a draft data source by name.",
    input: z.object({ ...appRef, ...expectRev, name: z.string() }),
    output: editOut,
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      return edit(principal, input.appId, [{ op: "source.remove", name: input.name }], input.expectRev);
    },
  }),
  tool({
    name: "controls.set",
    title: "Set a control",
    description: "Adds or replaces a draft control (label, command or workflow, params, confirm text, cooldown of at least 250 ms). Target fields must be fixed values from the target list. Never runs it.",
    input: z.object({ ...appRef, ...expectRev, control: z.object({ id: z.string().optional(), label: z.string(), run: z.record(z.string(), z.unknown()), confirm: z.string().optional(), cooldownMs: z.number().optional() }) }),
    output: editOut,
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      const control = { ...input.control, id: input.control.id ?? newId("k") } as ControlDef;
      return edit(principal, input.appId, [{ op: "control.set", control }], input.expectRev);
    },
  }),
  tool({
    name: "controls.remove",
    title: "Remove a control",
    description: "Removes a draft control.",
    input: z.object({ ...appRef, ...expectRev, controlId: z.string() }),
    output: editOut,
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      return edit(principal, input.appId, [{ op: "control.remove", controlId: input.controlId }], input.expectRev);
    },
  }),
  // ---- Wave 2.9, direct data (A10.8): a catalogue pick and a start page, as the builder makes them ----
  tool({
    name: "apps.bindData",
    title: "Show data on a component",
    description: "Binds one prop of a draft component to a read from data.search (its item key), creating or reusing the app's hidden managed data source for that read, as the builder's picker does. prop is a prop name (data, value, status, items) or a path into a list prop (stats.0.value, items.2.value, lines.1.data); prop \"lines\" adds a chart line (a value read binds its history). value is an optional template body against the read, like value or rows | filter('state', 'running') | count. refreshSec optionally sets the component's own refresh (at or above the read's minimum, or 0 for Off: read once per page open). Answers no config or secrets.",
    input: z.object({ ...appRef, ...expectRev, nodeId: z.string().min(1).max(40), prop: z.string().min(1).max(60), itemKey: z.string().min(3).max(2000).describe("A key from data.search."), value: z.string().max(400).optional(), refreshSec: z.number().int().min(0).max(86400).optional() }),
    output: z.object({ rev: z.number(), changed: z.array(z.string()), source: z.string(), template: z.string(), words: z.string() }),
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      const app = appForEditor(principal, input.appId);
      const d = repo.getDraft(app.id)!;
      const b = await bindDataOps(principal, d.doc, input);
      const r = edit(principal, app.id, b.ops, input.expectRev);
      return { ...r, source: b.name, template: b.template, words: b.words };
    },
  }),
  tool({
    name: "apps.startPage",
    title: "Make a start page",
    description: "Makes a start page in the draft in one change: a resource bar (a machine's CPU, memory, disk and uptime, or this Atrium server's), then a group per kind of service (containers, media, monitoring, network, smart home, storage, other) with a service tile per integration (icon, name, address, live status, headline stats), then a Links group of plain links with an up or down check. Uses the current empty page, or adds a Start page. Only services you may use are placed.",
    input: z.object({ ...appRef, ...expectRev, integrationIds: z.array(z.string().max(100)).max(40), links: z.array(z.object({ name: z.string().max(80), href: z.string().max(2000) })).max(40).optional(), machine: z.object({ integrationId: z.string(), thing: z.string().max(400), label: z.string().max(80).optional() }).optional() }),
    output: z.object({ rev: z.number(), pageId: z.string(), nodes: z.array(z.string()) }),
    scope: "atrium:edit",
    effect: "draft",
    surfaces: ["builtin-agent", "mcp"],
    minRole: "member",
    async handler({ principal }, input) {
      const r = makeStartPage(principal, input.appId, parseStartInput({ integrationIds: input.integrationIds, links: input.links ?? [], ...(input.machine ? { machine: input.machine } : {}) }), input.expectRev !== undefined ? { expectRev: input.expectRev } : {});
      return { rev: r.rev!, pageId: r.pageId, nodes: r.nodes };
    },
  }),
] as unknown as ToolDef<never, unknown>[];

export type { Ctx };
