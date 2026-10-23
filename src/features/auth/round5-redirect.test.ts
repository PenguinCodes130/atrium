import { describe, expect, it, vi } from "vitest";
import { safeNext } from "./server/step-up";

// Round 5, fix list item 1 (gauntlet r3, security): the open redirect off the sign-in screen.
// Each value is what the page receives after Next decodes the query string once, so "/\t/evil" is
// what `?next=/%09/evil` arrives as. Browsers drop tab, newline and carriage return from URLs, so
// "/\t/evil" would become the protocol-relative "//evil".

vi.setConfig({ testTimeout: 30_000 });

const EVIL: [string, string][] = [
  ["tab (%09)", "/\t/evil.example/phish"],
  ["newline (%0a)", "/\n/evil.example/phish"],
  ["carriage return (%0d)", "/\r/evil.example/phish"],
  ["tab inside the second slash pair", "/\t\t//evil.example"],
  ["leading tab", "\t//evil.example"],
  ["backslash", "/\\evil.example"],
  ["backslash after a tab", "/\t\\evil.example"],
  ["backslash later in the path", "/a\\..\\\\evil.example"],
  ["double-encoded tab (%2509)", "/%09/evil.example"],
  ["double-encoded newline (%250a)", "/%0a/evil.example"],
  ["double-encoded carriage return (%250D)", "/%0D/evil.example"],
  ["double-encoded slash (%252F)", "/%2F/evil.example"],
  ["double-encoded backslash (%255c)", "/%5c/evil.example"],
  ["triple-encoded tab", "/%2509/evil.example"],
  ["encoded slashes only", "%2F%2Fevil.example"],
  ["protocol relative", "//evil.example"],
  ["scheme", "https://evil.example"],
  ["javascript scheme", "javascript:alert(1)"],
  ["no leading slash", "evil.example"],
  ["NUL", "/\u0000/evil.example"],
  ["DEL", "/\u007f/evil.example"],
  ["space", "/ /evil.example"],
  ["unicode space", "/　/evil.example"],
  ["empty", ""],
];

describe("fix 1: safeNext refuses every redirect that could leave this Atrium", () => {
  for (const [name, value] of EVIL) {
    it(`${name} falls back to /`, () => {
      expect(safeNext(value)).toBe("/");
    });
  }

  it("non-strings fall back to /", () => {
    for (const v of [undefined, null, 1, ["/account"], { a: 1 }]) expect(safeNext(v)).toBe("/");
  });

  it("round 6: percent-encodes raw characters above U+007E instead of refusing them (Next hands them over decoded)", () => {
    expect(safeNext("/caf\u00e9")).toBe("/caf%C3%A9");
    expect(safeNext("/x?q=caf\u00e9")).toBe("/x?q=caf%C3%A9");
    expect(safeNext("/x?q=caf%C3%A9")).toBe("/x?q=caf%C3%A9");
    expect(safeNext("/\u65e5\u672c?q=\u{1f600}")).toBe("/%E6%97%A5%E6%9C%AC?q=%F0%9F%98%80");
    // Look-alike slashes and zero-width characters stay inside the path once encoded.
    expect(safeNext("/\uff0f\uff0fevil.example")).toBe("/%EF%BC%8F%EF%BC%8Fevil.example");
    expect(safeNext("/\u200b/evil")).toBe("/%E2%80%8B/evil");
    expect(safeNext("/%E2%80%8B/evil")).toBe("/%E2%80%8B/evil");
  });

  it("round 6: still refuses Unicode whitespace and C1 controls, raw or encoded, and lone surrogates", () => {
    for (const raw of ["/\u2028/evil", "/\u00a0/evil", "/a\u3000b", "/a\ufeffb", "/a\u0085b", "/a\u009bb", "/%C2%A0/evil", "/%E2%80%A8x", "/%C2%85x", "/a\ud800b"]) {
      expect(safeNext(raw), JSON.stringify(raw)).toBe("/");
    }
  });

  it("round 6: whatever it returns is printable ASCII, so it can always sit in a Location header", () => {
    const samples = ["/caf\u00e9", "/x?q=\u00fc\u00df", "/\u{1f600}", "/a#\u00e9", ...EVIL.map(([, v]) => v)];
    for (const v of samples) {
      const out = safeNext(v);
      expect(out, JSON.stringify(v)).toMatch(/^[\u0021-\u007e]+$/);
      expect(() => new Headers({ location: out })).not.toThrow();
    }
  });

  it("keeps ordinary same-origin paths, with their query and hash", () => {
    for (const ok of ["/", "/account", "/integrations?view=credentials", "/a/lounge#controls", "/consent?client_id=abc&sig=x.y", "/search?q=100%25"]) {
      expect(safeNext(ok)).toBe(ok);
    }
  });

  it("whatever it returns resolves to this origin in a URL parser, the way a browser would", () => {
    const base = "http://127.0.0.1:3111";
    for (const [, value] of EVIL) {
      const out = safeNext(value);
      const stripped = out.replace(/[\t\n\r]/g, ""); // what a browser does before parsing
      expect(new URL(stripped, base).origin).toBe(base);
    }
  });
});
