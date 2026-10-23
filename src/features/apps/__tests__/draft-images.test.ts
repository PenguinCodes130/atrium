// Amendment A5.1 (operator approved 2026-10-19): a draft's literal external image URLs are signed for
// someone who may edit the app (builder canvas, ?draft=1 preview, /api/apps/<id>/render); viewers and
// guests stay as A4.2 left them (only the published document is signed). Template URLs are never signed.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { App, ComponentNode } from "@/core/contracts";
import { editor, guestOf, owner, seedUsers, setupAppsDb, watcher } from "./harness";

const fakeSign = (url: string): string | null => (url.includes("169.254.169.254") ? null : `/api/img?u=${encodeURIComponent(url)}&s=test`);
vi.mock("@/features/apps/deps", async () => ({ ...(await import("./harness")).fakeDeps, signImageUrl: fakeSign }));

setupAppsDb();

let svc: typeof import("../service");
let versions: typeof import("@/features/versions/service");
let repo: typeof import("../repo");
let load: typeof import("../load");

const PUBLISHED_URL = "https://img.example.com/published.png";
const DRAFT_URL = "https://img.example.com/draft-only.png";
const TEMPLATE_URL = "https://img.example.com/{{ cams.first.file }}.png";
const METADATA_URL = "http://169.254.169.254/latest/meta.png";

beforeAll(async () => {
  await seedUsers();
  svc = await import("../service");
  versions = await import("@/features/versions/service");
  repo = await import("../repo");
  load = await import("../load");
});

const image = (id: string, src: string): ComponentNode => ({ id, type: "image", props: { src, alt: "x" }, slot: { x: 0, y: 0, w: 3, h: 8 } });

/** An app whose published version shows PUBLISHED_URL and whose draft adds DRAFT_URL, a template URL and a metadata address. */
async function setup(slug: string): Promise<App> {
  const { app } = svc.createApp(owner, { name: "Gallery", slug });
  svc.updateAccess(owner, app.id, { view: "everyone", edit: { userIds: [editor.userId] }, guests: true });
  let d = repo.getDraft(app.id)!;
  const root = d.doc.pages[0]!.root.id;
  await svc.applyOps(app.id, d.rev, [{ op: "node.add", parentId: root, node: image("c_pubimgaaaa", PUBLISHED_URL) }], owner);
  d = repo.getDraft(app.id)!;
  await versions.publishDraft(owner, app.id, { expectRev: d.rev });
  d = repo.getDraft(app.id)!;
  await svc.applyOps(app.id, d.rev, [
    { op: "node.add", parentId: root, node: image("c_draftimgaa", DRAFT_URL) },
    { op: "node.add", parentId: root, node: image("c_tmplimgaaa", TEMPLATE_URL) },
    { op: "node.add", parentId: root, node: image("c_metaimgaaa", METADATA_URL) },
  ], owner);
  return repo.getApp(app.id)!;
}

describe("A5.1 draft image previews for editors", () => {
  it("an editor's draft preview (?draft=1) signs the draft's literal external URL, not templates or refused addresses", async () => {
    const app = await setup("draft-img-1");
    for (const who of [owner, editor]) {
      const v = await load.loadView(app.slug, undefined, who, { draft: true, render: false });
      expect(v.kind).toBe("ok");
      if (v.kind !== "ok") return;
      expect(v.mode).toBe("draft-preview");
      const s = v.rendered.signedUrls;
      expect(s[DRAFT_URL]).toBe(fakeSign(DRAFT_URL));
      expect(s[PUBLISHED_URL]).toBeDefined();
      expect(Object.keys(s)).not.toContain(TEMPLATE_URL);
      expect(Object.keys(s)).not.toContain(METADATA_URL);
    }
  });

  it("renderPage for the builder canvas and the render route (viewer \"editor\") signs the draft", async () => {
    const app = await setup("draft-img-2");
    const d = repo.getDraft(app.id)!;
    const r = await load.renderPage(app, d.doc, d.doc.pages[0]!, "editor");
    expect(r.signedUrls[DRAFT_URL]).toBe(fakeSign(DRAFT_URL));
    expect(Object.keys(r.signedUrls)).not.toContain(TEMPLATE_URL);
    expect(Object.keys(r.signedUrls)).not.toContain(METADATA_URL);
  });

  it("a non-editor on ?draft=1 gets the published version and no draft URL signed", async () => {
    const app = await setup("draft-img-3");
    const v = await load.loadView(app.slug, undefined, watcher, { draft: true, render: false });
    expect(v.kind).toBe("ok");
    if (v.kind !== "ok") return;
    expect(v.mode).toBe("view");
    expect(v.rendered.signedUrls[PUBLISHED_URL]).toBeDefined();
    expect(Object.keys(v.rendered.signedUrls)).not.toContain(DRAFT_URL);
  });

  it("a guest on ?draft=1 gets the published version and no draft URL signed", async () => {
    const app = await setup("draft-img-4");
    const v = await load.loadView(app.slug, undefined, guestOf(app.id), { draft: true, render: true });
    expect(v.kind).toBe("ok");
    if (v.kind !== "ok") return;
    expect(v.mode).toBe("view");
    expect(Object.keys(v.rendered.signedUrls)).not.toContain(DRAFT_URL);
  });

  it("renderPage of a draft for a viewer or a guest signs nothing", async () => {
    const app = await setup("draft-img-5");
    const d = repo.getDraft(app.id)!;
    for (const kind of ["viewer", "guest"] as const) {
      const r = await load.renderPage(app, d.doc, d.doc.pages[0]!, kind);
      expect(r.signedUrls).toEqual({});
    }
  });
});
