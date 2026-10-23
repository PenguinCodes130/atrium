// What a viewer's browser receives of a document (criterion 39) and the per-app manifest (criterion 47).
import { describe, expect, it } from "vitest";
import { blankDocument, newId } from "../doc";
import { viewerDocument } from "../view";
import { appManifest, appWorker } from "@/features/pwa/manifest";

function doc() {
  const d = blankDocument("Guest room");
  const other = { id: newId("p"), slug: "office", title: "Office", inNav: true, root: { id: newId("c"), type: "grid" as const, props: {}, children: [{ id: newId("c"), type: "toggle" as const, props: { label: "Office lamp", control: "k_officeaaaa" } }] } };
  d.pages.push(other);
  d.app.pageOrder.push(other.id);
  d.pages[0]!.root.children = [{ id: newId("c"), type: "toggle", props: { label: "Lamp", control: "k_lampaaaaaa", state: { $bind: '{{ ha.find("entity_id", "light.lamp").state }}' } } }];
  d.dataSources = [{ name: "ha", integrationId: "int-secret-id", endpointId: "states", params: { domain: "light" }, refreshSec: 10 }];
  d.controls = [
    { id: "k_lampaaaaaa", label: "Lamp", run: { kind: "command", integrationId: "int-secret-id", commandId: "light.toggle", params: { entityId: "light.lamp" } } },
    { id: "k_officeaaaa", label: "Office lamp", run: { kind: "command", integrationId: "int-secret-id", commandId: "light.toggle", params: { entityId: "light.office_secret" } } },
  ];
  d.chrome.css = ":scope { color: red }";
  return d;
}

describe("viewerDocument", () => {
  it("guests get one page's tree, page titles, and control labels only", () => {
    const d = doc();
    const g = viewerDocument(d, "guest", d.pages[0]!.id);
    const text = JSON.stringify(g);
    expect(text).not.toContain("int-secret-id");
    expect(text).not.toContain("light.office_secret");
    expect(text).not.toContain("Office lamp");
    expect(text).not.toContain("domain");
    expect(g.controls.map((c) => c.id)).toEqual(["k_lampaaaaaa"]);
    expect(g.pages.map((p) => p.title)).toEqual(["Home", "Office"]);
    expect(g.pages[1]!.root.children).toEqual([]);
    expect(g.chrome.css).toBeUndefined();
  });
  it("signed-in viewers lose run details and integration ids; editors get the whole document", () => {
    const d = doc();
    const v = viewerDocument(d, "viewer", d.pages[0]!.id);
    expect(JSON.stringify(v)).not.toContain("int-secret-id");
    expect(JSON.stringify(v)).not.toContain("light.office_secret");
    expect(viewerDocument(d, "editor", d.pages[0]!.id)).toBe(d);
  });
});

describe("per-app install", () => {
  it("names, icons and scope", () => {
    const m = appManifest({ slug: "guest-room", name: "Guest room" });
    // Gauntlet w2-r1 item 4: start_url, scope and the canonical address (/a/<slug>, no slash) agree.
    expect(m).toMatchObject({ id: "/a/guest-room/", start_url: "/a/guest-room", scope: "/a/guest-room", name: "Guest room", display: "standalone" });
    expect(m.icons.map((i) => i.sizes)).toEqual(["192x192", "512x512"]);
    const custom = appManifest({ slug: "x", name: "X", icon: "/uploads/abcdefghij0123456789.png" });
    expect(custom.icons[0]!.src).toBe("/uploads/abcdefghij0123456789.png");
    const w = appWorker("guest-room", "3");
    expect(w).toContain('const BASE = "/a/guest-room"');
    // The worker answers only for its own app, never for /a/guest-room-2 (a prefix of the scope string).
    const inApp = new Function("BASE", `${/const inApp = [^;]+;/.exec(w)![0]} return inApp;`)("/a/guest-room") as (p: string) => boolean;
    expect([inApp("/a/guest-room"), inApp("/a/guest-room/wall"), inApp("/a/guest-room-2"), inApp("/a/guest")]).toEqual([true, true, false, false]);
    expect(w).toContain('"atrium-cache"');
    expect(() => new Function(w)).not.toThrow(); // the generated worker parses (a bad quote once stopped it registering)
    // Item 21: the manifest's theme colour is the theme surface, the same colour the page meta uses.
    expect(m.theme_color).toBe("#F3EFE4");
  });
});
