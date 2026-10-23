import { describe, expect, it, vi } from "vitest";
import { handleFrameMessage, codeFieldProblem, imagesProblem, type BridgeState } from "./sandbox/bridge";
import { createControlRunner, draftConfirmText } from "./control-runner";
import { allowedFrameOrigin, frameHeaders, frameDocument } from "./sandbox/frame-doc";

const state = (over: Partial<BridgeState> = {}): BridgeState => ({ listed: ["k_listedaaaa"], inDocument: ["k_listedaaaa", "k_otheraaaaa"], pages: [{ id: "p_detailaaaa", slug: "detail" }], height: "auto", recent: [], ...over });

describe("bridge host rules (criteria 53, 54, 56)", () => {
  it("drops a control not in the block's list or not in the document", () => {
    expect(handleFrameMessage({ t: "control", reqId: "1", controlId: "k_otheraaaaa" }, state(), 0).kind).toBe("drop");
    expect(handleFrameMessage({ t: "control", reqId: "1", controlId: "k_listedaaaa" }, state({ inDocument: [] }), 0).kind).toBe("drop");
    expect(handleFrameMessage({ t: "control", reqId: "1", controlId: "k_listedaaaa", input: 5 }, state(), 0)).toEqual({ kind: "control", reqId: "1", controlId: "k_listedaaaa", input: 5 });
  });
  it("drops the eleventh request in 10 seconds, then allows again", () => {
    const s = state();
    const kinds = Array.from({ length: 11 }, (_, i) => handleFrameMessage({ t: "control", reqId: String(i), controlId: "k_listedaaaa" }, s, 1000 + i).kind);
    expect(kinds.slice(0, 10).every((k) => k === "control")).toBe(true);
    expect(kinds[10]).toBe("drop");
    expect(handleFrameMessage({ t: "control", reqId: "x", controlId: "k_listedaaaa" }, s, 11_100).kind).toBe("control");
  });
  it("ignores messages over 256 KB", () => {
    const big = { t: "log", level: "info", message: "x".repeat(300 * 1024) };
    expect(handleFrameMessage(big, state(), 0)).toEqual({ kind: "drop", reason: "message over 256 KB" });
  });
  it("honours resize only for auto height, capped at 4000", () => {
    expect(handleFrameMessage({ t: "resize", height: 6000 }, state(), 0)).toEqual({ kind: "resize", height: 4000 });
    expect(handleFrameMessage({ t: "resize", height: 6000 }, state({ height: 300 }), 0).kind).toBe("drop");
  });
  it("navigates only to a page slug of the same app", () => {
    expect(handleFrameMessage({ t: "navigate", page: "detail" }, state(), 0)).toEqual({ kind: "navigate", pageId: "p_detailaaaa" });
    expect(handleFrameMessage({ t: "navigate", page: "other-app/home" }, state(), 0).kind).toBe("drop");
    expect(handleFrameMessage({ t: "navigate", page: "nope" }, state(), 0).kind).toBe("drop");
  });
  it("drops unknown and malformed messages", () => {
    for (const m of [null, 5, "x", [], { t: "eval" }, { t: "control" }, { t: "resize", height: "a" }]) expect(handleFrameMessage(m, state(), 0).kind).toBe("drop");
  });
  it("limits code fields to 64 KB and images to 2 MB, naming the limit", () => {
    expect(codeFieldProblem("js", "x".repeat(64 * 1024 + 1))).toMatch(/64 KB/);
    expect(codeFieldProblem("js", "x".repeat(1000))).toBeNull();
    expect(imagesProblem([1_500_000, 700_000])).toMatch(/2 MB/);
    expect(imagesProblem([1_000_000])).toBeNull();
  });
});

describe("control runner (criteria 20 to 22, 55)", () => {
  const controls = { k_lampaaaaaa: { label: "Bedroom lamp" }, k_draftonly: { label: "New scene", draftOnly: true }, k_confirmaa: { label: "Reboot", confirm: "Reboot the NAS?" } };
  function setup(mode: "view" | "draft-preview" | "agent-render" | "edit", answer = true) {
    const posts: unknown[] = [];
    const confirm = vi.fn(async () => answer);
    const run = createControlRunner({ appId: "app1", mode, controls, confirm, fetch: async (_u, init) => { posts.push(JSON.parse(init.body)); return { status: 200, json: async () => ({ ok: true }) }; } });
    return { run, posts, confirm };
  }
  it("in render mode never sends", async () => {
    const s = setup("agent-render");
    expect((await s.run("c_x", "k_lampaaaaaa", true)).ok).toBe(false);
    expect(s.posts).toEqual([]);
  });
  it("in a draft preview always confirms first, then sends draft and confirmed", async () => {
    const s = setup("draft-preview");
    await s.run("c_x", "k_lampaaaaaa", true);
    expect(s.confirm).toHaveBeenCalledWith(draftConfirmText("Bedroom lamp"));
    expect(s.posts).toEqual([{ appId: "app1", nodeId: "c_x", controlId: "k_lampaaaaaa", input: true, draft: true, confirmed: true }]);
    await s.run("c_x", "k_draftonly");
    expect(s.confirm).toHaveBeenLastCalledWith("Draft preview: run New scene for real? Not published yet.");
  });
  it("sends nothing when the draft confirm is cancelled", async () => {
    const s = setup("draft-preview", false);
    const r = await s.run("c_x", "k_lampaaaaaa");
    expect(r.ok).toBe(false);
    expect(s.posts).toEqual([]);
  });
  it("opens the control's own confirm text in view mode and never marks confirmed", async () => {
    const s = setup("view");
    await s.run("c_x", "k_confirmaa");
    expect(s.confirm).toHaveBeenCalledWith("Reboot the NAS?");
    expect(s.posts).toEqual([{ appId: "app1", nodeId: "c_x", controlId: "k_confirmaa" }]);
  });
  it("passes the server's refusal message through", async () => {
    const run = createControlRunner({ appId: "a", mode: "view", controls, confirm: async () => true, fetch: async () => ({ status: 403, json: async () => ({ ok: false, code: "not_shared", message: "No data: this integration is no longer shared" }) }) });
    expect(await run("c_x", "k_lampaaaaaa", true)).toEqual({ ok: false, code: "not_shared", message: "No data: this integration is no longer shared" });
  });
});

describe("frame document and headers (criteria 50, 51 static part)", () => {
  it("carries the sandbox CSP, DNS prefetch off and framing by this origin only", () => {
    const h = frameHeaders("http://127.0.0.1:3114");
    expect(h["X-DNS-Prefetch-Control"]).toBe("off");
    const csp = h["Content-Security-Policy"]!;
    for (const d of ["sandbox allow-scripts", "default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "webrtc 'block'", "img-src data: blob:", "frame-ancestors http://127.0.0.1:3114"]) expect(csp).toContain(d);
    expect(csp).not.toContain("allow-same-origin");
  });
  it("accepts only the public URL and LAN origins", () => {
    expect(allowedFrameOrigin("http://127.0.0.1:3114", "http://127.0.0.1:3114", undefined)).toBe("http://127.0.0.1:3114");
    expect(allowedFrameOrigin("http://10.0.0.5:3102", "https://atrium.example", "http://10.0.0.5:3102, http://atrium.lan")).toBe("http://10.0.0.5:3102");
    expect(allowedFrameOrigin("https://evil.example", "https://atrium.example", "http://10.0.0.5:3102")).toBeNull();
  });
  it("is the same static document for every block, with no data in it", () => {
    expect(frameDocument()).toBe(frameDocument());
    expect(frameDocument()).not.toMatch(/token|secret|password/i);
  });
});
