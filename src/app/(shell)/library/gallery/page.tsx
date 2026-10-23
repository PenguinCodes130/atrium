// TEST-ONLY component gallery (/library/gallery). Gauntlet w2-r1 Fix 18: it answers 404 unless the
// server runs with ATRIUM_TEST_GALLERY=1, which only the e2e slot script sets (tests/e2e/components/
// serve.sh); Tristan's instance and every normal start never show it. It was the TEMPORARY gallery: every catalogue type with sample data, the data
// states, controls, node CSS cases and the sandbox probes, for screenshots and the components e2e
// suite until app-builder's viewer and builder mount the components. Members and owners only. Every
// query value is checked: scenes, themes and probes come from fixed lists, ports are integers and the
// DNS label is [a-z0-9]. Remove once app-builder's routes cover these checks (components build report).
import { notFound, redirect } from "next/navigation";
import type { RenderMode } from "@/core/contracts";
import { requireUser } from "@/features/auth";
import { compileDocumentCss } from "@/features/components/server";
import { resolveGuestValues } from "@/features/components/page";
import { cssPage, everyTypePage, galleryDoc, gallerySources, probeBlock, statesPage, PROBES, type ProbeName } from "@/features/components/gallery/data";
import { Gallery } from "@/features/components/gallery/gallery";

export const dynamic = "force-dynamic";
// Without the test flag the page is not found, and its title says so (gauntlet w2-r2 Fix 8).
export function generateMetadata() {
  return { title: galleryEnabled() ? "Component gallery" : "Not found" };
}

const SCENES = new Set(["all", "states", "unavailable", "controls", "css", "sandbox", "bindings", "inspector", "motion", "guest"]);
const THEMES = new Set(["controlRoom", "dusk", "solid"]);
const MODES = new Set<RenderMode>(["view", "draft-preview", "agent-render", "edit"]);

function int(v: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** The gallery exists only for the e2e suite. */
function galleryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ATRIUM_TEST_GALLERY === "1";
}

export default async function GalleryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!galleryEnabled()) notFound();
  const s = await requireUser();
  if (s.principal.role === "viewer") redirect("/");
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const scene = SCENES.has(one("scene") ?? "") ? one("scene")! : "all";
  const theme = (THEMES.has(one("theme") ?? "") ? one("theme") : "controlRoom") as "controlRoom" | "dusk" | "solid";
  const mode = (MODES.has(one("mode") as RenderMode) ? one("mode") : "view") as RenderMode;
  const series = int(one("series"), 0, 40, 3);
  const probePort = int(one("probe"), 1024, 65535, 9);
  const stunPort = int(one("stun"), 1024, 65535, 9);
  const dns = /^[a-z0-9]{1,40}$/.test(one("dns") ?? "") ? one("dns")! : "none";
  const probes = (one("probes") ?? "").split(",").filter((x): x is ProbeName => (PROBES as readonly string[]).includes(x));

  let page = everyTypePage();
  if (scene === "states" || scene === "unavailable") page = statesPage();
  if (scene === "css") page = cssPage();
  if (scene === "sandbox") page = { ...page, id: "p_sandboxaaa", slug: "sandbox", root: { id: "c_sandboxstk", type: "stack", props: { gap: 16 }, children: probes.map((n) => probeBlock(n, `http://127.0.0.1:${probePort}`, stunPort, dns)) } };
  const doc = galleryDoc([page, statesPage()].filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i));
  const css = compileDocumentCss(doc, page.id);
  // Guest scene: the server resolves the page's bindings and the browser gets only those values.
  const guestValues = scene === "guest" ? resolveGuestValues(doc, page.id, Object.fromEntries(Object.entries(gallerySources(series)).flatMap(([k, v]) => (v.data ? [[k, v.data]] : [])))) : undefined;
  return (
    <Gallery
      scene={scene}
      theme={theme}
      mode={mode}
      doc={doc}
      page={page}
      css={css}
      principal={s.principal}
      series={series}
      answer={one("answer") === "refuse" ? "refuse" : "ok"}
      viewer={scene === "guest" ? "guest" : "user"}
      {...(guestValues ? { guestValues } : {})}
    />
  );
}
