// Wave 2.8 recipes, the app-builder side (recipes spec 3.1 last bullet, 3.2 bullets 3 and 4; criteria 4
// and 5): which sources fail their live check, the Show all reads words, and the publish review's
// warning on widgets bound to a failing read.
import { describe, expect, it } from "vitest";
import type { AppDocument, ComponentNode, DataSourceDef } from "@/core/contracts";
import { blankDocument } from "@/features/apps/doc";
import { reviewWarnings } from "@/features/apps/review-warnings";
import { failedReadReason, failingSources } from "../data-pick";
import { showAllWords } from "../data-picker";

function docWith(nodes: ComponentNode[], sources: DataSourceDef[]): AppDocument {
  const d = blankDocument("T");
  d.pages[0]!.root.children = nodes;
  d.dataSources = sources;
  return d;
}
const src = (name: string, endpointId: string, extra: Partial<DataSourceDef> = {}): DataSourceDef => ({ name, integrationId: "prom", endpointId, refreshSec: 30, ...extra });
const at = "2026-10-20T10:00:00.000Z";
const listing = [{
  integrationId: "prom", integrationName: "Prometheus",
  endpoints: [
    { id: "r:lab/x:load", check: { status: "ok", at } },
    { id: "r:lab/x:missing", check: { status: "failed", reason: "HTTP 404 from the server", at } },
    { id: "r:lab/x:quiet", check: { status: "failed", at } },
    { id: "r:lab/x:empty", check: { status: "empty", at } },
    { id: "machine-cpu" },
  ],
}];

describe("failing reads (A9.2)", () => {
  it("names the reason of a read whose last check failed, and nothing for the rest", () => {
    expect(failedReadReason(src("a", "r:lab/x:missing"), listing)).toBe("HTTP 404 from the server");
    expect(failedReadReason(src("a", "r:lab/x:quiet"), listing)).toBe("This read stopped working.");
    for (const id of ["r:lab/x:load", "r:lab/x:empty", "machine-cpu", "not-listed"]) expect(failedReadReason(src("a", id), listing)).toBeNull();
    expect(failedReadReason({ integrationId: "other", endpointId: "r:lab/x:missing" }, listing)).toBeNull();
  });
  it("maps the app's failing sources by name", () => {
    const doc = docWith([], [src("load", "r:lab/x:load"), src("gone", "r:lab/x:missing"), src("cpu", "machine-cpu")]);
    expect(failingSources(doc, listing)).toEqual({ gone: "HTTP 404 from the server" });
    expect(failingSources(doc, [])).toEqual({});
  });
});

describe("Show all reads words", () => {
  it("say how many reads are hidden and why", () => {
    expect(showAllWords([])).toBe("Show all reads");
    expect(showAllWords([{}, {}])).toBe("Show all reads (2 need data this service does not have)");
    expect(showAllWords([{}, { check: { status: "failed", reason: "x", at } }])).toBe("Show all reads (1 need data this service does not have; 1 did not work on this server)");
    expect(showAllWords([{ check: { status: "failed", at } }])).toBe("Show all reads (1 did not work on this server)");
  });
});

describe("publish review: a widget bound to a failing read (criterion 5)", () => {
  const doc = docWith([
    { id: "c_statgoneaa", type: "stat", props: { data: { $bind: "{{ gone }}" } }, slot: { x: 0, y: 0, w: 3, h: 16 } },
    { id: "c_textgoneaa", type: "text", props: { text: { $bind: "{{ gone.value }} and {{ load.value }}" } }, slot: { x: 3, y: 0, w: 3, h: 8 } },
    { id: "c_statloadaa", type: "stat", props: { data: { $bind: "{{ load }}" } }, slot: { x: 6, y: 0, w: 3, h: 16 } },
    { id: "c_textplaina", type: "text", props: { text: "hello" }, slot: { x: 9, y: 0, w: 3, h: 8 } },
  ], [src("gone", "r:lab/x:missing", { label: "Lab read" }), src("load", "r:lab/x:load")]);
  const w = reviewWarnings(doc, (n) => (n === "gone" ? { failed: "HTTP 404 from the server" } : {}));
  it("warns once per widget that reads it, naming the component, the source and the reason", () => {
    const failed = w.filter((p) => p.code === "data.read_failed");
    expect(failed.map((p) => p.where.nodeId)).toEqual(["c_statgoneaa", "c_textgoneaa"]);
    expect(failed[0]!.severity).toBe("warning");
    expect(failed[0]!.where.pageId).toBe(doc.pages[0]!.id);
    expect(failed[0]!.message).toContain("reads Lab read, which stopped working on its server: HTTP 404 from the server.");
    expect(failed[0]!.fix).toBe("Open its Data group and pick another read, or check the integration.");
  });
  it("says nothing when no read fails", () => {
    expect(reviewWarnings(doc, () => ({})).some((p) => p.code === "data.read_failed")).toBe(false);
  });
});
