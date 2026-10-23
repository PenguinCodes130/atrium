// The Atrium app file (architecture v3 section 4.10): export as `<slug>.atrium-app.zip`, import as a new
// app with a draft only. JSON is written with sorted keys and 2-space indentation. The file never holds
// secrets, integration config, user ids, access settings or guest links.
import "server-only";
import type { App, AppDocument, ComponentNode, ControlDef, DataSourceDef, LibraryComponent, PageDoc, Principal, ThemeRef } from "@/core/contracts";
import { Forbidden } from "@/core/errors";
import { audit } from "@/features/audit/write";
import { canBindCommands, canBindReads } from "@/features/integrations/commands";
import { getIntegrationRow, listIntegrationRows } from "@/features/integrations/repo";
import { canCreate, canEdit } from "./access";
import { getLibrary, importLibrary, libraryForDoc, parseComponentFile, readUpload, saveUpload, snapshotTheme, toComponentFile } from "./deps";
import { allNodes, clone, isBinding, rekeyDocument, slugProblem, slugify, stableJson, unmappedIntegrationId, walk } from "./doc";
import { FieldError } from "./errors";
import * as repo from "./repo";
import { appForViewer, createApp } from "./service";
import { readableDocument } from "./view";
import { readZip, writeZip, ZipError, type ZipEntry } from "./zip";

export const ATRIUM_VERSION = "0.1.0";
const BUILT_IN_THEME_IDS = new Set(["control-room", "dusk", "solid", "daylight"]);
const UPLOAD_REF = /\/uploads\/([a-z0-9]{20}\.(?:png|jpg|gif|webp|avif|svg|mp4|webm))/g;

export type IntegrationRef = { packageId: string; name: string };
export type FileSource = Omit<DataSourceDef, "integrationId"> & { integration: IntegrationRef };
export type FileControl = Omit<ControlDef, "run"> & { run: Exclude<ControlDef["run"], { kind: "command" }> | { kind: "command"; integration: IntegrationRef; commandId: string; params?: Record<string, unknown> } };
export type AppFileTree = Record<string, unknown>;

function refOf(integrationId: string): IntegrationRef {
  const row = getIntegrationRow(integrationId);
  return row ? { packageId: row.packageId, name: row.name } : { packageId: "unknown", name: "Missing integration" };
}

async function themeForFile(ref: ThemeRef): Promise<ThemeRef> {
  if ("themeId" in ref && BUILT_IN_THEME_IDS.has(ref.themeId)) return ref;
  if ("inline" in ref) return ref;
  return { inline: await snapshotTheme(ref) };
}

function uploadsIn(doc: AppDocument): string[] {
  const found = new Set<string>();
  for (const m of JSON.stringify(doc).matchAll(UPLOAD_REF)) found.add(m[1]!);
  return [...found].sort();
}

/** The app file tree as path to JSON value (app_files.export) plus the asset files. */
export async function buildAppFile(doc: AppDocument, slug: string): Promise<{ json: Record<string, unknown>; assets: ZipEntry[]; library: string[] }> {
  const d = clone(doc);
  const json: Record<string, unknown> = {};
  json["app.json"] = { format: "atrium-app", formatVersion: 1, atriumVersion: ATRIUM_VERSION, slug, app: d.app, chrome: d.chrome };
  json["theme.json"] = await themeForFile(d.theme);
  json["data.json"] = d.dataSources.map(({ integrationId, ...s }): FileSource => ({ ...s, integration: refOf(integrationId) }));
  json["controls.json"] = d.controls.map((c): FileControl => {
    if (c.run.kind !== "command") return c as FileControl;
    const { integrationId, ...run } = c.run;
    return { ...c, run: { ...run, integration: refOf(integrationId) } } as FileControl;
  });
  const library = new Set<string>();
  for (const page of d.pages) {
    const p: PageDoc = { ...page, ...(page.theme ? { theme: await themeForFile(page.theme) } : {}) };
    json[`pages/${page.slug}.json`] = p;
  }
  for (const l of allNodes(d)) if (l.node.libraryRef) library.add(`${l.node.libraryRef.componentId}@${l.node.libraryRef.version}`);
  // Every used library component ships at its pinned version (gauntlet w2-r1 item 3), as the library's own
  // component file format, so a second instance can import it.
  let pinned: Record<string, LibraryComponent> = {};
  try {
    pinned = libraryForDoc(d);
  } catch {
    pinned = {};
  }
  for (const key of [...library].sort()) {
    const c = pinned[key];
    if (c) json[`library/${key}.json`] = JSON.parse(toComponentFile(c)) as unknown;
  }
  const assets: ZipEntry[] = [];
  for (const file of uploadsIn(d)) {
    const stored = readUpload(file);
    if (stored && (stored.kind === "image" || stored.kind === "video")) assets.push({ path: `assets/${file}`, data: stored.bytes });
  }
  return { json, assets, library: [...library].sort() };
}

/** Export (anyone who can open the app): editors may export the draft; everyone else the published version. */
export async function exportAppFile(p: Principal, appId: string, opts: { draft?: boolean } = {}): Promise<{ filename: string; bytes: Buffer; tree: Record<string, unknown>; app: App }> {
  const app = appForViewer(p, appId);
  if (p.kind === "guest") throw new Forbidden("Guests cannot export apps.");
  const wantDraft = (opts.draft || app.publishedVersion == null) && canEdit(app, p);
  let doc: AppDocument | null = null;
  if (wantDraft) doc = repo.getDraft(app.id)?.doc ?? null;
  else if (app.publishedVersion != null) doc = repo.getVersion(app.id, app.publishedVersion)?.doc ?? null;
  if (!doc) throw new Forbidden("This app has nothing published to export yet.");
  // Non-editors export what the viewer page shows them: no control run details or source definitions.
  doc = readableDocument(app, p, doc);
  const { json, assets } = await buildAppFile(doc, app.slug);
  const entries: ZipEntry[] = Object.keys(json)
    .sort()
    .map((path) => ({ path, data: Buffer.from(stableJson(json[path]), "utf8") }));
  const bytes = writeZip([...entries, ...assets]);
  audit.write({ actor: p, event: "app.exported", target: { type: "app", id: app.id, label: app.name }, result: "ok", detail: { from: wantDraft ? "draft" : `v${app.publishedVersion}`, files: entries.length + assets.length } });
  return { filename: `${app.slug}.atrium-app.zip`, bytes, tree: json, app };
}

// ---- Import ----

export class AppFileRefused extends FieldError {
  constructor(file: string, problem: string) {
    super("file", `${file} could not be imported: ${problem}.`, 400);
  }
}

type LibraryFile = Extract<ReturnType<typeof parseComponentFile>, { ok: true }>["file"];
export type ParsedAppFile = {
  doc: AppDocument;
  slug: string;
  integrations: (IntegrationRef & { key: string; used: { sources: string[]; controls: string[] } })[];
  assets: ZipEntry[];
  /** `id@version` of every library component the pages pin. */
  library: string[];
  /** The library components the file ships (`library/<id>@<version>.json`). */
  libraryFiles: LibraryFile[];
  /** Whether any shipped library component contains code (the import sheet shows the notice). */
  containsCode: boolean;
};

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function refKey(r: IntegrationRef): string {
  return `${r.packageId}::${r.name}`;
}

/** Parses and checks an app file (zip bytes or the JSON tree from app_files.export). Throws AppFileRefused. */
export function parseAppFile(input: Buffer | Record<string, unknown>, filename = "The file"): ParsedAppFile {
  let files: Record<string, unknown> = {};
  const assets: ZipEntry[] = [];
  if (Buffer.isBuffer(input)) {
    let entries: ZipEntry[];
    try {
      entries = readZip(input);
    } catch (err) {
      throw new AppFileRefused(filename, err instanceof ZipError ? err.message : "it is not an Atrium app file");
    }
    for (const e of entries) {
      if (e.path.startsWith("assets/")) assets.push(e);
      else if (e.path.endsWith(".json")) {
        try {
          files[e.path] = JSON.parse(Buffer.from(e.data).toString("utf8"));
        } catch {
          throw new AppFileRefused(filename, `${e.path} is not valid JSON`);
        }
      }
    }
  } else files = input;
  const appJson = obj(files["app.json"]);
  if (!appJson || appJson.format !== "atrium-app") throw new AppFileRefused(filename, "app.json is missing or is not an Atrium app");
  if (appJson.formatVersion !== 1) throw new AppFileRefused(filename, `format version ${String(appJson.formatVersion)} is not supported`);
  const app = obj(appJson.app);
  const chrome = obj(appJson.chrome) ?? { layout: "topbar" };
  if (!app || typeof app.name !== "string" || !Array.isArray(app.pageOrder)) throw new AppFileRefused(filename, "app.json has no app name or page order");
  const theme = obj(files["theme.json"]) ?? { themeId: "control-room" };
  const data = Array.isArray(files["data.json"]) ? (files["data.json"] as unknown[]) : [];
  const controls = Array.isArray(files["controls.json"]) ? (files["controls.json"] as unknown[]) : [];
  const pages: PageDoc[] = [];
  for (const [path, v] of Object.entries(files)) {
    if (!path.startsWith("pages/")) continue;
    const page = obj(v);
    if (!page || typeof page.id !== "string" || typeof page.slug !== "string" || !obj(page.root)) throw new AppFileRefused(filename, `${path} is not a page`);
    pages.push(page as unknown as PageDoc);
  }
  if (pages.length === 0) throw new AppFileRefused(filename, "it has no pages");
  const libraryFiles: LibraryFile[] = [];
  for (const [path, v] of Object.entries(files)) {
    if (!path.startsWith("library/")) continue;
    const parsed = parseComponentFile(JSON.stringify(v));
    if (!parsed.ok) throw new AppFileRefused(filename, `${path} is not a library component (${parsed.problem.replace(/\.$/, "")})`);
    libraryFiles.push(parsed.file);
  }
  const integrations = new Map<string, ParsedAppFile["integrations"][number]>();
  const use = (r: unknown, kind: "sources" | "controls", what: string): string => {
    const ref = obj(r);
    if (!ref || typeof ref.packageId !== "string" || typeof ref.name !== "string") throw new AppFileRefused(filename, `${kind === "sources" ? "data.json" : "controls.json"} names an integration without a package and name`);
    const key = refKey({ packageId: ref.packageId, name: ref.name });
    const entry = integrations.get(key) ?? { key, packageId: ref.packageId, name: ref.name, used: { sources: [], controls: [] } };
    entry.used[kind].push(what);
    integrations.set(key, entry);
    return `$ref:${key}`;
  };
  const dataSources: DataSourceDef[] = data.map((raw) => {
    const s = obj(raw);
    if (!s || typeof s.name !== "string") throw new AppFileRefused(filename, "data.json has a data source without a name");
    const { integration, ...rest } = s;
    return { ...(rest as unknown as Omit<DataSourceDef, "integrationId">), integrationId: use(integration, "sources", s.name) };
  });
  const ctrls: ControlDef[] = controls.map((raw) => {
    const c = obj(raw);
    const run = obj(c?.run);
    if (!c || typeof c.id !== "string" || !run) throw new AppFileRefused(filename, "controls.json has a control without an id or run");
    if (run.kind === "command") {
      const { integration, ...r } = run;
      return { ...(c as unknown as ControlDef), run: { ...(r as unknown as Omit<Extract<ControlDef["run"], { kind: "command" }>, "integrationId">), integrationId: use(integration, "controls", String(c.label ?? c.id)) } };
    }
    return c as unknown as ControlDef;
  });
  const doc: AppDocument = {
    format: "atrium-app",
    formatVersion: 1,
    app: { name: app.name, ...(typeof app.icon === "string" ? { icon: app.icon } : {}), homePage: String(app.homePage ?? pages[0]!.id), pageOrder: (app.pageOrder as unknown[]).map(String) },
    theme: theme as ThemeRef,
    chrome: chrome as unknown as AppDocument["chrome"],
    dataSources,
    controls: ctrls,
    pages,
  };
  const library: string[] = [];
  for (const l of allNodes(doc)) if (l.node.libraryRef) library.push(`${l.node.libraryRef.componentId}@${l.node.libraryRef.version}`);
  const slug = typeof appJson.slug === "string" ? appJson.slug : slugify(app.name);
  return { doc, slug, integrations: [...integrations.values()], assets, library, libraryFiles, containsCode: libraryFiles.some((f) => f.containsCode) };
}

export type LibraryOutcome = "reused" | "imported" | "restored";

/**
 * What import does with each library component the file ships: reuse an identical, live one here;
 * import it; or, when the one here with that id was deleted (gauntlet w2-r2 item 14), import a visible
 * copy instead of relinking the hidden one ("restored"). A deleted component never counts as a match.
 */
export function planLibrary(p: Principal, files: LibraryFile[]): { file: LibraryFile; outcome: LibraryOutcome; localId?: string }[] {
  const out: { file: LibraryFile; outcome: LibraryOutcome; localId?: string }[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const probe: ComponentNode = { id: "c_probeaaaaa", type: `lib:${f.id}`, props: {}, libraryRef: { componentId: f.id, version: f.version } };
    let here: LibraryComponent | undefined;
    try {
      here = libraryForDoc({ format: "atrium-app", formatVersion: 1, app: { name: "probe", homePage: "p_probeaaaaa", pageOrder: ["p_probeaaaaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" }, dataSources: [], controls: [], pages: [{ id: "p_probeaaaaa", slug: "probe", title: "probe", inNav: false, root: { id: "c_proberoota", type: "grid", props: {}, children: [probe] } }] })[`${f.id}@${f.version}`];
    } catch {
      here = undefined;
    }
    let deleted = false;
    if (here) {
      try {
        deleted = getLibrary(p, here.id).deleted;
      } catch {
        deleted = true; // not readable here: never relink to it
      }
    }
    const same = !!here && JSON.stringify(here.node) === JSON.stringify(f.node) && JSON.stringify(here.params) === JSON.stringify(f.params);
    if (here && same && !deleted) out.push({ file: f, outcome: "reused", localId: here.id });
    else out.push({ file: f, outcome: here && deleted ? "restored" : "imported" });
  }
  return out;
}

/**
 * Brings the file's library components onto this instance (gauntlet w2-r1 item 3, w2-r2 item 14): see
 * `planLibrary`. Returns the old to local id map, and how many were imported, reused and restored.
 */
function bringLibrary(p: Principal, files: LibraryFile[]): { ids: Map<string, string>; imported: number; reused: number; restored: number; names: { name: string; outcome: LibraryOutcome }[] } {
  const ids = new Map<string, string>();
  let imported = 0;
  let reused = 0;
  let restored = 0;
  const names: { name: string; outcome: LibraryOutcome }[] = [];
  for (const step of planLibrary(p, files)) {
    const f = step.file;
    if (step.outcome === "reused" && step.localId) {
      ids.set(f.id, step.localId);
      reused++;
      names.push({ name: f.name, outcome: "reused" });
      continue;
    }
    // A deleted component keeps its id, so the copy gets a new one and shows in the library again.
    const c = importLibrary(p, f);
    ids.set(f.id, c.id);
    if (step.outcome === "restored") restored++;
    else imported++;
    names.push({ name: c.name, outcome: step.outcome });
  }
  return { ids, imported, reused, restored, names };
}

/** Points every library instance in a document at the local component ids. */
function relinkLibrary(doc: AppDocument, ids: Map<string, string>): void {
  for (const page of doc.pages)
    for (const l of walk(page)) {
      const ref = l.node.libraryRef;
      const local = ref ? ids.get(ref.componentId) : undefined;
      if (!ref || !local || local === ref.componentId) continue;
      l.node.libraryRef = { ...ref, componentId: local };
      if (l.node.type === `lib:${ref.componentId}`) l.node.type = `lib:${local}` as ComponentNode["type"];
    }
}

/** What the import sheet asks: each named integration, with the user's integrations of that package. */
export function importMappingOptions(p: Principal, parsed: ParsedAppFile) {
  const rows = listIntegrationRows().filter((r) => r.status === "active" && canBindReads(p, r));
  return parsed.integrations.map((i) => ({ key: i.key, packageId: i.packageId, name: i.name, used: i.used, options: rows.filter((r) => r.packageId === i.packageId).map((r) => ({ id: r.id, name: r.name })) }));
}

export type ImportInput = { name?: string; slug?: string; mappings: Record<string, string | null> };

/** Import (owners and members): a new app with a draft only. Nothing is created when any check fails. */
export function importAppFile(p: Principal, parsed: ParsedAppFile, input: ImportInput): { app: App; rev: number; skipped: string[]; library: { imported: number; reused: number; restored: number; names: { name: string; outcome: LibraryOutcome }[] } } {
  if (!canCreate(p)) throw new Forbidden("Only owners and members can import apps.");
  const doc = rekeyDocument(parsed.doc);
  const skipped: string[] = [];
  const mapped = new Map<string, { id: string; commands: boolean } | null>();
  const packages = new Map<string, string>();
  for (const i of parsed.integrations) {
    packages.set(`$ref:${i.key}`, i.packageId);
    const chosen = input.mappings?.[i.key];
    const row = typeof chosen === "string" ? getIntegrationRow(chosen) : undefined;
    const ok = row && row.packageId === i.packageId && canBindReads(p, row);
    mapped.set(`$ref:${i.key}`, ok ? { id: row.id, commands: canBindCommands(p, row) } : null);
    if (!ok) skipped.push(i.name);
  }
  // A skipped integration's sources stay as unmapped placeholders: components show "No data: connect ...".
  doc.dataSources = doc.dataSources.map((s) => {
    const m = mapped.get(s.integrationId);
    return m ? { ...s, integrationId: m.id } : { ...s, integrationId: unmappedIntegrationId(packages.get(s.integrationId) ?? "unknown") };
  });
  const droppedControls = new Set<string>();
  doc.controls = doc.controls.flatMap((c) => {
    if (c.run.kind !== "command") return [c];
    const m = mapped.get(c.run.integrationId);
    if (!m || !m.commands) {
      droppedControls.add(c.id);
      return [];
    }
    return [{ ...c, run: { ...c.run, integrationId: m.id } }];
  });
  for (const l of allNodes(doc)) {
    if (typeof l.node.props.control === "string" && droppedControls.has(l.node.props.control)) delete l.node.props.control;
    if (Array.isArray(l.node.props.controls)) l.node.props.controls = l.node.props.controls.filter((x) => typeof x !== "string" || !droppedControls.has(x));
  }
  // Assets go through the upload sanitiser; references are rewritten to the stored copies.
  let json = JSON.stringify(doc);
  for (const a of parsed.assets) {
    const file = a.path.slice("assets/".length);
    try {
      const stored = saveUpload(p, Buffer.from(a.data), file, "media");
      json = json.split(`/uploads/${file}`).join(stored.path);
    } catch {
      json = json.split(`/uploads/${file}`).join("");
    }
  }
  const finalDoc = JSON.parse(json) as AppDocument;
  const lib = bringLibrary(p, parsed.libraryFiles);
  relinkLibrary(finalDoc, lib.ids);
  // Bindings stay as written; values the importer could not map show "No data".
  void isBinding;
  const name = (input.name ?? parsed.doc.app.name).trim();
  let slug = input.slug ?? parsed.slug;
  if (!input.slug && (slugProblem(slug) || repo.slugExists(slug))) {
    const base = slugify(name) || "app";
    slug = base;
    for (let n = 2; repo.slugExists(slug); n++) slug = `${base.slice(0, 36)}-${n}`;
  }
  const { app, rev } = createApp(p, { name, slug }, { doc: finalDoc, fromImport: true, event: "app.imported" });
  return { app, rev, skipped, library: { imported: lib.imported, reused: lib.reused, restored: lib.restored, names: lib.names } };
}
