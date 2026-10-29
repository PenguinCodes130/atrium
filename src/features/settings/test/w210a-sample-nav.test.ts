// Wave 2.10a B5: the theme preview draws the app viewer's own nav markup. This renders app-builder's
// AppChrome (top bar) and the sample's SampleNav for the same three pages and compares the HTML, so the
// preview can never drift from what an app draws.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppDocument, PageDoc } from "@/core/contracts";
import { AppChrome } from "@/features/builder/app-frame";
import { SAMPLE_PAGES, SAMPLE_TITLE, SampleNav } from "@/features/themes/ui/theme-sample";

describe("B5 sample nav", () => {
  it("matches the viewer's top bar nav markup", () => {
    const pages: PageDoc[] = SAMPLE_PAGES.map((p, i) => ({ id: `p_sample000${i}`, slug: p.slug, title: p.title, inNav: true, root: { id: `c_sample000${i}`, type: "grid", props: {}, children: [] } }));
    const doc = { format: "atrium-app", formatVersion: 1, app: { name: SAMPLE_TITLE, homePage: pages[0]!.id, pageOrder: pages.map((p) => p.id) }, theme: { themeId: "control-room" }, chrome: { layout: "topbar", title: SAMPLE_TITLE }, dataSources: [], controls: [], pages } as unknown as AppDocument;
    const viewer = renderToStaticMarkup(createElement(AppChrome, { doc, current: pages[0]!.id, hrefFor: (p: PageDoc) => `#${p.slug}` }));
    const sample = renderToStaticMarkup(createElement(SampleNav, {}));
    // Same elements, attributes and text; attribute order is not markup (next/link writes href last).
    const norm = (html: string) => html.replace(/<([a-z]+)((?:\s+[a-z-]+="[^"]*")*)\s*>/g, (_m, tag: string, attrs: string) => `<${tag}${(attrs.match(/[a-z-]+="[^"]*"/g) ?? []).sort().map((a) => ` ${a}`).join("")}>`);
    expect(norm(sample)).toBe(norm(viewer));
    expect(sample).toContain('href="#rack"');
  });
});
