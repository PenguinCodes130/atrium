// Wave 2.10a round 2 (app-builder), the server half: item 8 (design v4 Note 3, "Theme after publish": a saved
// theme edited since the last publish counts as a change, and settings can list the apps behind) and item 16
// (the publish summary never names a managed source by its generated d_... name). Real temp SQLite; the
// theme store is the harness fake, whose `themeEdits` stands in for saving a theme in Settings.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { owner, seedIntegration, seedUsers, setupAppsDb, themeEdits } from "./harness";

vi.mock("@/features/apps/deps", async () => (await import("./harness")).fakeDeps);

setupAppsDb();

let svc: typeof import("../service");
let versions: typeof import("@/features/versions/service");
let repo: typeof import("../repo");
let haId = "";

beforeAll(async () => {
  await seedUsers();
  haId = await seedIntegration(owner);
  svc = await import("../service");
  versions = await import("@/features/versions/service");
  repo = await import("../repo");
});

async function publish(appId: string) {
  const review = versions.reviewDraft(owner, appId);
  await versions.publishDraft(owner, appId, { expectRev: review.rev });
}

describe("item 8: a theme saved after publish is a change", () => {
  it("counts only once the saved theme differs from the live snapshot, and a publish settles it", async () => {
    const { app } = svc.createApp(owner, { name: "Themed", slug: "r2-themed" });
    svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "theme.set", theme: { themeId: "r2-theme" } }] });
    // Nothing published yet: nothing to compare against.
    expect(await versions.themeChangesSincePublish(repo.getApp(app.id)!)).toEqual([]);
    await publish(app.id);
    expect(await versions.themeChangesSincePublish(repo.getApp(app.id)!)).toEqual([]);
    themeEdits.set("r2-theme", "#123456");
    const changes = await versions.themeChangesSincePublish(repo.getApp(app.id)!);
    expect(changes).toEqual([{ themeId: "r2-theme", name: "r2-theme", pageId: null, version: 1 }]);
    const review = await versions.reviewDraftWithThemes(owner, app.id);
    expect(review.groups[0]!.title).toBe("App");
    expect(review.groups[0]!.lines).toContainEqual({ kind: "changed", text: "Theme r2-theme changed since v1: publish to show it to viewers" });
    expect(review.canPublish).toBe(true);
    // Settings' "Used by N published apps": this app is behind the saved theme, with its review address.
    expect(await versions.publishedAppsBehindTheme("r2-theme", [repo.getApp(app.id)!])).toEqual([{ appId: app.id, slug: "r2-themed", name: "Themed", version: 1, reviewHref: "/build/r2-themed?review=1" }]);
    await publish(app.id);
    expect(await versions.themeChangesSincePublish(repo.getApp(app.id)!)).toEqual([]);
    expect(await versions.publishedAppsBehindTheme("r2-theme", [repo.getApp(app.id)!])).toEqual([]);
    themeEdits.delete("r2-theme");
  });
  it("a different theme picked in the draft is the usual Changed the theme, not a theme edit", async () => {
    const { app } = svc.createApp(owner, { name: "Picked", slug: "r2-picked" });
    svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "theme.set", theme: { themeId: "r2-one" } }] });
    await publish(app.id);
    svc.applyDraftOps({ appId: app.id, by: owner, ops: [{ op: "theme.set", theme: { themeId: "r2-two" } }] });
    expect(await versions.themeChangesSincePublish(repo.getApp(app.id)!)).toEqual([]);
    const lines = (await versions.reviewDraftWithThemes(owner, app.id)).groups.flatMap((g) => g.lines.map((l) => l.text));
    expect(lines).toContain("Changed the theme");
  });
});

describe("item 16: the publish summary names reads in words", () => {
  it("leaves out managed sources (their components say it) and keeps a person's own source by its name", async () => {
    const { app } = svc.createApp(owner, { name: "Reads", slug: "r2-reads" });
    const d = repo.getDraft(app.id)!;
    const root = d.doc.pages[0]!.root.id;
    svc.applyDraftOps({ appId: app.id, by: owner, ops: [
      { op: "source.set", source: { name: "d_abcdefgh", managed: true, label: "CPU in use, pve1", integrationId: haId, endpointId: "states", refreshSec: 30 } },
      { op: "source.set", source: { name: "lights", integrationId: haId, endpointId: "states", refreshSec: 30 } },
      { op: "node.add", parentId: root, node: { id: "c_r2statabcd", type: "stat", props: { value: { $bind: "{{ d_abcdefgh.value }}" } }, slot: { x: 0, y: 0, w: 3, h: 24 } } },
    ] });
    const text = versions.reviewDraft(owner, app.id).groups.flatMap((g) => g.lines.map((l) => l.text)).join("\n");
    expect(text).not.toMatch(/d_[a-z2-7]{8}/);
    expect(text).toContain("Added data source lights");
  });
});
