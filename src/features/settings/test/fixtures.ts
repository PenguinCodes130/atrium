// The hostile theme fixture (settings spec AC 24 and 28): every string field holds `}`, `;`, `{`, `<`
// and `:root{`, every number is out of range, and the custom CSS tries to reach the shell.
export const EVIL = "red}; :root{--bg:#f00} </style><script>x</script>{";

export const HOSTILE_CSS = [
  "@import url(https://evil.example/x.css);",
  "body{display:none!important}",
  ":root{--bg:#ff0000;--fg:#00ff00}",
  "html{filter:invert(1)}",
  "[data-top-bar],[data-app-switcher],dialog,[data-toaster],[data-draft-preview-bar]{display:none;background:red;transform:scale(3);z-index:2147483647}",
  ".x{position:fixed;inset:0;z-index:999999;background:url(https://evil.example/a.png)}",
  "[data-atrium-canvas]{margin:-500px;width:300vw;box-shadow:0 0 0 9999px red}",
  ".card{color:blue}",
].join("\n");

const ev = EVIL;
export function hostileTheme(): Record<string, unknown> {
  return {
    atriumTheme: "2",
    id: `evil}${ev}`,
    name: `Evil ${ev}`,
    author: ev,
    version: ev,
    mode: ev,
    tokens: {
      wallpaper: { kind: "gradient", value: `linear-gradient(red, blue)}${ev}`, colors: [ev, ev], blurPx: 999, dim: 9, grain: -4, position: ev },
      color: { surface: ev, surfaceText: ev, surfaceMuted: ev, canvasText: ev, accent: ev, accentText: ev, ok: ev, warn: ev, bad: ev, info: ev, line: ev },
      surface: { material: ev, opacity: 7, blurPx: 900, border: { widthPx: 9, color: ev }, shadow: ev, shadowOffsetPx: 99, titleBars: ev },
      type: { display: ev, body: `Inter Tight"; } :root{x`, mono: ev, scale: 2, numbers: ev, headingTracking: 5, headingWeight: 9999 },
      shape: { radiusPx: 400, controlRadiusPx: 99999 },
      space: { gapPx: -50, padPx: 900, density: ev },
      motion: { enter: ev, lightDrift: ev },
      chrome: { background: ev, text: ev, activeFill: ev, activeText: ev, style: ev },
    },
    dark: { color: { surface: ev, surfaceText: ev, surfaceMuted: ev, canvasText: ev, accent: ev, accentText: ev, ok: ev, warn: ev, bad: ev, info: ev, line: ev } },
    fonts: [{ family: ev, file: `/uploads/x.woff2}${ev}`, weight: ev, style: ev }],
    customCss: HOSTILE_CSS,
  };
}
