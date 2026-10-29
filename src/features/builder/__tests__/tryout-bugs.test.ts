// Wave 2.10a app-builder (B1 builder half, B2 Fit): the measure arithmetic, which edits start a growth check,
// and the draft client's merge of a follow-up into the edit that caused it (one undo step).
import { describe, expect, it } from "vitest";
import type { ComponentNode, DraftOp } from "@/core/contracts";
import { blankDocument, findNode, newId } from "@/features/apps/doc";
import { DraftClient, type SendResult } from "../draft-client";
import { overflowPx, rowsFor, type Extent } from "../fit-measure";
import { growTriggers, sizingOf } from "../auto-grow";

const ext = (p: Partial<Extent>): Extent => ({ top: 100, height: 72, contentBottom: 172, padBottom: 0, scrollOver: 0, innerHidden: 0, scrollTop: 0, ...p });

describe("fit-measure (B2)", () => {
  it("content that fits needs no rows", () => {
    expect(rowsFor(overflowPx(ext({})))).toBe(0);
  });
  it("sub-pixel overflow the rounded scrollHeight misses still rounds up to one row", () => {
    // scrollHeight and clientHeight are whole px and equal, but the content ends 0.4 px past the box.
    const px = overflowPx(ext({ contentBottom: 172.4, scrollOver: 0 }));
    expect(px).toBeCloseTo(0.4, 5);
    expect(rowsFor(px)).toBe(1);
  });
  it("counts the root's bottom padding and border under the content", () => {
    expect(overflowPx(ext({ contentBottom: 160, padBottom: 16 }))).toBeCloseTo(4, 5);
    expect(rowsFor(4)).toBe(1);
  });
  it("takes the larger of the browser's scroll overflow and the boxes, plus inner scroll areas", () => {
    expect(overflowPx(ext({ scrollOver: 20, contentBottom: 180 }))).toBe(20);
    expect(overflowPx(ext({ innerHidden: 30 }))).toBe(30);
    expect(rowsFor(17)).toBe(3);
  });
  it("divides screen px by the canvas zoom (Preview width)", () => {
    // Drawn at half size: 10 screen px past the box is 20 layout px.
    expect(overflowPx(ext({ height: 36, contentBottom: 146 }), 0.5)).toBeCloseTo(20, 5);
  });
  it("adds what the root has scrolled away", () => {
    expect(overflowPx(ext({ contentBottom: 162, scrollTop: 10 }))).toBe(0);
    expect(overflowPx(ext({ contentBottom: 172, scrollTop: 10 }))).toBe(10);
  });
  it("noise under 0.02 px is not content", () => {
    expect(rowsFor(0.01)).toBe(0);
    expect(rowsFor(8)).toBe(1);
    expect(rowsFor(8.01)).toBe(1);
    expect(rowsFor(8.1)).toBe(2);
  });
});

describe("auto-grow triggers (B1)", () => {
  const doc = blankDocument("T");
  const root = doc.pages[0]!.root;
  const g: ComponentNode = { id: newId("c"), type: "group", props: { title: "G", columns: 4 }, slot: { x: 0, y: 0, w: 12, h: 26 }, children: [] };
  const s: ComponentNode = { id: newId("c"), type: "stat", props: { label: "A" }, slot: { x: 0, y: 26, w: 3, h: 16 } };
  root.children = [g, s];
  it("an insert watches the new node and its container", () => {
    const tile: ComponentNode = { id: newId("c"), type: "service-tile", props: {} };
    expect(growTriggers(doc, [{ op: "node.add", parentId: g.id, node: tile }]).sort()).toEqual([g.id, tile.id].sort());
  });
  it("a prop or data change watches the node; a resize, a phone slot or hiding does not", () => {
    expect(growTriggers(doc, [{ op: "node.update", nodeId: s.id, patch: { props: { label: "B" } } }])).toEqual([s.id]);
    expect(growTriggers(doc, [{ op: "node.update", nodeId: s.id, patch: { slot: { x: 0, y: 26, w: 3, h: 30 } } }])).toEqual([]);
    expect(growTriggers(doc, [{ op: "node.update", nodeId: s.id, patch: { responsive: { mobile: { slot: { x: 0, y: 0, w: 1, h: 8 } } } } }])).toEqual([]);
    expect(growTriggers(doc, [{ op: "node.update", nodeId: s.id, patch: { hidden: true } }])).toEqual([]);
  });
  it("Customise the look alone starts nothing until the node has a saved style", () => {
    expect(growTriggers(doc, [{ op: "node.update", nodeId: s.id, patch: { overrideTheme: true } }])).toEqual([]);
    const styled = blankDocument("T");
    const n: ComponentNode = { ...s, style: { root: { padding: 24 } } } as ComponentNode;
    styled.pages[0]!.root.children = [n];
    expect(growTriggers(styled, [{ op: "node.update", nodeId: n.id, patch: { overrideTheme: true } }])).toEqual([n.id]);
  });
  it("a move inside one parent starts nothing; a move between parents watches both and the node", () => {
    expect(growTriggers(doc, [{ op: "node.move", nodeId: s.id, parentId: root.id, slot: { x: 3, y: 0, w: 3, h: 16 } }])).toEqual([]);
    expect(growTriggers(doc, [{ op: "node.move", nodeId: s.id, parentId: g.id }]).sort()).toEqual([s.id, g.id, root.id].sort());
  });
  it("removals, page and theme edits start nothing", () => {
    expect(growTriggers(doc, [{ op: "node.remove", nodeId: s.id }, { op: "theme.set", theme: { themeId: "dusk" } }])).toEqual([]);
  });
  it("sizing: absent means fit", () => {
    expect(sizingOf("stat", () => undefined)).toBe("fit");
    expect(sizingOf("stat", () => ({}))).toBe("fit");
    expect(sizingOf("table", () => ({ sizing: "scroll" }))).toBe("scroll");
  });
});

describe("DraftClient merge (B1: insert and grow are one undo step)", () => {
  const setup = () => {
    const doc = blankDocument("T");
    const root = doc.pages[0]!.root;
    const a: ComponentNode = { id: newId("c"), type: "stat", props: { label: "A" }, slot: { x: 0, y: 0, w: 3, h: 16 } };
    const b: ComponentNode = { id: newId("c"), type: "stat", props: { label: "B" }, slot: { x: 0, y: 16, w: 3, h: 16 } };
    root.children = [a, b];
    const sent: DraftOp[][] = [];
    let rev = 1;
    const client = new DraftClient(doc, 1, {
      send: async (_r, ops): Promise<SendResult> => { sent.push(ops); return { ok: true, rev: ++rev }; },
      fetchDraft: async () => ({ rev, doc }),
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    return { client, root, a, b, sent };
  };
  const grow = (id: string, h: number, parentId: string, y = 0): DraftOp => ({ op: "node.move", nodeId: id, parentId, index: 0, slot: { x: 0, y, w: 3, h } });

  it("merges into the edit that caused it: one undo reverts both, one redo brings both back", () => {
    const { client, root, a } = setup();
    client.edit([{ op: "node.update", nodeId: a.id, patch: { props: { label: "A long label" } } }]);
    const entry = client.lastEntryId;
    client.edit([grow(a.id, 24, root.id)], { history: "merge", into: entry });
    expect(client.lastEntryId).toBe(entry);
    client.undo();
    expect(findNode(client.doc, a.id)!.node.props.label).toBe("A");
    expect(findNode(client.doc, a.id)!.node.slot!.h).toBe(16);
    expect(client.canUndo).toBe(false);
    client.redo();
    expect(findNode(client.doc, a.id)!.node.props.label).toBe("A long label");
    expect(findNode(client.doc, a.id)!.node.slot!.h).toBe(24);
  });
  it("after a later edit the follow-up is its own step", () => {
    const { client, root, a, b } = setup();
    client.edit([{ op: "node.update", nodeId: a.id, patch: { props: { label: "A2" } } }]);
    const entry = client.lastEntryId;
    client.edit([{ op: "node.update", nodeId: b.id, patch: { props: { label: "B2" } } }]);
    client.edit([grow(a.id, 24, root.id)], { history: "merge", into: entry });
    client.undo();
    expect(findNode(client.doc, a.id)!.node.slot!.h).toBe(16);
    expect(findNode(client.doc, b.id)!.node.props.label).toBe("B2");
  });
  it("never merges onto a step that was undone", () => {
    const { client, root, a } = setup();
    client.edit([{ op: "node.update", nodeId: a.id, patch: { props: { label: "A2" } } }]);
    const entry = client.lastEntryId;
    client.undo();
    client.edit([grow(a.id, 24, root.id)], { history: "merge", into: entry });
    expect(client.canRedo).toBe(false);
    client.undo();
    expect(findNode(client.doc, a.id)!.node.slot!.h).toBe(16);
  });
});
