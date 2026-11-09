// Wave 2.10c round 3, builder A (C's item 2 note): a widget whose label is a per-row template
// ("{{ $item.name }}") is named by its type in the publish review and the change lines, never by the braces.
import { describe, expect, it } from "vitest";
import type { ComponentNode } from "@/core/contracts";
import { nodeLabel } from "@/features/apps/doc";

const gauge = (label: string): ComponentNode => ({ id: "c_g", type: "gauge", props: { label, min: 0, max: 100 } });

describe("nodeLabel never prints a template", () => {
  it("names a gauge with a per-row label by its type", () => {
    expect(nodeLabel(gauge("{{ $item.name }}"))).toBe("gauge");
    expect(nodeLabel(gauge("CPU {{ $index }}"))).toBe("gauge");
  });
  it("still names a gauge by a plain typed label", () => {
    expect(nodeLabel(gauge("CPU"))).toBe("gauge CPU");
  });
});
