// Pure tests: draft operations (all or nothing), undo, layout-only, slugs, diff matching by id.
import { describe, expect, it } from "vitest";
import type { AppDocument, ComponentNode, DraftOp } from "@/core/contracts";
import { blankDocument, findNode, newId, rekeyDocument, slugProblem, slugify, stableJson } from "../doc";
import { applyOpsToDoc, inverseOps, isLayoutOnly, opTargets, summarize } from "../ops";
import { audienceTag, canCreate, canDelete } from "../access";
import { diffDocuments, readableDiff } from "@/features/versions/diff";
import { versionsToPrune } from "@/features/versions/retention";

const stat = (over: Partial<ComponentNode> = {}): ComponentNode => ({ id: newId("c"), type: "stat", props: { label: "CPU" }, slot: { x: 0, y: 0, w: 3, h: 16 }, ...over });

function docWith(...nodes: ComponentNode[]): AppDocument {
  const d = blankDocument("Test");
  d.pages[0]!.root.children = nodes;
  return d;
}

describe("slugs", () => {
  it("accepts lowercase letters, digits and hyphens, 1 to 40", () => {
    expect(slugProblem("guest-room")).toBeNull();
    expect(slugProblem("a".repeat(40))).toBeNull();
  });
  it("refuses empty, too long and other characters, with a reason", () => {
    expect(slugProblem("")).toMatch(/URL name/);
    expect(slugProblem("a".repeat(41))).toMatch(/at most 40/);
    expect(slugProblem("Guest_Room")).toMatch(/lowercase letters, digits and hyphens/);
    expect(slugProblem("guest room")).toMatch(/lowercase/);
  });
  it("suggests a slug from a name", () => {
    expect(slugify("Guest room, Sam!")).toBe("guest-room-sam");
    expect(slugify("Café Été")).toBe("cafe-ete");
  });
});

describe("applyOpsToDoc", () => {
  it("applies a batch in order and leaves the input untouched", () => {
    const a = stat();
    const d = docWith(a);
    const before = stableJson(d);
    const r = applyOpsToDoc(d, [
      { op: "node.update", nodeId: a.id, patch: { props: { label: "Load" } } },
      { op: "node.move", nodeId: a.id, parentId: d.pages[0]!.root.id, index: 0, slot: { x: 3, y: 0, w: 3, h: 16 } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(findNode(r.doc, a.id)!.node.props.label).toBe("Load");
    expect(findNode(r.doc, a.id)!.node.slot).toEqual({ x: 3, y: 0, w: 3, h: 16 });
    expect(stableJson(d)).toBe(before);
  });

  it("is all or nothing: one bad op refuses the whole batch", () => {
    const a = stat();
    const d = docWith(a);
    const r = applyOpsToDoc(d, [
      { op: "node.update", nodeId: a.id, patch: { props: { label: "Load" } } },
      { op: "node.remove", nodeId: "c_missing0000" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems[0]!.code).toBe("node.missing");
    expect(findNode(d, a.id)!.node.props.label).toBe("CPU");
  });

  it("refuses duplicate ids, non-containers, cycles and removing the root", () => {
    const a = stat();
    const d = docWith(a);
    const root = d.pages[0]!.root.id;
    expect(applyOpsToDoc(d, [{ op: "node.add", parentId: root, node: { ...stat(), id: a.id } }]).ok).toBe(false);
    expect(applyOpsToDoc(d, [{ op: "node.add", parentId: a.id, node: stat() }]).ok).toBe(false);
    expect(applyOpsToDoc(d, [{ op: "node.remove", nodeId: root }]).ok).toBe(false);
    const card: ComponentNode = { id: newId("c"), type: "card", props: {}, children: [] };
    const d2 = docWith(card);
    const r = applyOpsToDoc(d2, [{ op: "node.move", nodeId: card.id, parentId: card.id }]);
    expect(r.ok).toBe(false);
  });

  it("refuses a cooldown under 250ms and a bad data source name", () => {
    const d = docWith();
    const c = applyOpsToDoc(d, [{ op: "control.set", control: { id: newId("k"), label: "Lamp", run: { kind: "command", integrationId: "i", commandId: "light.toggle" }, cooldownMs: 100 } }]);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.problems[0]!.where.field).toBe("cooldownMs");
    const s = applyOpsToDoc(d, [{ op: "source.set", source: { name: "Bad Name", integrationId: "i", endpointId: "e", refreshSec: 10 } }]);
    expect(s.ok).toBe(false);
  });

  it("runs the server's checks after the batch and keeps their field", () => {
    const d = docWith();
    const r = applyOpsToDoc(d, [{ op: "source.set", source: { name: "ha", integrationId: "i", endpointId: "states", refreshSec: 1 } }], {
      source: (s) => (s.refreshSec < 5 ? [{ severity: "error", code: "source.refresh_below_min", where: { field: "refreshSec" }, message: "The refresh interval must be at least 5 seconds for States." }] : []),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatchObject({ code: "source.refresh_below_min", where: { field: "refreshSec" } });
  });

  it("edits the mobile layout without touching the desktop slot", () => {
    const a = stat();
    const d = docWith(a);
    const r = applyOpsToDoc(d, [{ op: "node.update", nodeId: a.id, patch: { responsive: { mobile: { slot: { x: 0, y: 4, w: 4, h: 16 } } } } }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const n = findNode(r.doc, a.id)!.node;
    expect(n.slot).toEqual(a.slot);
    expect(n.responsive?.mobile?.slot).toEqual({ x: 0, y: 4, w: 4, h: 16 });
  });

  it("pages: slugs unique and not reserved, the last page stays, home moves", () => {
    const d = docWith();
    const p = { id: newId("p"), slug: "versions", title: "V", inNav: true, root: { id: newId("c"), type: "grid" as const, props: {}, children: [] } };
    expect(applyOpsToDoc(d, [{ op: "page.add", page: p }]).ok).toBe(false);
    const ok = applyOpsToDoc(d, [{ op: "page.add", page: { ...p, slug: "lights" } }]);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const r = applyOpsToDoc(ok.doc, [{ op: "page.remove", pageId: d.app.homePage }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.app.homePage).toBe(p.id);
    expect(applyOpsToDoc(d, [{ op: "page.remove", pageId: d.app.homePage }]).ok).toBe(false);
  });
});

describe("undo (inverse operations)", () => {
  const cases: [string, (d: AppDocument, a: ComponentNode) => DraftOp[]][] = [
    ["move", (d, a) => [{ op: "node.move", nodeId: a.id, parentId: d.pages[0]!.root.id, index: 1, slot: { x: 6, y: 2, w: 3, h: 16 } }]],
    ["update", (_d, a) => [{ op: "node.update", nodeId: a.id, patch: { name: "Load", props: { label: "Load" }, overrideTheme: true } }]],
    ["remove", (_d, a) => [{ op: "node.remove", nodeId: a.id }]],
    ["add", (d) => [{ op: "node.add", parentId: d.pages[0]!.root.id, index: 0, node: stat() }]],
    ["source", () => [{ op: "source.set", source: { name: "ha", integrationId: "i", endpointId: "e", refreshSec: 10 } }]],
    ["chrome", () => [{ op: "chrome.update", patch: { layout: "sidebar", css: ":scope { color: red }" } }]],
    ["page", (d) => [{ op: "page.update", pageId: d.pages[0]!.id, patch: { title: "Lounge", inNav: false } }]],
    // A prop the node did not have yet (the first Flip across), sent as the whole props object.
    ["first prop", (_d, a) => [{ op: "node.update", nodeId: a.id, patch: { props: { ...a.props, flipX: true, filters: { grayscale: 100 } } } }]],
  ];
  for (const [name, make] of cases) {
    it(`undo of ${name} returns the document exactly`, () => {
      const a = stat();
      const b = stat({ slot: { x: 3, y: 0, w: 3, h: 16 } });
      const d = docWith(a, b);
      const ops = make(d, a);
      const fwd = applyOpsToDoc(d, ops);
      expect(fwd.ok).toBe(true);
      if (!fwd.ok) return;
      const inv = inverseOps(d, ops)!;
      const back = applyOpsToDoc(fwd.doc, inv);
      expect(back.ok).toBe(true);
      if (back.ok) expect(stableJson(back.doc)).toBe(stableJson(d));
      // and redo replays the original
      if (back.ok) {
        const again = applyOpsToDoc(back.doc, ops);
        expect(again.ok && stableJson(again.doc)).toBe(stableJson(fwd.doc));
      }
    });
  }
});

describe("layout only (agent auto-apply)", () => {
  it("is true only for moves that keep the parent", () => {
    const a = stat();
    const card: ComponentNode = { id: newId("c"), type: "card", props: {}, children: [] };
    const d = docWith(a, card);
    const root = d.pages[0]!.root.id;
    expect(isLayoutOnly(d, [{ op: "node.move", nodeId: a.id, parentId: root, slot: { x: 1, y: 0, w: 3, h: 16 } }])).toBe(true);
    expect(isLayoutOnly(d, [{ op: "node.move", nodeId: a.id, parentId: card.id }])).toBe(false);
    expect(isLayoutOnly(d, [{ op: "node.move", nodeId: a.id, parentId: root }, { op: "node.update", nodeId: a.id, patch: { name: "x" } }])).toBe(false);
    expect(isLayoutOnly(d, [])).toBe(false);
  });
  it("names the targets of ops for the builder's rebase", () => {
    expect(opTargets({ op: "node.update", nodeId: "c_a", patch: {} })).toEqual(["c_a"]);
  });
});

describe("diffDocuments matches by id", () => {
  it("reports added, removed, moved, props and style, and readable lines grouped by page", () => {
    const a = stat({ name: "CPU" });
    const b = stat({ name: "Disk", slot: { x: 3, y: 0, w: 3, h: 16 } });
    const before = docWith(a, b);
    const after = structuredClone(before);
    const root = after.pages[0]!.root;
    root.children = [{ ...root.children![0]!, slot: { x: 6, y: 0, w: 3, h: 16 } }];
    root.children[0]!.style = { root: { color: "red" } };
    const lamp: ComponentNode = { id: newId("c"), type: "toggle", name: "Bedroom lamp", props: { label: "Bedroom lamp" } };
    root.children.push(lamp);
    after.pages[0]!.title = "Guest room";
    const diff = diffDocuments(before, after);
    expect(diff.nodes.added).toEqual([lamp.id]);
    expect(diff.nodes.removed).toEqual([b.id]);
    expect(diff.nodes.moved).toEqual([a.id]);
    expect(diff.nodes.style).toEqual([a.id]);
    const lines = readableDiff(before, after).flatMap((g) => g.lines.map((l) => `${l.kind}:${l.text}`));
    expect(lines).toContain("added:Added toggle Bedroom lamp to Guest room");
    expect(lines).toContain("changed:Changed the style of stat CPU");
    expect(lines).toContain("removed:Removed stat Disk from Home");
  });
  it("a move-only batch gives a diff with only moves", () => {
    const a = stat();
    const d = docWith(a);
    const r = applyOpsToDoc(d, [{ op: "node.move", nodeId: a.id, parentId: d.pages[0]!.root.id, slot: { x: 4, y: 0, w: 3, h: 16 } }]);
    if (!r.ok) throw new Error("move failed");
    const diff = diffDocuments(d, r.doc);
    expect(diff.nodes).toEqual({ added: [], removed: [], moved: [a.id], props: [], style: [], code: [] });
    expect(diff.controls.added.length + diff.sources.added.length + diff.pages.changed.length).toBe(0);
  });
  it("rekeying keeps control references consistent", () => {
    const d = docWith({ id: newId("c"), type: "button", props: { control: "k_aaaaaaaaaa", label: "Go" } });
    d.controls.push({ id: "k_aaaaaaaaaa", label: "Go", run: { kind: "workflow", actionId: "x" } });
    const r = rekeyDocument(d);
    expect(r.controls[0]!.id).not.toBe("k_aaaaaaaaaa");
    expect(r.pages[0]!.root.children![0]!.props.control).toBe(r.controls[0]!.id);
  });
});

describe("retention", () => {
  it("keeps the last N and never the published version and the five before it", () => {
    const all = Array.from({ length: 26 }, (_, i) => i + 1);
    expect(versionsToPrune(all.slice(0, 21), 21, 20)).toEqual([1]);
    expect(versionsToPrune(all, 26, 20)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(versionsToPrune(all, 3, 20)).toEqual([6, 5, 4]); // v3 is live: v1 to v3 stay
    expect(versionsToPrune(all, 26, null)).toEqual([]);
  });
});

describe("access helpers", () => {
  it("audience tags", () => {
    const base = { id: "a", slug: "s", name: "n", draftRev: 1, createdBy: "u-m", createdAt: "", updatedAt: "" };
    expect(audienceTag({ ...base, access: { view: "owner", edit: { userIds: ["u-m"] }, guests: false } })).toBe("owner only");
    expect(audienceTag({ ...base, access: { view: "everyone", edit: "owner", guests: false } })).toBe("members");
    expect(audienceTag({ ...base, access: { view: "owner", edit: "owner", guests: true } })).toBe("guest link");
  });
  it("viewers cannot create; owner and creator can delete", () => {
    expect(canCreate({ kind: "user", userId: "v", role: "viewer", via: "session" })).toBe(false);
    expect(canCreate({ kind: "agent", userId: "m", role: "member", via: "pat", tokenId: "t", agentName: "a", scopes: ["atrium:read"] })).toBe(false);
    const app = { id: "a", slug: "s", name: "n", draftRev: 1, createdBy: "u-m", createdAt: "", updatedAt: "", access: { view: "owner" as const, edit: "owner" as const, guests: false } };
    expect(canDelete(app, { kind: "user", userId: "u-m", role: "member", via: "session" })).toBe(true);
    expect(canDelete(app, { kind: "user", userId: "u-x", role: "member", via: "session" })).toBe(false);
    expect(canDelete(app, { kind: "agent", userId: "u-m", role: "member", via: "pat", tokenId: "t", agentName: "a", scopes: ["atrium:edit"] })).toBe(false);
  });
  it("summaries name what changed", () => {
    const d = docWith();
    expect(summarize(d, [{ op: "node.add", parentId: d.pages[0]!.root.id, node: { id: newId("c"), type: "toggle", name: "Bedroom lamp", props: {} } }])).toBe("Added toggle Bedroom lamp");
  });
});
