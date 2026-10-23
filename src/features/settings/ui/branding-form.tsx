"use client";
// Instance branding (owner only; settings gauntlet w2-r1 item 8): the shell accent from the shell's own
// palette, a logo, a favicon and a sign-in wallpaper, each uploaded through the upload sanitiser. No free
// CSS: the accent is a named palette entry the server turns into the accent tokens.
// Settings r3 (gauntlet w2-r2 item 9): one accent fill per view, so each window's save is Ink.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, toast } from "@/features/shell";
import { BRAND_ACCENTS, BRAND_ACCENT_IDS, type BrandAccentId } from "@/features/settings/branding-palette";
import { UploadField } from "@/features/uploads/ui/upload-field";
import { api, type ApiError } from "./client-api";
import { ChoiceGroup } from "./controls";

export type BrandingValues = { brandAccent: BrandAccentId | null; brandLogo: string | null; brandFavicon: string | null; signInWallpaper: string | null };

const IMAGES: { key: "brandLogo" | "brandFavicon" | "signInWallpaper"; label: string; hint: string }[] = [
  { key: "brandLogo", label: "Logo", hint: "Shown in the top bar and on the sign-in page, at 24px tall." },
  { key: "brandFavicon", label: "Favicon", hint: "The browser tab icon. A square PNG or SVG works best." },
  { key: "signInWallpaper", label: "Sign-in wallpaper", hint: "Behind the sign-in window. The window stays solid, so text keeps its contrast." },
];

export function BrandingForm({ initial }: { initial: BrandingValues }) {
  const router = useRouter();
  const [v, setV] = useState<BrandingValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accent = v.brandAccent ?? "gold";

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/settings/instance", { method: "PUT", body: { ...v, brandAccent: accent === "gold" ? null : accent } });
      toast({ kind: "success", title: "Saved branding" });
      router.refresh();
    } catch (x) {
      setError((x as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-[560px] flex-col gap-6" data-branding-form>
      <ChoiceGroup<BrandAccentId>
        label="Shell accent"
        name="brandAccent"
        value={accent}
        onChange={(a) => setV((c) => ({ ...c, brandAccent: a }))}
        // Settings r3 (gauntlet w2-r2 item 9): the five accents sit on one row as an even grid.
        columns={BRAND_ACCENT_IDS.length}
        options={BRAND_ACCENT_IDS.map((id) => ({
          value: id,
          data: { accent: id },
          label: (
            <>
              <span aria-hidden className="inline-block size-4 flex-none border border-[color:var(--ink)]" style={{ background: BRAND_ACCENTS[id].light.accent }} />
              <span className="break-words">{BRAND_ACCENTS[id].label}</span>
            </>
          ),
        }))}
      />
      {IMAGES.map((img) => (
        <div key={img.key} className="flex flex-col gap-1.5 border-t border-line pt-4" data-brand-image={img.key}>
          <UploadField accept="image" label={img.label} value={v[img.key] ?? undefined} onChange={(path) => setV((c) => ({ ...c, [img.key]: path }))} />
          <span className="type-caption text-fg-2">{img.hint}</span>
          {v[img.key] && (
            <div>
              <Button variant="quiet" onClick={() => setV((c) => ({ ...c, [img.key]: null }))} data-remove-brand={img.key}>Remove {img.label.toLowerCase()}</Button>
            </div>
          )}
        </div>
      ))}
      {error && <p role="alert" className="type-body text-bad" data-branding-error>{error}</p>}
      <div><Button variant="ink" disabled={busy} onClick={save} data-save-branding>{busy ? "Saving" : "Save branding"}</Button></div>
    </div>
  );
}
