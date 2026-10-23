// TEMPORARY test harness data for the component gallery (/library/gallery): a sample app document
// holding every catalogue type, sample data in every state, and the fixed sandbox probe blocks used
// by the e2e sandbox suite. Probe code is chosen by name from this file, never taken from the URL;
// only validated port numbers and a [a-z0-9] DNS label are filled in.
import type { AppDocument, ComponentNode, PageDoc, ShapedData } from "@/core/contracts";

export type GallerySource = { state: "fresh" | "stale" | "failed" | "empty"; data?: ShapedData; sourceTimestamp?: string; fetchedAt?: string; refreshSec: number; error?: { code: string; message: string; hint?: string } };

const b = (t: string) => ({ $bind: t });
const now = Date.UTC(2026, 9, 18, 10, 0, 0);
const pts = (seed: number, n = 24, nullAt = -1): [number, number | null][] => Array.from({ length: n }, (_, i) => [now - (n - i) * 300_000, i === nullAt ? null : Math.round((30 + seed * 7 + 18 * Math.sin((i + seed) / 3)) * 10) / 10]);

export const GALLERY_CONTROLS = { lamp: "k_lampaaaaaa", scene: "k_sceneaaaaa", draftOnly: "k_draftonlyx", dim: "k_dimmeraaaa", mode: "k_modeaaaaaa" } as const;

export function gallerySources(series = 3): Record<string, GallerySource> {
  return {
    cpu: { state: "fresh", refreshSec: 15, sourceTimestamp: new Date(now).toISOString(), data: { kind: "stat", value: 41.27, unit: "%", label: "CPU", delta: { value: -2.5, period: "1h" }, thresholds: { warn: 70, bad: 90 } } },
    temp: { state: "fresh", refreshSec: 15, data: { kind: "stat", value: 75, unit: "°C", label: "NAS temperature", thresholds: { warn: 70, bad: 90 } } },
    disk: { state: "fresh", refreshSec: 60, data: { kind: "stat", value: 95, unit: "%", label: "Disk", thresholds: { warn: 70, bad: 90 } } },
    load: { state: "fresh", refreshSec: 15, data: { kind: "series", unit: "%", series: Array.from({ length: series }, (_, i) => ({ name: `pve${i + 1}`, points: pts(i, 24, i === 0 ? 10 : -1) })) } },
    hosts: {
      state: "fresh", refreshSec: 30,
      data: {
        kind: "table",
        columns: [{ key: "name", label: "Name", type: "text" }, { key: "cpu", label: "CPU %", type: "number" }, { key: "state", label: "State", type: "status" }, { key: "url", label: "Open", type: "link" }],
        rows: Array.from({ length: 20 }, (_, i) => ({ name: `vm-${String(i + 1).padStart(2, "0")}`, cpu: (i * 7) % 100, state: i % 7 === 3 ? "down" : i % 5 === 2 ? "warn" : "up", url: `https://10.0.0.${i + 10}:8006` })),
        total: 312,
      },
    },
    services: { state: "fresh", refreshSec: 30, data: { kind: "status", items: [{ label: "Nginx Proxy Manager", state: "up" }, { label: "Uptime Kuma", state: "down", detail: "timeout after 10s" }, { label: "Pi-hole", state: "warn", detail: "slow" }, { label: "Jellyfin", state: "unknown" }] } },
    lamps: { state: "fresh", refreshSec: 5, data: { kind: "table", columns: [{ key: "entity", label: "Entity", type: "text" }, { key: "state", label: "State", type: "text" }, { key: "brightness", label: "Brightness", type: "number" }], rows: [{ entity: "light.desk", state: "off", brightness: 128 }, { entity: "light.bed", state: "on", brightness: 200 }] } },
    stale: { state: "stale", refreshSec: 15, fetchedAt: new Date(now - 600_000).toISOString(), data: { kind: "stat", value: 12, unit: "ms", label: "Ping (stale)" } },
    failed: { state: "failed", refreshSec: 15, data: { kind: "stat", value: 3, label: "Containers (failed)" }, error: { code: "timeout", message: "Timed out reaching the Docker proxy", hint: "Check that the socket proxy is running." } },
    empty: { state: "empty", refreshSec: 15, error: { code: "unreachable", message: "Cannot reach 10.77.99.9" } },
    unshared: { state: "failed", refreshSec: 15, error: { code: "permission", message: "No data: this integration is no longer shared" } },
  };
}

let seq = 0;
const id = (s: string) => `c_${(s.replace(/[^a-z]/g, "") + "aaaaaaaaaa").slice(0, 10)}`;
const n = (type: ComponentNode["type"], key: string, props: ComponentNode["props"], slot: [number, number, number, number], extra: Partial<ComponentNode> = {}): ComponentNode => {
  seq++;
  // Only the first node has an explicit phone slot; the rest stack in order at phone width.
  return { id: id(key), type, props, slot: { x: slot[0], y: slot[1], w: slot[2], h: slot[3] }, ...(seq === 1 ? { responsive: { mobile: { slot: { x: 0, y: 0, w: 4, h: slot[3] } } } } : {}), ...extra };
};

/** Every catalogue type on one page (V4, V5, E3). */
export function everyTypePage(): PageDoc {
  seq = 0;
  const children: ComponentNode[] = [
    n("heading", "heading", { text: "Homelab", level: 1 }, [0, 0, 8, 7]),
    n("clock", "clock", { show: "both" }, [8, 0, 4, 9]),
    n("text", "text", { text: b("{{ hosts.rows | count }} of {{ hosts.total }} machines are listed.\nMarkup stays text: <b>bold</b>") }, [0, 7, 8, 6]),
    n("stat", "statcpu", { data: b("{{ cpu }}"), showUpdated: true }, [0, 14, 3, 15]),
    n("stat", "stattemp", { data: b("{{ temp }}") }, [3, 14, 3, 15]),
    n("gauge", "gauge", { value: b("{{ disk.value }}"), unit: "%", label: "Disk", warn: 70, bad: 90 }, [6, 14, 3, 19]),
    n("progress", "progress", { value: b("{{ cpu.value }}"), label: "CPU", unit: "%", warn: 70, bad: 90 }, [9, 14, 3, 10]),
    n("chart", "chart", { data: b("{{ load }}"), kind: "area", height: 180 }, [0, 34, 8, 32]),
    n("status", "status", { data: b("{{ services }}") }, [8, 34, 4, 24]),
    n("table", "table", { data: b("{{ hosts }}"), maxRows: 6 }, [0, 67, 8, 36]),
    n("list", "list", { items: b("{{ hosts.rows }}"), labelKey: "name", detailKey: "cpu", maxItems: 5 }, [8, 67, 4, 28]),
    n("card", "card", { title: "Living room", subtitle: "Lights and scenes" }, [0, 104, 6, 34], {
      children: [
        { id: id("toggle"), type: "toggle", props: { label: "Desk lamp", control: GALLERY_CONTROLS.lamp, state: b('{{ lamps.find("entity", "light.desk").state == "on" }}') } },
        { id: id("slider"), type: "slider", props: { label: "Bed lamp", control: GALLERY_CONTROLS.dim, value: b('{{ lamps.find("entity", "light.bed").brightness }}'), min: 0, max: 255 } },
        { id: id("select"), type: "select", props: { label: "Mode", control: GALLERY_CONTROLS.mode, value: "heat", options: [{ label: "Heat", value: "heat" }, { label: "Cool", value: "cool" }] } },
        { id: id("button"), type: "button", props: { label: "Movie scene", control: GALLERY_CONTROLS.scene } },
      ],
    }),
    n("section", "section", { title: "Shortcuts", description: "Links and icons" }, [6, 104, 6, 34], {
      children: [
        { id: id("stack"), type: "stack", props: { direction: "horizontal", gap: 16, align: "center" }, children: [
          { id: id("iconlight"), type: "icon", props: { name: "light", size: 28, label: "Lights" } },
          { id: id("iconserver"), type: "icon", props: { name: "server", size: 28, label: "Servers" } },
          { id: id("linkpve"), type: "link", props: { label: "Proxmox", href: "https://10.77.99.4:8006" } },
          { id: id("linkbad"), type: "link", props: { label: "Refused link", href: "javascript:alert(1)" } },
        ] },
        { id: id("divider"), type: "divider", props: {} },
        { id: id("image"), type: "image", props: { src: "https://example.com/cam.jpg", alt: "Front door camera (unsigned, so a placeholder)", height: 90 } },
        { id: id("spacer"), type: "spacer", props: { height: 8 } },
      ],
    }),
    n("tabs", "tabs", { labels: ["Services", "Note"] }, [0, 139, 6, 26], {
      children: [
        { id: id("tabone"), type: "section", props: {}, children: [{ id: id("tabstatus"), type: "status", props: { data: b("{{ services }}"), layout: "grid" } }] },
        { id: id("tabtwo"), type: "section", props: {}, children: [{ id: id("tabtext"), type: "text", props: { text: "Second tab" } }] },
      ],
    }),
    n("repeat", "repeat", { items: b("{{ services.items }}"), columns: 2 }, [6, 139, 6, 26], {
      children: [{ id: id("repeatstat"), type: "stat", props: { value: b("{{ $item.state | upper }}"), label: b("#{{ $index }} {{ $item.label }}") } }],
    }),
    n("html", "htmlblock", { html: '<div class="bar"><span id="v"></span><i id="fill"></i></div>', css: ".bar{font:600 15px var(--theme-font-body);color:var(--theme-surface-text);padding:12px;border:1px solid var(--theme-line)} #fill{display:block;height:6px;background:var(--theme-accent);margin-top:8px;width:0}", js: "atrium.on('data', d => { document.getElementById('v').textContent = 'CPU ' + d.cpu + '%'; document.getElementById('fill').style.width = d.cpu + '%'; console.log('data ' + JSON.stringify(d)); }); atrium.on('theme', t => console.log('theme ' + t['--theme-accent'])); console.log('block ready, viewer ' + atrium.viewer.kind);", data: { cpu: b("{{ cpu.value | round(1) }}") }, controls: [], height: "auto" }, [0, 166, 12, 14], { name: "CPU bar" }),
  ];
  return { id: "p_everytypea", slug: "every-type", title: "Every type", inNav: true, root: { id: "c_gridrootaa", type: "grid", props: { minRows: 40 }, children } };
}

export function statesPage(): PageDoc {
  seq = 0;
  const s = (key: string, src: string, x: number, y: number) => n("stat", key, { data: b(`{{ ${src} }}`), showUpdated: true }, [x, y, 4, 16]);
  return {
    id: "p_statesaaaa", slug: "states", title: "States", inNav: true,
    root: { id: "c_statesgrid", type: "grid", props: {}, children: [s("stfresh", "cpu", 0, 0), s("ststale", "stale", 4, 0), s("stfailed", "failed", 8, 0), s("stempty", "empty", 0, 17), s("stunshare", "unshared", 4, 17), s("stloading", "loading", 8, 17),
      n("toggle", "stoggle", { label: "Unshared lamp", control: GALLERY_CONTROLS.lamp, state: b("{{ unshared.value == 1 }}") }, [0, 34, 4, 8])] },
  };
}

export function galleryDoc(pages: PageDoc[]): AppDocument {
  return {
    format: "atrium-app", formatVersion: 1,
    app: { name: "Gallery", homePage: pages[0]!.id, pageOrder: pages.map((p) => p.id) },
    theme: { themeId: "control-room" }, chrome: { layout: "none" },
    dataSources: Object.keys(gallerySources()).concat("loading").map((name) => ({ name, integrationId: "i_gallery", endpointId: name, refreshSec: 15 })),
    controls: [
      { id: GALLERY_CONTROLS.lamp, label: "Desk lamp", run: { kind: "command", integrationId: "i_gallery", commandId: "light.toggle" } },
      { id: GALLERY_CONTROLS.scene, label: "Movie scene", run: { kind: "command", integrationId: "i_gallery", commandId: "scene.turn_on" }, confirm: "Start the movie scene?" },
      { id: GALLERY_CONTROLS.draftOnly, label: "New scene", run: { kind: "command", integrationId: "i_gallery", commandId: "scene.turn_on" } },
      { id: GALLERY_CONTROLS.dim, label: "Bed lamp level", run: { kind: "command", integrationId: "i_gallery", commandId: "light.turn_on" } },
      { id: GALLERY_CONTROLS.mode, label: "Thermostat mode", run: { kind: "command", integrationId: "i_gallery", commandId: "climate.set_hvac_mode" } },
    ],
    pages,
  };
}

/** Node CSS cases for criteria 33 to 38 (scoped on the server by the page). */
export function cssPage(): PageDoc {
  seq = 0;
  return {
    id: "p_cssaaaaaaa", slug: "css", title: "CSS", inNav: true,
    root: {
      id: "c_cssgridaaa", type: "grid", props: {}, children: [
        n("stat", "csshover", { data: b("{{ cpu }}") }, [0, 0, 4, 16], { overrideTheme: true, style: { value: { states: { hover: { color: "#c0178a" } } } } }),
        n("stat", "cssplain", { data: b("{{ cpu }}") }, [4, 0, 4, 16]),
        n("stat", "csstoken", { data: b("{{ temp }}") }, [8, 0, 4, 16], { overrideTheme: true, style: { root: { background: "token:accent" } } }),
        n("text", "cssstar", { text: "Starred red text" }, [0, 17, 4, 8], { css: "* { color: red } body { background: red } + * { color: red }" }),
        n("text", "cssevil", { text: "Hostile CSS" }, [4, 17, 4, 8], { css: "@import url(https://example.com/x.css);\n.x { background: url(https://example.com/x.png) }\n:scope { position: fixed; top: 0; left: 0; }\n~ div { color: red }\n@font-face { font-family: x; src: url(/uploads/f.woff2) }\n.y { background-image: url(/uploads/plan.png) }" }),
        n("card", "csshuge", { title: "Tall and shadowed" }, [8, 17, 4, 8], { overrideTheme: true, style: { root: { height: 5000, boxShadow: "0 0 400px 200px rgba(200,0,0,0.6)" } } }),
        n("text", "cssoff", { text: "Override off, saved style kept" }, [0, 26, 4, 8], { overrideTheme: false, style: { root: { color: "#c0178a" } } }),
      ],
    },
  };
}

/** The bindings corpus scene evaluates in the browser (criterion 17). */
export const PROBES = ["storage", "network", "resources", "webrtc", "dns", "self-nav", "form-nav", "link-nav", "top-nav", "popup", "control-spam", "unlisted", "big-message", "window-post", "resize", "navigate", "draft-control", "images", "log"] as const;
export type ProbeName = (typeof PROBES)[number];

/** Builds a probe block. `t` is http://127.0.0.1:<probePort>; `stun` a UDP port; `dns` a unique label. */
export function probeBlock(name: ProbeName, t: string, stun: number, dns: string): ComponentNode {
  const result = (body: string) => `(async () => { const r = {}; const tryIt = async (k, fn) => { try { const v = await fn(); r[k] = v === undefined ? 'ok' : String(v); } catch (e) { r[k] = 'blocked:' + (e && (e.name || e.message)); } }; ${body}; console.log('RESULT ' + JSON.stringify(r)); })();`;
  const js: Record<ProbeName, string> = {
    storage: result(`await tryIt('cookie', () => JSON.stringify(document.cookie)); await tryIt('local', () => { localStorage.setItem('a', '1'); return localStorage.getItem('a'); }); await tryIt('session', () => { sessionStorage.setItem('a', '1'); return sessionStorage.getItem('a'); }); await tryIt('indexeddb', () => new Promise((ok, no) => { const q = indexedDB.open('x'); q.onsuccess = () => ok('opened'); q.onerror = () => no(q.error); })); await tryIt('origin', () => origin)`),
    network: result(`const T = '${t}'; await tryIt('fetchTest', () => fetch(T + '/fetch').then(x => x.status)); await tryIt('fetchApi', () => fetch('/api/library').then(x => x.status)); await tryIt('xhr', () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open('GET', T + '/xhr'); x.onload = () => ok(x.status); x.onerror = () => no(new Error('xhr error')); x.send(); })); await tryIt('websocket', () => new Promise((ok, no) => { const w = new WebSocket('${t.replace("http", "ws")}/ws'); w.onopen = () => ok('open'); w.onerror = () => no(new Error('ws error')); })); await tryIt('eventsource', () => new Promise((ok, no) => { const e = new EventSource(T + '/es'); e.onopen = () => ok('open'); e.onerror = () => no(new Error('es error')); })); await tryIt('beacon', () => navigator.sendBeacon(T + '/beacon', 'x'))`),
    resources: result(`const T = '${t}'; const add = (tag, attrs) => { const el = document.createElement(tag); Object.assign(el, attrs); document.body.appendChild(el); return el; }; add('img', { src: T + '/img.png' }); add('link', { rel: 'stylesheet', href: T + '/style.css' }); const st = document.createElement('style'); st.textContent = '@font-face { font-family: probe; src: url(' + T + '/font.woff2); } .f { font-family: probe; background: url(' + T + '/bg.png) } @import url(' + T + '/imp.css);'; document.head.appendChild(st); add('div', { className: 'f', textContent: 'font probe' }); add('iframe', { src: T + '/frame' }); add('audio', { src: T + '/a.mp3', autoplay: true }); add('video', { src: T + '/v.mp4', autoplay: true }); add('object', { data: T + '/obj' }); add('embed', { src: T + '/emb' }); add('script', { src: T + '/s.js' }); await new Promise(o => setTimeout(o, 1500)); r.iframes = String(document.querySelectorAll('iframe,object,embed').length)`),
    webrtc: result(`await tryIt('ctor', () => typeof RTCPeerConnection); await tryIt('pc', async () => { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${stun}' }] }); const c = []; pc.onicecandidate = (e) => { if (e.candidate) c.push(e.candidate.candidate); }; pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer()); await new Promise(o => setTimeout(o, 3000)); return 'candidates:' + c.length; })`),
    dns: result(`const H = '${dns}.atrium-dns-probe.test'; for (const rel of ['dns-prefetch', 'preconnect', 'prefetch']) { const l = document.createElement('link'); l.rel = rel; l.href = 'http://' + rel + '.' + H + '/'; document.head.appendChild(l); } const i = new Image(); i.src = 'http://img.' + H + '/x.png'; document.body.appendChild(i); const a = document.createElement('a'); a.href = 'http://a.' + H + '/'; a.textContent = 'x'; document.body.appendChild(a); await new Promise(o => setTimeout(o, 1500)); r.done = 'yes'`),
    "self-nav": `setTimeout(() => { location.href = '${t}/selfnav'; }, 300);`,
    "form-nav": `const f = document.createElement('form'); f.action = '${t}/form'; f.method = 'GET'; document.body.appendChild(f); setTimeout(() => { try { HTMLFormElement.prototype.submit.call(f); } catch (e) { console.log('RESULT ' + JSON.stringify({ form: 'blocked:' + e.name })); } }, 300);`,
    "link-nav": `const a = document.createElement('a'); a.href = '${t}/link'; a.textContent = 'go'; a.id = 'go'; document.body.appendChild(a); setTimeout(() => a.click(), 300);`,
    "top-nav": result(`await tryIt('top', () => { top.location.href = '${t}/top'; return 'set'; }); await tryIt('parentNav', () => { parent.location = '${t}/parent'; return 'set'; })`),
    popup: result(`await tryIt('open', () => { const w = window.open('${t}/popup'); return w === null ? 'null' : typeof w; }); await tryIt('alert', () => { alert('x'); return 'returned'; })`),
    "control-spam": result(`const out = []; for (let i = 0; i < 12; i++) out.push(atrium.control('${GALLERY_CONTROLS.lamp}', true)); const res = await Promise.race([Promise.all(out), new Promise(o => setTimeout(() => o('timeout'), 4000))]); r.answered = Array.isArray(res) ? String(res.filter(x => x.ok).length) : 'some unanswered'`),
    unlisted: result(`const res = await Promise.race([atrium.control('${GALLERY_CONTROLS.scene}'), new Promise(o => setTimeout(() => o('dropped'), 1500))]); r.unlisted = typeof res === 'string' ? res : 'answered'`),
    "big-message": `console.log('x'.repeat(300 * 1024)); console.log('RESULT ' + JSON.stringify({ small: 'sent' }));`,
    "window-post": `parent.postMessage({ t: 'control', reqId: 'w1', controlId: '${GALLERY_CONTROLS.lamp}' }, '*'); parent.postMessage({ t: 'navigate', page: 'states' }, '*'); console.log('RESULT ' + JSON.stringify({ posted: 'yes' }));`,
    resize: `document.getElementById('atrium-root').style.height = '6000px'; console.log('RESULT ' + JSON.stringify({ asked: 6000 }));`,
    navigate: result(`atrium.navigate('nope'); atrium.navigate('other-app/home'); atrium.navigate('states'); r.asked = 'yes'`),
    "draft-control": result(`r.result = JSON.stringify(await atrium.control('${GALLERY_CONTROLS.lamp}', true))`),
    images: result(`const img = document.querySelector('img'); await new Promise(o => img.complete ? o() : (img.onload = o, img.onerror = o)); r.src = img.src.slice(0, 22); r.width = String(img.naturalWidth); r.keys = Object.keys(atrium.images).join(',')`),
    log: `console.info('info line'); console.warn('warn line'); console.error('error line'); throw new Error('thrown line');`,
  };
  const controls: Record<string, string[]> = { "control-spam": [GALLERY_CONTROLS.lamp], "draft-control": [GALLERY_CONTROLS.lamp], unlisted: [GALLERY_CONTROLS.lamp], "window-post": [GALLERY_CONTROLS.lamp] };
  return {
    id: `c_probe${name.replace(/[^a-z]/g, "").slice(0, 5).padEnd(5, "a")}`,
    type: "html",
    name: `Probe ${name}`,
    props: {
      html: name === "images" ? '<img src="/uploads/probe.png" alt="probe">' : `<p>probe ${name}</p>`,
      js: js[name],
      data: { cpu: b("{{ cpu.value }}"), viewer: b("{{ $viewer.kind }}") },
      controls: controls[name] ?? [],
      height: name === "resize" ? "auto" : name === "big-message" ? 80 : "auto",
      ...(name === "images" ? { images: ["/uploads/probe.png"] } : {}),
    },
  };
}
