// Gauntlet r2 customisation H1 probes as raw CSS (the same sheets the preview route scopes by name).
export const RAW_PROBES = {
  p1margin: "[data-atrium-canvas]{margin-top:-700px}",
  p1outline: "[data-atrium-canvas]{outline:200vmax solid red}",
  p1shadow: "[data-atrium-canvas]{box-shadow:0 0 0 200vmax red}",
  p1dropshadow: "[data-atrium-canvas]{filter:drop-shadow(0 -400px 0 red)}",
  p1reflect: "[data-atrium-canvas]{-webkit-box-reflect:above 0px}",
  p2wide: "[data-atrium-canvas]{width:300vw;margin-left:-100vw}",
  p2minwide: "[data-atrium-canvas]{min-width:300vw;margin-left:-100vw}",
} as const;
