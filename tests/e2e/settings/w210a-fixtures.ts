// Wave 2.10a theme e2e fixtures (builder S), shared by k-w210a-themes and l-w210a-r2-themes: themes
// made through the real API (Control Room, Dusk, Solid and the frosted custom theme with a FAKE image
// wallpaper), a published app on a theme, and editor helpers. Test-only values; none are real credentials.
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { ORIGIN, OWNER, stateFor } from "./helpers";

// ---- fixtures ----

export function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// A FAKE wallpaper: a soft blue to amber wash with stripes, like a photo seen through glass.
export const FAKE_WALLPAPER = png(96, 64, (x, y) => [Math.round(60 + x * 1.8), Math.round(90 + y * 1.2), (x + y) % 16 < 8 ? 200 : 150]);

export async function api(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), extraHTTPHeaders: { origin: ORIGIN } });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixtures edit a theme document loosely
export type Doc = Record<string, any>;
export async function themeFrom(a: APIRequestContext, base: string, name: string, patch: (t: Doc) => void = () => {}): Promise<string> {
  const dup = await a.post(`/api/settings/themes/${base}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(300);
  const id = (await dup.json()).id as string;
  await saveTheme(a, id, (t) => { t.name = name; patch(t); });
  return id;
}
export async function saveTheme(a: APIRequestContext, id: string, patch: (t: Doc) => void): Promise<Doc> {
  const cur = await (await a.get(`/api/settings/themes/${id}`)).json();
  const theme = structuredClone(cur.theme);
  patch(theme);
  const put = await a.put(`/api/settings/themes/${id}`, { data: { theme, rev: cur.rev } });
  expect(put.status(), await put.text()).toBe(200);
  return theme;
}
/** The frosted custom theme (the operator's own kind): FAKE image wallpaper, glass 0.3, blur 1, soft shadow, 1 px border. */
export async function frostedTheme(a: APIRequestContext, name: string): Promise<string> {
  const up = await a.post("/api/settings/uploads", { multipart: { accept: "image", file: { name: "fake-wallpaper-e2e.png", mimeType: "image/png", buffer: FAKE_WALLPAPER } } });
  expect(up.status(), await up.text()).toBe(201);
  const path = (await up.json()).path as string;
  return themeFrom(a, "control-room", name, (t) => {
    t.tokens.wallpaper = { kind: "image", value: path, blurPx: 0, dim: 0.2, grain: 0 };
    t.tokens.surface = { ...t.tokens.surface, material: "glass", opacity: 0.3, blurPx: 1, shadow: "soft", shadowOffsetPx: 0, border: { widthPx: 1, color: "#FFFFFF66" }, titleBars: false };
    t.tokens.color = { ...t.tokens.color, surfaceText: "#0E0D0A", surfaceMuted: "#2A2722", canvasText: "#0E0D0A" };
    t.tokens.shape = { radiusPx: 14, controlRadiusPx: 8 };
  });
}
export const THEMES: { label: string; make(a: APIRequestContext): Promise<string> }[] = [
  { label: "control-room", make: (a) => themeFrom(a, "control-room", `w210 Control Room ${tag()}`) },
  { label: "dusk", make: (a) => themeFrom(a, "dusk", `w210 Dusk ${tag()}`) },
  { label: "solid", make: (a) => themeFrom(a, "solid", `w210 Solid ${tag()}`) },
  { label: "frosted", make: (a) => frostedTheme(a, `w210 Frosted ${tag()}`) },
];
export function tag() { return randomBytes(2).toString("hex"); }
export function rid(prefix: "c" | "p") {
  const abc = "abcdefghijklmnopqrstuvwxyz234567";
  return `${prefix}_${[...randomBytes(10)].map((b) => abc[b % 32]).join("")}`;
}
export const emptyPage = (title: string, slug: string) => ({ id: rid("p"), slug, title, inNav: true, root: { id: rid("c"), type: "grid", props: {}, children: [] } });

/** An app with three pages in the nav, a card with a stat, a stat beside it and a button, on this theme. */
export async function makeApp(a: APIRequestContext, themeId: string): Promise<{ id: string; slug: string }> {
  const slug = `w210-${randomBytes(3).toString("hex")}`;
  const created = await a.post("/api/apps", { data: { name: "Homelab", slug, template: "blank" } });
  expect(created.status(), await created.text()).toBe(201);
  const app = (await created.json()).app;
  const d = await (await a.get(`/api/apps/${app.id}/draft`)).json();
  const root = d.doc.pages[0].root.id as string;
  const ops = [
    { op: "theme.set", theme: { themeId } },
    { op: "page.add", page: emptyPage("Rack", "rack") },
    { op: "page.add", page: emptyPage("Power", "power") },
    { op: "node.add", parentId: root, node: { id: rid("c"), type: "card", props: { title: "Rack" }, slot: { x: 0, y: 0, w: 6, h: 20 }, children: [{ id: rid("c"), type: "stat", props: { value: 42, label: "CPU" } }] } },
    { op: "node.add", parentId: root, node: { id: rid("c"), type: "stat", props: { value: 7, label: "Disks" }, slot: { x: 6, y: 0, w: 3, h: 12 } } },
    { op: "node.add", parentId: root, node: { id: rid("c"), type: "button", props: { label: "Run scene" }, slot: { x: 9, y: 0, w: 3, h: 8 } } },
  ];
  const r = await a.post(`/api/apps/${app.id}/ops`, { data: { rev: d.rev, ops } });
  expect(r.status(), await r.text()).toBe(200);
  await publish(a, app.id);
  return { id: app.id, slug };
}
export async function publish(a: APIRequestContext, appId: string) {
  const d = await (await a.get(`/api/apps/${appId}/draft`)).json();
  const pub = await a.post(`/api/apps/${appId}/publish`, { data: { expectRev: d.rev, note: "w210a" } });
  expect(pub.status(), await pub.text()).toBe(200);
}

// ---- editor helpers ----

export async function openEditor(page: Page, id: string) {
  await page.goto(`/settings/themes/${id}`);
  await expect(page.locator("[data-theme-editor]")).toBeVisible();
}
export async function openGroup(page: Page, name: string) {
  const g = page.locator(`[data-group="${name}"]`);
  if ((await g.getAttribute("data-open")) !== "true") await page.locator(`[data-group-toggle="${name}"]`).click();
  await expect(g).toHaveAttribute("data-open", "true");
}
/** A choice by its label (or its stored value, as older editors labelled them). */
export const radio = (page: Page, field: string, label: string, value = label) => page.locator(`[data-field="${field}"] [role="radio"]`, { hasText: new RegExp(`^(${label}|${value})$`, "i") });

