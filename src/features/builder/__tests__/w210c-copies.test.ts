// Wave 2.10c R1 builder half: "This copy only" writes `copyOverrides` on the repeat as one op (one history
// entry), keeps only what differs from the template, resets a copy, and undoes cleanly.
import { describe, expect, it } from "vitest";
import type { ComponentNode } from "@/core/contracts";
import { blankDocument, findNode, newId } from "@/features/apps/doc";
import { applyOpsToDoc, inverseOps } from "@/features/apps/ops";
import { copyChanged, copyEditOps, mergeDiff, overrideFor, overridesOf, resetCopyOps, rowKeyOf, withOverride } from "../copy-overrides";
import { historyLabel } from "../history-label";

function fixture() {
  const stat: ComponentNode = { id: newId("c"), type: "stat", props: { label: { $bind: "{{ $item.name }}" }, value: { $bind: "{{ $item.cpu }}" }, unit: "%" } };
  const repeat: ComponentNode = { id: newId("c"), type: "repeat", props: { items: { $bind: "{{ hosts.rows }}" }, columns: 3 }, slot: { x: 0, y: 0, w: 12, h: 24 }, children: [stat] };
  const d = blankDocument("T");
  d.pages[0]!.root.children = [repeat];
  return { d, stat, repeat };
}
const run = (d: ReturnType<typeof blankDocument>, ops: Parameters<typeof applyOpsToDoc>[1]) => { const r = applyOpsToDoc(d, ops); if (!r.ok) throw new Error(JSON.stringify(r.problems)); return r.doc; };

describe("R1 copy overrides (builder half)", () => {
  it("a row's key is the one components draws: its name, a numbered duplicate, the index only with no name", () => {
    const rows = [{ name: "ACE", instance: "x" }, { host: "pve1" }, { cpu: 3 }, { name: "ACE" }];
    expect([0, 1, 2, 3].map((i) => rowKeyOf(rows, i))).toEqual(["ACE", "pve1", "#2", "ACE (2)"]);
    expect(rowKeyOf(rows, 9)).toBe("#9");
  });

  it("This copy only writes one node.update on the repeat with only what differs; the template is unchanged", () => {
    const { d, stat, repeat } = fixture();
    const shown = withOverride(stat, overrideFor(d, repeat.id, "ACE", stat.id));
    const { ops, rest } = copyEditOps(d, repeat.id, "ACE", stat.id, { props: { ...shown.props, unit: "pct" } });
    expect(rest).toBeNull();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "node.update", nodeId: repeat.id });
    expect(historyLabel(d, ops)).toBe("Change Repeat");
    const after = run(d, ops);
    expect(overridesOf(findNode(after, repeat.id)!.node)).toEqual({ ACE: { [stat.id]: { props: { unit: "pct" } } } });
    expect(findNode(after, stat.id)!.node.props.unit).toBe("%");
    expect(copyChanged(after, repeat.id, "ACE")).toBe(true);
    expect(copyChanged(after, repeat.id, "firefly")).toBe(false);
    // A second copy keeps its own; setting a value back to the template's drops it from the override.
    const after2 = run(after, copyEditOps(after, repeat.id, "firefly", stat.id, { props: { ...stat.props, unit: "°C" } }).ops);
    const back = copyEditOps(after2, repeat.id, "ACE", stat.id, { props: { ...stat.props, unit: "%" } }).ops;
    const after3 = run(after2, back);
    expect(overridesOf(findNode(after3, repeat.id)!.node)).toEqual({ firefly: { [stat.id]: { props: { unit: "°C" } } } });
  });

  it("the inverse of the op restores the earlier overrides exactly (undo)", () => {
    const { d, stat, repeat } = fixture();
    const ops = copyEditOps(d, repeat.id, "ACE", stat.id, { props: { ...stat.props, unit: "pct" }, hidden: true }).ops;
    const inv = inverseOps(d, ops)!;
    const undone = run(run(d, ops), inv);
    expect(findNode(undone, repeat.id)!.node.props.copyOverrides).toBeUndefined();
    expect(findNode(undone, repeat.id)!.node.props).toEqual(repeat.props);
  });

  it("Reset this copy removes that row's overrides only; patch keys a copy cannot keep come back as rest", () => {
    const { d, stat, repeat } = fixture();
    let doc = run(d, copyEditOps(d, repeat.id, "ACE", stat.id, { props: { ...stat.props, unit: "pct" } }).ops);
    doc = run(doc, copyEditOps(doc, repeat.id, "pve1", stat.id, { style: { root: { color: "red" } } } as never).ops);
    doc = run(doc, resetCopyOps(doc, repeat.id, "ACE"));
    expect(Object.keys(overridesOf(findNode(doc, repeat.id)!.node))).toEqual(["pve1"]);
    doc = run(doc, resetCopyOps(doc, repeat.id, "pve1"));
    expect(findNode(doc, repeat.id)!.node.props.copyOverrides).toBeUndefined();
    expect(resetCopyOps(doc, repeat.id, "pve1")).toEqual([]);
    const { rest } = copyEditOps(doc, repeat.id, "ACE", stat.id, { props: stat.props, title: "CPU" });
    expect(rest).toEqual({ title: "CPU" });
  });

  it("mergeDiff gives a merge patch with nulls for removed keys", () => {
    expect(mergeDiff({ a: { x: 1, y: 2 } }, { a: { x: 1 } })).toEqual({ a: { y: null } });
    expect(mergeDiff({ a: 1 }, { a: 1 })).toBeUndefined();
    expect(mergeDiff({}, { b: { $bind: "{{ x }}" } })).toEqual({ b: { $bind: "{{ x }}" } });
  });
});
