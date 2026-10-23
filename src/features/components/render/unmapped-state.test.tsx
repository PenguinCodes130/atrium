// SFR-A from app-builder round 2: an unconnected source shows its message as the title and links to
// where it gets connected; only the app's own paths become links.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StateBody } from "./states";

describe("unconnected source state", () => {
  it("titles with the message and links to the hint", () => {
    const html = renderToStaticMarkup(<StateBody status={{ kind: "empty", message: "No data: connect Docker", href: "/integrations/new/docker" }} />);
    expect(html).toContain("No data: connect Docker");
    expect(html).toContain('href="/integrations/new/docker"');
    expect(html).not.toContain("No data yet");
  });
  it("keeps the plain empty state without a link", () => {
    const html = renderToStaticMarkup(<StateBody status={{ kind: "empty", message: "Nothing here" }} />);
    expect(html).toContain("No data yet");
    expect(html).not.toContain("<a");
  });
});
