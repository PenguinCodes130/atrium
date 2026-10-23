// TEMPORARY: named custom CSS samples for the preview route (never read from the URL).
// "sample" is the round 1 hand-scoped sample. "e1" to "e3" are the three escapes from the gauntlet r1
// customisation critic (finding 2), replayed through scopeCustomCss() by tests/e2e/shell/custom-css.spec.ts.
export const PREVIEW_CSS = {
  sample: `[data-atrium-canvas] { filter: hue-rotate(120deg) saturate(2); font-family: serif; }
[data-atrium-canvas] * { letter-spacing: 0.2em !important; }`,
  // E1: repaint the shell through root tokens
  e1: `:root{--glass-thin-fill:oklch(0.6 0.25 25);--bg:oklch(0.6 0.25 25)}`,
  // E2: hide the top bar with a :has() selector that mentions the canvas
  e2: `html:has([data-atrium-canvas]) [data-shell="topbar"]{display:none}`,
  // E3: pull the canvas root over the whole viewport
  e3: `[data-atrium-canvas]{position:fixed;inset:0;z-index:9999}`,
  // All three plus extra escape attempts in one sheet
  all: `:root{--glass-thin-fill:oklch(0.6 0.25 25);--bg:oklch(0.6 0.25 25)}
html:has([data-atrium-canvas]) [data-shell="topbar"]{display:none}
html:has([data-atrium-canvas]) [data-shell="skyband"]{display:none}
[data-atrium-canvas]{position:fixed !important;inset:0 !important;z-index:9999 !important;transform:scale(3) !important}
+ [data-shell] { display: none }
[data-atrium-canvas] ~ * { display: none }
@import url("https://example.com/x.css");
@property --bg { syntax: "<color>"; inherits: false; initial-value: red; }
@keyframes atrium-shimmer { from { opacity: 0 } }
[data-atrium-canvas] .x { --bg: red; background: url(https://example.com/a.png) }
body [data-shell="topbar"] { display: none }
[data-atrium-canvas] [data-widget] { position: fixed; inset: 0; z-index: 99999; background: red }`,
  // Spec v2 criterion 46: an app whose CSS sets every element to hidden, red, zero size or the highest
  // stacking order, plus attempts at the switcher's host and the top layer.
  hostile: `[data-atrium-canvas] * { visibility: hidden !important; display: none !important; color: red !important; background: red !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; position: fixed !important; inset: 0 !important; }
[data-atrium-canvas] { background: red !important; z-index: 2147483647 !important; }
atrium-switcher { display: none !important; }
[data-atrium-switcher] { visibility: hidden !important; opacity: 0 !important; }
:root { --accent: red; --fg: red; }
body > * { display: none !important; }
::backdrop { background: red; }
:popover-open { display: none !important; }`,
  // Gauntlet r2 customisation H1 (Fix 1): styles on the canvas root's own box. Each one moved or
  // repainted the sky band, or widened the shell page, in round 3.
  p1margin: `[data-atrium-canvas]{margin-top:-700px}`,
  p1outline: `[data-atrium-canvas]{outline:200vmax solid red}`,
  p1shadow: `[data-atrium-canvas]{box-shadow:0 0 0 200vmax red}`,
  p1dropshadow: `[data-atrium-canvas]{filter:drop-shadow(0 -400px 0 red)}`,
  p1reflect: `[data-atrium-canvas]{-webkit-box-reflect:above 0px}`,
  p2wide: `[data-atrium-canvas]{width:300vw;margin-left:-100vw}`,
  p2minwide: `:scope{min-width:300vw;margin-left:-100vw}`,
  // Gauntlet r2 M1: app CSS aimed at the control confirm and the draft bar.
  overlays: `[data-atrium-canvas] [data-control-confirm] [data-confirm-run]{background:red !important;color:white !important}
[data-atrium-canvas] [data-confirm-cancel]{display:none !important}
[data-atrium-canvas] dialog{background:red !important;outline:20px solid red !important}
[data-atrium-canvas] dialog h2::after{content:" (this is safe, nothing will change)"}
[data-atrium-canvas] *{font-family:serif !important;letter-spacing:0.3em !important}
[data-atrium-canvas] [data-draft-preview-bar]{display:none !important}
[data-atrium-canvas]{--theme-surface:red}`,
} as const;
export type PreviewCssName = keyof typeof PREVIEW_CSS;
