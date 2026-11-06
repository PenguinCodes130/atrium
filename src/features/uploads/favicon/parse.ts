// Finding a website's icons (A11.6): `<link rel>` icon and apple-touch-icon tags and the web app
// manifest's icons, ranked best first. Pure. The page is scanned by hand with indexOf, never with a
// backtracking regex over the whole page, so a hostile 512 KB page costs linear time.
import { FAVICON_MAX_PX } from "./messages";

export type IconCandidate = {
  url: string;
  /** Where it was found. */
  from: "link" | "apple-touch" | "manifest" | "fallback";
  /** The largest declared side at most 256 px, or 0 when none is declared. */
  px: number;
  /** Every declared size is larger than 256 px. */
  oversized: boolean;
  svg: boolean;
};

export type PageIcons = { icons: IconCandidate[]; manifest: string | null };

/** Skipped whole: their text is not markup. */
const RAW_TEXT = new Set(["script", "style", "template", "textarea", "title", "xmp"]);
const APPLE_TOUCH_PX = 180;
const ICON_RELS = new Set(["icon", "apple-touch-icon", "apple-touch-icon-precomposed"]);

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** A tag's attributes, names lowercased, values entity-decoded. */
export function parseAttributes(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1]!.toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Declared sizes ("16x16 32x32", "any") as the best side at most 256 px. */
export function parseSizes(sizes: string | undefined): { px: number; oversized: boolean; any: boolean } {
  let px = 0, seen = 0, any = false;
  for (const tok of (sizes ?? "").toLowerCase().split(/\s+/)) {
    if (tok === "any") any = true;
    const m = /^(\d{1,5})x(\d{1,5})$/.exec(tok);
    if (!m) continue;
    seen++;
    const side = Math.max(Number(m[1]), Number(m[2]));
    if (side <= FAVICON_MAX_PX && side > px) px = side;
  }
  return { px, oversized: seen > 0 && px === 0, any };
}

/** An absolute http(s) or data:image URL, or null. */
export function resolveIconUrl(href: string, base: string): string | null {
  const h = href.trim();
  if (!h) return null;
  if (/^data:/i.test(h)) return /^data:image\//i.test(h) ? h : null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

const looksSvg = (url: string, type?: string) => /svg/i.test(type ?? "") || /^data:image\/svg/i.test(url) || /\.svgz?(\?|$)/i.test(url.split("#")[0]!);

/**
 * The icons and the manifest a page declares. `pageUrl` is the final address after redirects; a
 * `<base href>` before the links changes the base, as in a browser.
 */
export function parsePage(html: string, pageUrl: string): PageIcons {
  const lower = html.toLowerCase();
  let base = pageUrl;
  let baseSeen = false;
  let manifest: string | null = null;
  const icons: IconCandidate[] = [];
  let i = 0;
  while ((i = html.indexOf("<", i)) >= 0) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,30})/.exec(html.slice(i, i + 34));
    if (!m) {
      i++;
      continue;
    }
    // The end of the tag: the first > outside quotes.
    let j = i + m[0].length;
    let q = "";
    for (; j < html.length; j++) {
      const c = html[j];
      if (q) {
        if (c === q) q = "";
      } else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
    }
    if (j >= html.length) break;
    const name = m[2]!.toLowerCase();
    const closing = m[1] === "/";
    if (!closing && RAW_TEXT.has(name)) {
      const end = lower.indexOf(`</${name}`, j + 1);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (!closing && (name === "link" || name === "base")) {
      const a = parseAttributes(html.slice(i + m[0].length, j));
      if (name === "base" && !baseSeen && a.href) {
        baseSeen = true;
        try {
          base = new URL(a.href, pageUrl).toString();
        } catch {
          /* a bad base is ignored, as browsers do */
        }
      }
      if (name === "link" && a.href) {
        const rels = (a.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        if (rels.includes("manifest") && !manifest) manifest = resolveIconUrl(a.href, base);
        if (rels.some((r) => ICON_RELS.has(r))) {
          const url = resolveIconUrl(a.href, base);
          if (url) {
            const s = parseSizes(a.sizes);
            const apple = rels.some((r) => r.startsWith("apple-touch-icon"));
            // An apple-touch-icon with no sizes is 180 px by Apple's convention.
            const px = apple && !s.px && !s.oversized ? APPLE_TOUCH_PX : s.px;
            icons.push({ url, from: apple ? "apple-touch" : "link", px, oversized: s.oversized, svg: looksSvg(url, a.type) });
          }
        }
      }
    }
    i = j + 1;
  }
  return { icons, manifest: manifest && /^https?:/i.test(manifest) ? manifest : null };
}

/** The icons a web app manifest lists (monochrome-only icons left out). */
export function parseManifest(text: string, manifestUrl: string): IconCandidate[] {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (j as { icons?: unknown })?.icons;
  if (!Array.isArray(list)) return [];
  const out: IconCandidate[] = [];
  for (const raw of list.slice(0, 50)) {
    if (!raw || typeof raw !== "object") continue;
    const ic = raw as { src?: unknown; sizes?: unknown; type?: unknown; purpose?: unknown };
    if (typeof ic.src !== "string") continue;
    const purpose = typeof ic.purpose === "string" ? ic.purpose.toLowerCase().split(/\s+/).filter(Boolean) : [];
    if (purpose.length && !purpose.includes("any") && !purpose.includes("maskable")) continue;
    const url = resolveIconUrl(ic.src, manifestUrl);
    if (!url) continue;
    const s = parseSizes(typeof ic.sizes === "string" ? ic.sizes : undefined);
    out.push({ url, from: "manifest", px: s.px, oversized: s.oversized, svg: looksSvg(url, typeof ic.type === "string" ? ic.type : undefined) });
  }
  return out;
}

/** The site's /favicon.ico, the last thing to try. */
export function fallbackIcon(pageUrl: string): IconCandidate {
  return { url: new URL("/favicon.ico", pageUrl).toString(), from: "fallback", px: 0, oversized: false, svg: false };
}

/**
 * Best first, each address once: SVG (it scales), then rasters by declared size (largest at most
 * 256 px first), then rasters with no declared size (apple-touch icons first, they are usually 180 px),
 * then /favicon.ico. An apple-touch-icon with no sizes counts as 180 px. Icons declared only larger than 256 px are left out (they are counted by the
 * caller for the "all larger than 256 px" answer).
 */
export function rankIcons(list: IconCandidate[]): IconCandidate[] {
  const seen = new Set<string>();
  const unique = list.filter((c) => !c.oversized && !seen.has(c.url) && seen.add(c.url));
  const group = (c: IconCandidate) => (c.svg ? 0 : c.from === "fallback" ? 3 : c.px > 0 ? 1 : 2);
  return unique
    .map((c, order) => ({ c, order }))
    .sort((a, b) => group(a.c) - group(b.c) || b.c.px - a.c.px || Number(b.c.from === "apple-touch") - Number(a.c.from === "apple-touch") || a.order - b.order)
    .map((x) => x.c);
}

/** Whether a page's links already give a good icon, so the manifest need not be fetched. */
export function goodEnough(list: IconCandidate[]): boolean {
  return list.some((c) => !c.oversized && (c.svg || c.px >= 128 || c.from === "apple-touch"));
}
