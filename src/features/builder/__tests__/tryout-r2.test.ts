// Wave 2.10a round 2 (app-builder), the pure halves: Fit's words never say "fits" while columns hide at the
// side (item 14), a removed component's gap closes through the empty rows below it (low), and a managed
// source reads in words for people (item 16).
import { describe, expect, it } from "vitest";
import type { AppDocument, ComponentNode, DataSourceDef } from "@/core/contracts";
import { blankDocument } from "@/features/apps/doc";
import { fitWords } from "../fit-measure";
import { closeGapOps } from "../geometry";
import { readableSource } from "../inspector";

describe("item 14: Fit is honest about columns hidden at the side", () => {
  it("never says it already fits while px are cut off sideways", () => {
    expect(fitWords({ rows: 0, widened: false, hiddenX: 0 }, 0)).toBe("It already shows all its content.");
    const hidden = fitWords({ rows: 0, widened: false, hiddenX: 300 }, 300);
    expect(hidden).not.toMatch(/already shows/);
    expect(hidden).toContain("300 px are cut off at the side");
    // Columns that only hide once the box grew are still named.
    expect(fitWords({ rows: 2, widened: false, hiddenX: 0 }, 40)).toContain("40 px are cut off");
  });
  it("says it widened, and what still does not fit", () => {
    expect(fitWords({ rows: 0, widened: true, hiddenX: 300 }, 0)).toBe("Widened to the whole row so its columns show. Undo with Ctrl+Z.");
    expect(fitWords({ rows: 0, widened: true, hiddenX: 300 }, 90)).toContain("Some columns still do not fit (90 px");
    expect(fitWords({ rows: 0, widened: false, hiddenX: 300, blocked: true }, 300)).toContain("Move what sits beside it");
  });
});

describe("low: deleting a component closes its whole gap", () => {
  const grid = (kids: ComponentNode[]): ComponentNode => ({ id: "c_gridaaaaaa", type: "grid", props: {}, children: kids });
  const at = (id: string, x: number, y: number, w: number, h: number): ComponentNode => ({ id, type: "text", props: { text: id }, slot: { x, y, w, h } });
  const doc = (root: ComponentNode): AppDocument => { const d = blankDocument("Gaps"); d.pages[0]!.root = root; return d; };
  it("the empty rows just below the removed slot close too, up to the next component", () => {
    // a 0..8, b 8..20, then 12 empty rows, then c at 32: removing b moves c up to 8.
    const d = doc(grid([at("c_aaaaaaaaaa", 0, 0, 12, 8), at("c_bbbbbbbbbb", 0, 8, 12, 12), at("c_cccccccccc", 0, 32, 12, 8)]));
    expect(closeGapOps(d, "c_bbbbbbbbbb")).toEqual([{ op: "node.move", nodeId: "c_cccccccccc", parentId: "c_gridaaaaaa", index: 1, slot: { x: 0, y: 8, w: 12, h: 8 } }]);
  });
  it("a removed box whose rows a neighbour covers leaves the empty rows below it alone", () => {
    const d = doc(grid([at("c_aaaaaaaaaa", 0, 0, 6, 20), at("c_bbbbbbbbbb", 6, 0, 6, 20), at("c_cccccccccc", 0, 32, 12, 8)]));
    expect(closeGapOps(d, "c_bbbbbbbbbb")).toEqual([]);
  });
});

describe("item 16: a source in words", () => {
  const def = (p: Partial<DataSourceDef>): DataSourceDef => ({ name: "d_abcdefgh", integrationId: "i1", endpointId: "machine-summary", refreshSec: 30, ...p }) as DataSourceDef;
  const listing = [{ integrationId: "i1", integrationName: "Prometheus", packageId: "prometheus", health: "ok" as const, endpoints: [{ id: "machine-summary", label: "Everything about a machine" }] }] as never;
  it("uses the label, then the read and its service, never the generated name", () => {
    expect(readableSource(def({ managed: true, label: "CPU in use, pve1" }), listing)).toBe("CPU in use, pve1");
    expect(readableSource(def({ managed: true }), listing)).toBe("Everything about a machine, Prometheus");
    expect(readableSource(def({ managed: true, integrationId: "gone" }), listing)).toBe("a read from one of your services");
    expect(readableSource(def({ name: "lights" }), [])).toBe("lights");
  });
});
