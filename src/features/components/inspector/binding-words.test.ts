// Bindings in words (builder ease spec 3.2, 3.3; criteria 12 and 14).
import { describe, expect, it } from "vitest";
import { chipFrom, chipLine, chipValue, closestName, dataSentence, fieldAfterRoot, lastReadWords, refreshWords, unknownRootSentence, unknownSourceSentence } from "./binding-words";

describe("binding errors in words (criterion 14)", () => {
  it("names the source and offers the closest real one", () => {
    expect(unknownSourceSentence("lightz", ["cpu", "lights"])).toBe("There is no data source called lightz. Did you mean lights?");
    expect(unknownSourceSentence("x", ["cpu", "lights"])).toBe("There is no data source called x. This app's sources are cpu and lights.");
    expect(unknownSourceSentence("cpu", [])).toBe("There is no data source called cpu. This app has no data sources yet: add one with Pick data.");
    expect(closestName("Lights", ["lights"])).toBe("lights");
    expect(closestName("disk", ["lights", "cpu"])).toBeNull();
    expect(unknownRootSentence("$itme")).toBe("$itme is not something a template can read. Did you mean $item (the current row of a repeat)?");
  });
});

describe("the data chip and the Data sentence (criterion 12)", () => {
  it("reads like the spec's example", () => {
    expect(chipLine("Lights on", chipValue(4), chipFrom("lights", { integration: "Home Assistant", refreshSec: 10 }))).toBe("Lights on · 4 · Home Assistant, every 10 s");
    expect(chipFrom("cpu", { refreshSec: 120 })).toBe("cpu, every 2 min");
    expect(refreshWords(undefined)).toBe("");
  });
  it("shows values short", () => {
    expect(chipValue({ kind: "stat", value: 41.2731, unit: "%" })).toBe("41.27 %");
    expect(chipValue({ kind: "table", rows: [1, 2, 3] })).toBe("3 rows");
    expect(chipValue("on")).toBe("on");
    expect(chipValue(undefined)).toBe("no value yet");
  });
  it("builds the Data sentence from the binding", () => {
    const describe = { words: (t: string) => (t === "{{ lights.rows | count }}" ? "Number of rows in lights" : null) };
    expect(dataSentence("{{ lights.rows | count }}", "lights", describe, { integration: "Home Assistant", refreshSec: 10 })).toEqual({ sentence: "Shows the number of rows in lights, from Home Assistant, refreshed every 10 seconds.", custom: false });
    expect(dataSentence("{{ cpu }}", "cpu", { words: () => "All of cpu" }, null).sentence).toBe("Shows all of cpu.");
    expect(dataSentence("{{ lights.rows | count }} on", "lights", describe, null)).toEqual({ sentence: "Shows a custom value from lights", custom: true });
  });
  it("says when a failing source was last read", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(lastReadWords("2026-10-20T11:57:00Z", now)).toBe("Last read 3 min ago");
    expect(lastReadWords(undefined, now)).toBe("Not read yet");
  });
});

describe("Wave 2.10a round 2: a row guess inside a repeat, and sources by label", () => {
  const sources = ["d_l7sio4ax", "d_k2m9q0zz", "lights"];
  const labels = { d_l7sio4ax: "Machines, Proxmox", d_k2m9q0zz: "A read from Home Assistant", lights: "lights" };
  it("suggests $item for row, item and this inside a repeat", () => {
    expect(unknownSourceSentence("row", sources, { labels, inRepeat: true }, "name")).toBe("There is no data source called row. Inside a repeat, each row is $item: write {{ $item.name }}.");
    expect(unknownSourceSentence("item", sources, { labels, inRepeat: true }, "status")).toBe("There is no data source called item. Inside a repeat, each row is $item: write {{ $item.status }}.");
    expect(unknownSourceSentence("this", sources, { labels, inRepeat: true })).toContain("{{ $item.name }}");
    expect(fieldAfterRoot("{{ row.name | upper }}", "row")).toBe("name");
    expect(fieldAfterRoot("{{ $item.row }}", "row")).toBeUndefined();
  });
  it("lists sources by label and never by a d_ id", () => {
    const out = unknownSourceSentence("machines", sources, { labels });
    expect(out).toBe("There is no data source called machines. This app's sources are Machines, Proxmox, A read from Home Assistant and lights.");
    expect(out).not.toMatch(/d_[a-z0-9]/);
    // Without labels a generated id is left out, and never offered as the closest name.
    const bare = unknownSourceSentence("d_l7sio4az", ["d_l7sio4ax"]);
    expect(bare.replace("d_l7sio4az", "")).not.toMatch(/d_[a-z0-9]/);
    expect(unknownSourceSentence("row", sources, { labels })).not.toMatch(/d_[a-z0-9]/);
  });
});
