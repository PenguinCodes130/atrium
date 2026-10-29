// Wave 2.10a round 3 (gauntlet r2 recheck H1, M1, item 16): the unit halves of the e2e checks in
// tests/e2e/components/p-w210a-r3.spec.ts and tests/e2e/app-builder/s-w210a-r3.spec.ts.
import { describe, expect, it } from "vitest";
import type { AppDocument, ComponentNode } from "@/core/contracts";
import { sizingOf } from "./catalogue/meta";
import { sizingOf as builderSizing } from "@/features/builder/auto-grow";
import { rowScope } from "./inspector/inspector";
import { chipWords, dataSentence } from "./inspector/binding-words";
import { readableDiff } from "@/features/versions/diff";
import { summarize } from "@/features/apps/ops";
import { evaluateTemplate } from "./bindings";
import type { PageScope } from "./render/resolve";

const card: ComponentNode = { id: "c_cardaaaaaa", type: "card", props: { title: { $bind: "{{ $item.name }}" } }, children: [] };
const repeat: ComponentNode = { id: "c_repeataaaa", type: "repeat", props: { items: { $bind: "{{ machines.rows }}" } }, children: [card] };
const doc = (sources: AppDocument["dataSources"], kids: ComponentNode[] = []): AppDocument =>
  ({ app: { name: "A", homePage: "p_homeaaaaaa", pageOrder: ["p_homeaaaaaa"] }, theme: { themeId: "t" }, chrome: {}, controls: [], dataSources: sources, pages: [{ id: "p_homeaaaaaa", slug: "home", title: "Home", root: { id: "c_rootaaaaaa", type: "grid", props: {}, children: kids } }] }) as unknown as AppDocument;

describe("H1: a repeat of cards is fit, so it grows to its cards", () => {
  it("components and the builder both size a Card for each as fit; other repeats still scroll", () => {
    expect(sizingOf(repeat)).toBe("fit");
    expect(sizingOf({ ...repeat, children: [{ type: "stat" }] })).toBe("scroll");
    expect(sizingOf({ type: "repeat", props: {} })).toBe("scroll");
    const lookup = () => ({ sizing: "scroll" as const });
    expect(builderSizing("repeat", lookup, repeat)).toBe("fit");
    expect(builderSizing("repeat", lookup)).toBe("scroll");
  });
});

describe("M1: inside a repeat the inspector previews $item against the first row", () => {
  const scope = { $data: { machines: { kind: "table", columns: [], rows: [{ name: "ACE" }, { name: "pve1" }] } } } as unknown as PageScope;
  it("the ready card's title reads ACE, with no repeat-only error", () => {
    const s = rowScope(doc([], [repeat]), card.id, scope);
    const r = evaluateTemplate("{{ $item.name }}", s);
    expect(r.ok && r.value).toBe("ACE");
  });
  it("outside any repeat the scope is unchanged, so $item is still an error there", () => {
    const s = rowScope(doc([], [repeat, { id: "c_loneaaaaaa", type: "card", props: {} }]), "c_loneaaaaaa", scope);
    expect(s).toBe(scope);
    const r = evaluateTemplate("{{ $item.name }}", s);
    expect(r.ok ? "" : r.error.code).toBe("binding.repeat_only");
  });
});

describe("item 16: sources read by their label", () => {
  it("the Data sentence and chip use the words they are given", () => {
    expect(dataSentence("{{ x.rows | count }}", "Everything about a machine").sentence).toBe("Shows a custom value from Everything about a machine");
    expect(chipWords("{{ x.rows }}", "Everything about a machine")).toBe("Custom value from Everything about a machine");
  });
  it("the Publish summary and the change summary name a labelled source by its label", () => {
    const src = { name: "everything_about_a", label: "Everything about a machine, every machine", integrationId: "i", endpointId: "machine-summary", refreshSec: 30 };
    const text = readableDiff(doc([]), doc([src])).flatMap((g) => g.lines.map((l) => l.text)).join("\n");
    expect(text).toContain("Added data source Everything about a machine, every machine");
    expect(text).not.toContain("everything_about_a");
    expect(summarize(doc([]), [{ op: "source.set", source: src }] as never)).toBe("Added data source Everything about a machine, every machine");
    // A source a person named, with no label, keeps its name.
    const own = readableDiff(doc([]), doc([{ ...src, name: "lights", label: undefined }])).flatMap((g) => g.lines.map((l) => l.text)).join("\n");
    expect(own).toContain("Added data source lights");
  });
});
