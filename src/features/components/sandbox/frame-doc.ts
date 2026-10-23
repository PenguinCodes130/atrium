// The HTML block's frame document (architecture v3 sections 4.7 and 13, spec 3.5.2 and 3.5.4). It is
// static and the same for every block: the user's code arrives later by message over a private
// MessageChannel port. The bootstrap below runs before any user code: it removes network, storage,
// peer-connection and window-opening APIs, cancels every navigation it can see, and exposes the one
// `atrium` object. CSP (sent by the route) is the real wall; this is the second layer.
export const FRAME_LIBS = ["uplot", "d3", "motion"] as const;
/** Libraries actually bundled under /sandbox/lib/ in this build. */
// uplot.js is uPlot 1.6.31 (dist/uPlot.iife.min.js, global `uPlot`); d3.js is d3 7.9.0 (dist/d3.min.js,
// global `d3`); motion.js is Motion 14.3.0 (global `Motion`). Copied unchanged from node_modules.
export const BUNDLED_LIBS: Record<string, string> = { motion: "/sandbox/lib/motion.js", uplot: "/sandbox/lib/uplot.js", d3: "/sandbox/lib/d3.js" };

const BOOTSTRAP = String.raw`(function () {
  "use strict";
  var W = window, D = document;
  var MAX = 256 * 1024;
  // 1. Remove what block code must never use. CSP already refuses the connections; this removes the
  //    handles so a mistake in one layer is not enough.
  var kill = ["fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "RTCPeerConnection", "webkitRTCPeerConnection",
    "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate", "Worker", "SharedWorker", "BroadcastChannel", "WebTransport", "open",
    "showModalDialog", "Notification", "PaymentRequest"];
  for (var i = 0; i < kill.length; i++) {
    try { Object.defineProperty(W, kill[i], { value: undefined, writable: false, configurable: false }); } catch (e) {}
  }
  // The frame has an opaque origin, so it has no cookies; reading gives "" instead of an exception.
  try { Object.defineProperty(Document.prototype, "cookie", { get: function () { return ""; }, set: function () {}, configurable: false }); } catch (e) {}
  try { Object.defineProperty(Navigator.prototype, "sendBeacon", { value: function () { return false; }, writable: false, configurable: false }); } catch (e) {}
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: function () { return undefined; }, configurable: false }); } catch (e) {}
  try { if (W.navigator.mediaDevices) Object.defineProperty(Navigator.prototype, "mediaDevices", { get: function () { return undefined; }, configurable: false }); } catch (e) {}
  // Nested frames could hand back fresh copies of the removed APIs: frames are refused by CSP
  // (frame-src 'none'), and any frame, object or embed that appears is removed at once.
  function strip(root) {
    var bad = root.querySelectorAll ? root.querySelectorAll("iframe,frame,object,embed,portal,base,meta[http-equiv],link[rel=preconnect],link[rel=dns-prefetch],link[rel=prefetch],link[rel=prerender],link[rel=preload],link[rel=modulepreload],form") : [];
    for (var j = 0; j < bad.length; j++) bad[j].remove();
  }
  new MutationObserver(function (list) {
    for (var k = 0; k < list.length; k++) for (var n = 0; n < list[k].addedNodes.length; n++) {
      var el = list[k].addedNodes[n];
      if (el.nodeType !== 1) continue;
      if (/^(IFRAME|FRAME|OBJECT|EMBED|PORTAL|BASE|FORM)$/.test(el.tagName) || (el.tagName === "LINK" && /preconnect|dns-prefetch|prefetch|prerender|preload/i.test(el.rel)) || (el.tagName === "META" && el.httpEquiv)) el.remove();
      else strip(el);
    }
  }).observe(D.documentElement, { childList: true, subtree: true });
  try {
    var proto = HTMLIFrameElement.prototype;
    Object.defineProperty(proto, "contentWindow", { get: function () { return null; }, configurable: false });
    Object.defineProperty(proto, "contentDocument", { get: function () { return null; }, configurable: false });
  } catch (e) {}
  // 2. Navigation: cancel everything the Navigation API reports, every link click and form submit.
  try { if (W.navigation) W.navigation.addEventListener("navigate", function (e) { if (e.cancelable) e.preventDefault(); }); } catch (e) {}
  D.addEventListener("click", function (e) { var a = e.target && e.target.closest ? e.target.closest("a[href],area[href]") : null; if (a) e.preventDefault(); }, true);
  D.addEventListener("submit", function (e) { e.preventDefault(); }, true);
  W.addEventListener("beforeunload", function (e) { e.preventDefault(); });

  // 3. The bridge: only the first message's port is ever used.
  var port = null, ready = false, handlers = { data: [], theme: [] }, pending = {}, seq = 0;
  function post(msg) {
    if (!port) return;
    try { var s = JSON.stringify(msg); if (s.length > MAX) return; port.postMessage(JSON.parse(s)); } catch (e) {}
  }
  function text(v) { try { return typeof v === "string" ? v : JSON.stringify(v); } catch (e) { return String(v); } }
  function log(level, args) {
    var parts = [];
    for (var a = 0; a < args.length; a++) parts.push(text(args[a]));
    post({ t: "log", level: level, message: parts.join(" ").slice(0, 2000) });
  }
  var c = W.console;
  ["log", "info", "debug"].forEach(function (m) { var o = c[m]; c[m] = function () { log("info", arguments); try { o.apply(c, arguments); } catch (e) {} }; });
  ["warn"].forEach(function (m) { var o = c[m]; c[m] = function () { log("warn", arguments); try { o.apply(c, arguments); } catch (e) {} }; });
  ["error"].forEach(function (m) { var o = c[m]; c[m] = function () { log("error", arguments); try { o.apply(c, arguments); } catch (e) {} }; });
  W.addEventListener("error", function (e) { log("error", [e.message || "Script error"]); });
  W.addEventListener("unhandledrejection", function (e) { log("error", ["Unhandled promise rejection: " + text(e.reason && e.reason.message || e.reason)]); });

  var atrium = {
    data: {}, theme: {}, viewer: { kind: "user" }, images: {},
    on: function (ev, fn) { if (handlers[ev] && typeof fn === "function") { handlers[ev].push(fn); if (ready) { try { fn(ev === "data" ? atrium.data : atrium.theme); } catch (e) { log("error", [e && e.message]); } } } },
    control: function (id, input) {
      return new Promise(function (resolve) {
        var reqId = "r" + (++seq);
        pending[reqId] = resolve;
        post({ t: "control", reqId: reqId, controlId: String(id), input: input });
        setTimeout(function () { if (pending[reqId]) { delete pending[reqId]; resolve({ ok: false, message: "No answer from Atrium." }); } }, 30000);
      });
    },
    navigate: function (slug) { post({ t: "navigate", page: String(slug) }); },
  };
  Object.freeze(atrium.on); Object.freeze(atrium.control); Object.freeze(atrium.navigate);
  try { Object.defineProperty(W, "atrium", { value: atrium, writable: false, configurable: false }); } catch (e) {}

  function emit(ev, v) { var list = handlers[ev]; for (var h = 0; h < list.length; h++) { try { list[h](v); } catch (e) { log("error", [e && e.message]); } } }
  function themeVars(t) { var r = D.documentElement; for (var k in t) if (/^--theme-[a-z-]+$/.test(k) && typeof t[k] === "string") r.style.setProperty(k, t[k]); }

  var lastH = 0;
  function measure() {
    // The content's own height (the document's scroll height never drops below the frame's).
    var root = D.getElementById("atrium-root");
    var h = Math.ceil(root ? root.getBoundingClientRect().bottom : 0);
    if (h !== lastH) { lastH = h; post({ t: "resize", height: h }); }
  }

  function loadLibs(libs, done) {
    var left = libs.length;
    if (!left) return done();
    libs.forEach(function (src) {
      var s = D.createElement("script");
      s.src = src;
      s.onload = s.onerror = function () { if (--left === 0) done(); };
      D.head.appendChild(s);
    });
  }

  function init(m) {
    if (ready) return;
    ready = true;
    atrium.data = m.data || {}; atrium.theme = m.theme || {}; atrium.viewer = m.viewer && m.viewer.kind === "guest" ? { kind: "guest" } : { kind: "user" };
    atrium.images = m.images || {};
    Object.freeze(atrium.viewer);
    themeVars(atrium.theme);
    if (m.css) { var st = D.createElement("style"); st.textContent = m.css; D.head.appendChild(st); }
    var root = D.getElementById("atrium-root");
    root.innerHTML = m.html || "";
    strip(root);
    var imgs = root.querySelectorAll("img[src]");
    for (var q = 0; q < imgs.length; q++) { var src = imgs[q].getAttribute("src"); if (atrium.images[src]) imgs[q].setAttribute("src", atrium.images[src]); }
    loadLibs(m.libs || [], function () {
      if (m.js) {
        var s = D.createElement("script");
        s.textContent = m.js;
        D.body.appendChild(s);
      }
      emit("data", atrium.data);
      emit("theme", atrium.theme);
      measure();
      if (W.ResizeObserver) new ResizeObserver(measure).observe(D.getElementById("atrium-root"));
    });
  }

  function onHost(e) {
    var m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.t === "init") init(m);
    else if (m.t === "data" && ready) { atrium.data = m.data || {}; emit("data", atrium.data); }
    else if (m.t === "theme" && ready) { atrium.theme = m.theme || {}; themeVars(atrium.theme); emit("theme", atrium.theme); }
    else if (m.t === "controlResult" && pending[m.reqId]) { var r = pending[m.reqId]; delete pending[m.reqId]; r({ ok: !!m.ok, message: m.message }); }
  }

  W.addEventListener("message", function first(e) {
    if (port || e.source !== W.parent || !e.ports || !e.ports[0]) return;
    W.removeEventListener("message", first);
    port = e.ports[0];
    port.onmessage = onHost;
    post({ t: "ready" });
  });
})();`;

/** The frame document. `libBase` is the origin's /sandbox/lib/ prefix (also allowed by the CSP). */
export function frameDocument(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Atrium HTML block</title>
<style>
:root { color-scheme: light dark; }
html, body { margin: 0; padding: 0; background: transparent; color: var(--theme-surface-text, inherit); font-family: var(--theme-font-body, system-ui, sans-serif); }
#atrium-root { display: flow-root; }
</style>
<script>${BOOTSTRAP}</script>
</head>
<body>
<div id="atrium-root"></div>
</body>
</html>
`;
}

/** The frame's response headers for a request that arrived on `origin` (already checked by the route). */
export function frameHeaders(origin: string): Record<string, string> {
  const csp = [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${origin}/sandbox/lib/`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "webrtc 'block'",
    `frame-ancestors ${origin}`,
  ].join("; ");
  return {
    "content-type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
    "X-DNS-Prefetch-Control": "off",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), display-capture=(), fullscreen=(), clipboard-read=(), clipboard-write=(), publickey-credentials-get=(), browsing-topics=()",
    "Cache-Control": "no-store",
  };
}

/** Which origin a frame request may be framed by: the public URL or one of the LAN origins, else null. */
export function allowedFrameOrigin(requestOrigin: string, publicUrl: string, lanOrigins: string | undefined): string | null {
  const norm = (u: string) => {
    try {
      return new URL(u).origin;
    } catch {
      return null;
    }
  };
  const req = norm(requestOrigin);
  if (!req) return null;
  const allowed = [norm(publicUrl), ...(lanOrigins ?? "").split(",").map((s) => norm(s.trim()))].filter((x): x is string => !!x);
  return allowed.includes(req) ? req : null;
}
