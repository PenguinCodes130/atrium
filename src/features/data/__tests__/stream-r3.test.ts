// Round 3 data stream (spec v2 section 3.5, criteria 29 and 30; architecture v3 section 10, A1.1,
// A1.2): app pages keyed by data source name, the resolver hook, guests receiving only resolved
// values, the guest request limit and unshared integrations. Hook doubles only.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSourceDef, Principal, ReadResult } from "@/core/contracts";
import { setupTestDb } from "@/features/integrations/__tests__/db-harness";
import { appOf, guest, hookDouble, member, owner, type DoubleState } from "@/features/controls/__tests__/harness";

setupTestDb();

let current: Principal | null = null;
vi.mock("@/features/controls/request", () => ({ viewerOf: async () => current }));

const TRAFFIC = path.resolve(__dirname, "../../../../evidence/integrations/r6/traffic/guest-stream.sse.txt");
mkdirSync(path.dirname(TRAFFIC), { recursive: true });
writeFileSync(TRAFFIC, "");

let routes: typeof import("../routes");
let page: typeof import("../page");
let stream: typeof import("../stream");
let runtime: typeof import("../runtime");
let hooks: typeof import("@/core/hooks");
let svc: typeof import("@/features/integrations/service");
let haId: string;
let state: DoubleState;
let seenDraft: boolean[] = [];

const ROWS = Array.from({ length: 48 }, (_, i) => ({ entity_id: i === 0 ? "light.lamp" : i === 1 ? "light.porch" : `sensor.secret_room_${i}`, name: `Entity ${i}`, domain: i < 2 ? "light" : "sensor", state: i === 0 ? "on" : "off", attributes: "{}" }));
const table = (): ReadResult => ({ ok: true, data: { kind: "table", columns: [{ key: "entity_id", label: "Entity", type: "text" }, { key: "state", label: "State", type: "text" }], rows: ROWS }, sourceTimestamp: new Date().toISOString(), fetchedAt: new Date().toISOString() });

async function readEvents(res: Response, count: number, label: string): Promise<{ event: string; data: unknown }[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: { event: string; data: unknown }[] = [];
  const deadline = Date.now() + 3000;
  while (events.length < count && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((ok) => setTimeout(() => ok({ done: true, value: undefined }), 1000))]);
    if (r.done) break;
    const chunk = dec.decode(r.value);
    appendFileSync(TRAFFIC, `# ${label}\n${chunk}`);
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return events;
}

const req = (url: string) => new Request(`http://127.0.0.1:3113${url}`);

beforeAll(async () => {
  routes = await import("../routes");
  page = await import("../page");
  stream = await import("../stream");
  runtime = await import("../runtime");
  hooks = await import("@/core/hooks");
  svc = await import("@/features/integrations/service");
  haId = svc.createIntegration(owner, { packageId: "custom-api", name: "Lamps", config: { baseUrl: "http://127.0.0.1:9" }, secrets: {}, untested: true }).id;
  runtime.dataRuntime().scheduler.stop(); // no background fetches: the cache holds what each test seeds
});
afterAll(() => { stream.resetDataSources(); hooks.resetAppAccess(); });

const sources = (): DataSourceDef[] => [{ name: "ha", integrationId: haId, endpointId: "states", refreshSec: 30 }];

beforeEach(() => {
  stream.resetDataSources();
  hooks.resetAppAccess();
  page.resetGuestHits();
  seenDraft = [];
  state = {
    app: appOf(), controls: new Map(), draftControls: new Map(), openable: () => true, editable: (p) => p.kind === "user" && p.role === "owner",
    guestValues: async (_a, _p, src) => {
      const rows = (src.ha as { rows?: { entity_id: string; state: string }[] } | undefined)?.rows ?? [];
      return { "c_lamp:checked": rows.find((r) => r.entity_id === "light.lamp")?.state === "on", "c_porch:checked": rows.find((r) => r.entity_id === "light.porch")?.state === "on" };
    },
  };
  runtime.dataRuntime().cache.record({ integrationId: haId, endpointId: "states" }, table());
});

const registerResolver = () => stream.registerDataSources({ async page(appId, pageId, p, draft) { seenDraft.push(draft); if (appId !== "app-1" || pageId !== "p_home") return null; if (p.kind === "guest" && p.appId !== appId) return null; return sources(); } });

describe("before Wave 2 (criterion 29)", () => {
  it("with the resolver unregistered the stream and the polling route refuse and send no data", async () => {
    for (const p of [owner, guest] as Principal[]) {
      current = p;
      const s = await routes.handleStream(req("/api/data/stream?app=app-1&page=p_home"));
      const poll = await routes.handlePoll(req("/api/data/widget/app-1:ha?page=p_home"), "app-1:ha");
      for (const r of [s, poll]) {
        expect(r.status).toBe(403);
        expect(r.headers.get("content-type")).not.toMatch(/event-stream/);
        const body = await r.json();
        expect(body).toEqual({ error: { code: "not_available", message: page.NOT_AVAILABLE_MESSAGE } });
      }
    }
    current = null;
    expect((await routes.handleStream(req("/api/data/stream?app=app-1&page=p_home"))).status).toBe(401);
  });

  it("the resolver returning nothing means the viewer cannot open the app: refused, no data", async () => {
    registerResolver();
    current = owner;
    const r = await routes.handleStream(req("/api/data/stream?app=app-2&page=p_home"));
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).not.toContain("rows");
  });
});

describe("with a resolver double (criterion 30)", () => {
  it("stream values are keyed by data source name, then the polling route addresses one value by app id and source name", async () => {
    registerResolver();
    current = member;
    const events = await readEvents(await routes.handleStream(req("/api/data/stream?app=app-1&page=p_home")), 1, "member");
    expect(events[0]).toMatchObject({ event: "snapshot", data: { sources: { ha: { state: "fresh", data: { kind: "table" } } } } });
    const poll = await routes.handlePoll(req("/api/data/widget/app-1:ha?page=p_home"), "app-1:ha");
    expect(await poll.json()).toMatchObject({ key: "ha", state: "fresh", data: { kind: "table" } });
    expect((await routes.handlePoll(req("/api/data/widget/app-1:nope?page=p_home"), "app-1:nope")).status).toBe(404);
  });

  it("a guest receives only values keyed by node and prop, never a whole source's rows", async () => {
    registerResolver();
    hooks.registerAppAccess(hookDouble(state));
    current = guest;
    const res = await routes.handleStream(req("/api/data/stream?app=app-1&page=p_home"));
    const events = await readEvents(res, 1, "guest");
    expect(events).toEqual([{ event: "values", data: { values: { "c_lamp:checked": true, "c_porch:checked": false } } }]);
    const poll = await routes.handlePoll(req("/api/data/widget/app-1:ha?page=p_home"), "app-1:ha");
    const pollBody = await poll.json();
    expect(pollBody).toEqual({ values: { "c_lamp:checked": true, "c_porch:checked": false } });
    const text = JSON.stringify([events, pollBody]);
    expect(text).not.toContain("rows");
    expect(text).not.toContain("sensor.secret_room");
    expect(text).not.toContain("light.porch");
  });

  it("without the guest binding resolver a guest gets nothing, never whole sources", async () => {
    registerResolver();
    current = guest;
    const events = await readEvents(await routes.handleStream(req("/api/data/stream?app=app-1&page=p_home")), 1, "guest without resolver");
    expect(events).toEqual([{ event: "values", data: { values: {} } }]);
  });

  it("a guest of another app is refused", async () => {
    registerResolver();
    hooks.registerAppAccess(hookDouble(state));
    current = { ...guest, appId: "app-2" };
    expect((await routes.handleStream(req("/api/data/stream?app=app-1&page=p_home"))).status).toBe(403);
  });

  it("the draft flag is honoured only for editors", async () => {
    registerResolver();
    hooks.registerAppAccess(hookDouble(state));
    for (const p of [owner, member, guest] as Principal[]) {
      current = p;
      await (await routes.handleStream(req("/api/data/stream?app=app-1&page=p_home&draft=1"))).body?.cancel();
    }
    expect(seenDraft).toEqual([true, false, false]);
  });

  it("guest stream and poll requests are limited to 120 per minute per guest session", async () => {
    registerResolver();
    current = guest;
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) statuses.push((await routes.handlePoll(req("/api/data/widget/app-1:ha?page=p_home"), "app-1:ha")).status);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    const last = await routes.handleStream(req("/api/data/stream?app=app-1&page=p_home"));
    expect(statuses[120]).toBe(429);
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBeTruthy();
    // Signed-in users are not counted by the guest limit.
    current = owner;
    expect((await routes.handlePoll(req("/api/data/widget/app-1:ha?page=p_home"), "app-1:ha")).status).toBe(200);
  });

  it("an unshared integration in an app others can edit shows 'No data: this integration is no longer shared' and sends no rows (A1.1)", async () => {
    registerResolver();
    state.app = appOf({ access: { view: "everyone", edit: "everyone", guests: false } });
    hooks.registerAppAccess(hookDouble(state));
    current = member;
    const events = await readEvents(await routes.handleStream(req("/api/data/stream?app=app-1&page=p_home")), 1, "unshared");
    expect(events[0]).toEqual({ event: "snapshot", data: { sources: { ha: { state: "failed", refreshSec: 30, error: { code: "permission", message: "No data: this integration is no longer shared" } } } } });
    svc.updateIntegration(owner, haId, { shared: true });
    const shared = await readEvents(await routes.handleStream(req("/api/data/stream?app=app-1&page=p_home")), 1, "shared");
    expect(shared[0]).toMatchObject({ data: { sources: { ha: { state: "fresh" } } } });
    svc.updateIntegration(owner, haId, { shared: false });
  });
});
