// Round 3 test harness: a local fake Home Assistant (never a real one) and a double of the
// app-access hook that app-builder registers in Wave 2. Test-only values; none are real credentials.
import type { App, AppAccessResolver, ComponentNode, ControlDef, Principal } from "@/core/contracts";
import { httpServer, json } from "@/features/integrations/host/__tests__/servers";

export const HA_TOKEN = "atrium-r3-FAKE-ha-token-6b86b273ff34fce1";

export const owner: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
export const member: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-member", role: "member", via: "session" };
export const otherMember: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-member-2", role: "member", via: "session" };
export const viewer: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-viewer", role: "viewer", via: "session" };
export const guest: Extract<Principal, { kind: "guest" }> = { kind: "guest", guestLinkId: "gl-1", appId: "app-1", label: "Guest room, Sam", via: "guest-link" };
export const agent: Principal = { kind: "agent", userId: "u-owner", role: "owner", via: "pat", tokenId: "t1", agentName: "Claude", scopes: ["atrium:read", "atrium:edit"] };

export const STATES = [
  { entity_id: "light.lamp", state: "off", attributes: { friendly_name: "Bedroom lamp" } },
  { entity_id: "light.porch", state: "on", attributes: { friendly_name: "Porch" } },
  { entity_id: "switch.fan", state: "off", attributes: { friendly_name: "Fan plug" } },
  { entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "Front door" } },
];

export type FakeHa = Awaited<ReturnType<typeof fakeHomeAssistant>>;

/** A fake Home Assistant: service calls are recorded with their bodies and auth; states flip on toggle. */
export async function fakeHomeAssistant(opts: { delayMs?: number } = {}) {
  const calls: { method: string; path: string; body: unknown; authOk: boolean }[] = [];
  let inFlight = 0;
  let peak = 0;
  const lamp = { on: false };
  const server = await httpServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const authOk = req.headers.authorization === `Bearer ${HA_TOKEN}`;
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      if (u.pathname === "/api/" && !authOk) return json(res, 401, { message: "401: Unauthorized" });
      if (!authOk) return json(res, 401, { message: "401: Unauthorized" });
      if (u.pathname === "/api/config") return json(res, 200, { version: "2026.10.1", location_name: "Home" });
      if (u.pathname === "/api/states") return json(res, 200, STATES.map((s) => (s.entity_id === "light.lamp" ? { ...s, state: lamp.on ? "on" : "off" } : s)));
      const m = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(u.pathname);
      if (m) {
        let body: unknown = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        calls.push({ method: req.method ?? "", path: u.pathname, body, authOk });
        inFlight++;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight--;
          if ((body as { entity_id?: string })?.entity_id === "light.lamp" && m[2] === "toggle") lamp.on = !lamp.on;
          json(res, 200, []);
        }, opts.delayMs ?? 0);
        return;
      }
      json(res, 404, { message: "not found" });
    });
  });
  return { ...server, calls, peak: () => peak, lamp };
}

export function node(type: ComponentNode["type"], props: ComponentNode["props"], id = "c_node00001"): ComponentNode {
  return { id, type, props };
}

export type DoubleState = {
  app: App;
  controls: Map<string, { control: ControlDef; node: ComponentNode; version: number }>;
  draftControls: Map<string, { control: ControlDef; node: ComponentNode }>;
  openable: (p: Principal) => boolean;
  editable: (p: Principal) => boolean;
  guestValues?: AppAccessResolver["guestValues"];
};

export function appOf(over: Partial<App> = {}): App {
  return { id: "app-1", slug: "home", name: "Home", access: { view: "everyone", edit: "owner", guests: true }, publishedVersion: 3, draftRev: 12, createdBy: "u-owner", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...over };
}

/** A double of app-builder's resolver: one app, controls keyed by `${controlId}|${nodeId}`. */
export function hookDouble(state: DoubleState): AppAccessResolver {
  return {
    async appBySlug(slug) { return slug === state.app.slug ? state.app : null; },
    async appById(id) { return id === state.app.id ? state.app : null; },
    async appsFor(p) { return p.kind === "guest" ? [] : [state.app]; },
    async guestValues(appId, pageId, sources) { return state.guestValues ? state.guestValues(appId, pageId, sources) : {}; },
    async canOpenApp(p, appId) { return appId === state.app.id && (p.kind !== "guest" || p.appId === appId) && state.openable(p); },
    async canEditApp(p, appId) { return appId === state.app.id && p.kind !== "guest" && state.editable(p); },
    async publishedControl(appId, controlId, nodeId, opts) {
      if (appId !== state.app.id) return null;
      const k = `${controlId}|${nodeId}`;
      if (opts.draft) {
        const d = state.draftControls.get(k) ?? state.controls.get(k);
        return d ? { version: 0, control: d.control, node: d.node } : null;
      }
      return state.controls.get(k) ?? null;
    },
  };
}
