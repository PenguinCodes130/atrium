// Theme files (settings spec 3.6; design v4 section 2 "Sharing"): `<name>.atrium-theme`, a zip of
// theme.json plus the fonts and wallpaper it uses (assets/<file>). Import accepts current files and
// v3 files (`atriumTheme: "1"`, mapped by app-shell's parseTheme), runs every value through
// revalidation, every font and image through the upload checks, and keeps custom CSS raw (it is scoped
// to the canvas whenever it renders). An import always makes a new theme with a new id, and a name
// already in use gets " (2)". A file that is not a theme, is damaged, or holds a refused file is
// refused naming the problem, and nothing is saved.
import "server-only";
import type { Principal, Theme } from "@/core/contracts";
import { AtriumError, Forbidden } from "@/core/errors";
import { parseTheme } from "@/features/shell";
import { readZip, writeZip, ZipError, type ZipEntry } from "@/features/settings/zip";
import { checkFile, MAX_PACKAGE_ASSET_BYTES, readUpload, storeChecked, UploadRefused, canUpload } from "@/features/uploads/store";
import { revalidateTheme } from "./revalidate";
import { createTheme, themeById, type SavedTheme } from "./store";

export const MAX_THEME_FILE_BYTES = 24 * 1024 * 1024;

export class ThemeFileRefused extends AtriumError {
  constructor(message: string) {
    super(message, 400, "theme_file_refused");
  }
}

/** The /uploads/ files a theme uses (wallpaper image and font files). */
export function themeAssets(t: Theme): string[] {
  const out = new Set<string>();
  for (const set of [t.tokens, t.dark ?? {}]) {
    const w = (set as Theme["tokens"]).wallpaper;
    if (w?.kind === "image" && w.value.startsWith("/uploads/")) out.add(w.value);
  }
  for (const f of t.fonts ?? []) out.add(f.file);
  return [...out];
}

export function themeFileName(name: string): string {
  const base = name.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60) || "theme";
  return `${base}.atrium-theme`;
}

/** Build the file for a built-in or saved theme. */
export function exportTheme(id: string): { fileName: string; bytes: Buffer } {
  const found = themeById(id);
  if (!found) throw new AtriumError("That theme does not exist.", 404, "not_found");
  const theme = found.theme;
  const entries: ZipEntry[] = [{ name: "theme.json", data: Buffer.from(`${JSON.stringify(theme, null, 2)}\n`, "utf8") }];
  for (const p of themeAssets(theme)) {
    const file = p.slice("/uploads/".length);
    const stored = readUpload(file);
    if (stored) entries.push({ name: `assets/${file}`, data: stored.bytes });
  }
  return { fileName: themeFileName(theme.name), bytes: writeZip(entries) };
}

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new ThemeFileRefused("theme.json is damaged: it is not valid JSON.");
  }
}

/** Import a theme file (zip, or a bare theme.json). Owners and members. Returns the new saved theme. */
export function importTheme(p: Principal, file: Buffer): SavedTheme {
  if (!canUpload(p)) throw new Forbidden("Only owners and members can import themes.");
  if (file.length > MAX_THEME_FILE_BYTES) throw new ThemeFileRefused("The theme file is larger than 24 MB.");
  let json: unknown;
  const assets = new Map<string, Buffer>();
  const isZip = file.length >= 4 && file.readUInt32LE(0) === 0x04034b50;
  if (isZip) {
    let entries: Map<string, Buffer>;
    try {
      entries = readZip(file, { maxEntries: 32, maxTotalBytes: MAX_THEME_FILE_BYTES });
    } catch (e) {
      throw new ThemeFileRefused(`This theme file is damaged (${e instanceof ZipError ? e.message : "unreadable"}).`);
    }
    const tj = entries.get("theme.json");
    if (!tj) throw new ThemeFileRefused("This is not a theme file: it has no theme.json.");
    json = parseJson(tj);
    for (const [name, data] of entries) {
      if (name === "theme.json") continue;
      if (!name.startsWith("assets/") || name.split("/").length !== 2) throw new ThemeFileRefused(`This theme file holds a file Atrium does not accept: ${name}.`);
      assets.set(name.slice("assets/".length), data);
    }
  } else {
    const head = file.subarray(0, 64).toString("utf8").trimStart();
    if (!head.startsWith("{")) throw new ThemeFileRefused("This is not a theme file.");
    json = parseJson(file);
  }
  const version = (json as { atriumTheme?: unknown } | null)?.atriumTheme;
  if (version !== "1" && version !== "2") throw new ThemeFileRefused("This is not a theme file: theme.json has no atriumTheme version.");
  // v3 files are mapped by app-shell (surface.tint to color.surface; new fields from Control Room).
  let theme: unknown = json;
  if (version === "1") {
    const parsed = parseTheme(json);
    if (!parsed.ok) throw new ThemeFileRefused(`This v3 theme file is not valid: ${parsed.error}.`);
    theme = parsed.theme;
  }
  // Check every asset before anything is saved, then rewrite paths to this instance's uploads.
  const t = revalidateTheme(theme).theme;
  const wanted = themeAssets(t);
  const checked = new Map<string, ReturnType<typeof checkFile>>();
  // Every file in the package is checked, used or not: one refused file refuses the whole import.
  for (const [name, data] of assets) {
    const isFont = /\.woff2$/i.test(name);
    let c: ReturnType<typeof checkFile>;
    try {
      c = checkFile(data, isFont ? "font" : "image", { maxBytes: MAX_PACKAGE_ASSET_BYTES });
    } catch (e) {
      throw new ThemeFileRefused(`${name} in this theme file was refused: ${e instanceof UploadRefused ? e.message : "unreadable"}.`);
    }
    if (c.svgRemoved) throw new ThemeFileRefused(`${name} in this theme file was refused: the SVG holds scripts, event handlers or outside references.`);
    if (wanted.includes(`/uploads/${name}`)) checked.set(name, c);
  }
  for (const w of wanted) if (!checked.has(w.slice("/uploads/".length)) && !readUpload(w.slice("/uploads/".length))) {
    throw new ThemeFileRefused(`This theme file is missing ${w.slice("/uploads/".length)}.`);
  }
  const map = new Map<string, string>();
  for (const [name, c] of checked) map.set(`/uploads/${name}`, storeChecked(p, c, name).path);
  const rewritten = JSON.parse(JSON.stringify(theme), (_k, v) => (typeof v === "string" && map.has(v) ? map.get(v) : v));
  // Imported values are revalidated (replaced, never refused) so an older or odd file still imports.
  const fixed = revalidateTheme(rewritten).theme;
  return createTheme(p, fixed, { audit: "imported", rename: true });
}
