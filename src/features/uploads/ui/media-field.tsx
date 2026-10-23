"use client";
// MediaField (Wave 2.6, builder ease spec 3.1): fill a picture or video field with no path typed. A
// thumbnail of the current file, an Upload button showing its progress, "Your uploads" (a grid of
// files already on this instance, newest first, with search by name), and the old typed or bound
// address under a folded "Paste an address" (passed in as children by the inspector). Owners and
// members only; the server refuses everyone else. Every control is 44px tall on phones and touch.
//   <MediaField accept="video" value={src} onChange={(p) => setProp("src", p)}>{addressField}</MediaField>
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Button, Sheet, useReducedMotion } from "@/features/shell";
import { uploadFile } from "./upload-file";

export type MediaFieldProps = {
  value?: string;
  onChange(path: string): void;
  accept: "image" | "video";
  label?: string;
  hint?: string;
  children?: ReactNode;
};

export type UploadItem = { path: string; name: string; mime: string; kind: "image" | "video" | "font"; size: number; createdAt: string };

const ACCEPT = {
  image: "image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml",
  video: "video/mp4,video/webm,.mp4,.webm",
} as const;

export const EMPTY_UPLOADS = "Nothing uploaded yet. Upload a picture or video to use it anywhere in your apps.";
export const GIF_NOTE = "Animated pictures keep playing for people with reduced motion on. Use a Video if you want it to pause.";

const TALL = "max-sm:h-11 max-sm:min-h-11";
const inputCls = "w-full border border-line-strong bg-bg-hi px-2 py-1.5 type-body text-fg placeholder:text-fg-3 min-h-9 touch:min-h-11 max-sm:min-h-11";

const sizeWords = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const isUpload = (v: string | undefined): v is string => typeof v === "string" && /^\/uploads\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(v) && !v.includes("..");

/** Whether a picture may be animated: GIFs always, WebP when its header says so. */
function useMaybeAnimated(value: string | undefined, enabled: boolean): boolean {
  const [webpAnimated, setWebpAnimated] = useState<{ path: string; yes: boolean } | null>(null);
  const isGif = !!value && /\.gif$/i.test(value);
  const isWebp = !!value && /\.webp$/i.test(value);
  useEffect(() => {
    if (!enabled || !isWebp || !value) return;
    let live = true;
    fetch(value, { headers: { range: "bytes=0-63" } })
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const b = new Uint8Array(buf);
        // VP8X chunk at byte 12, its flags byte at 20: bit 1 is "animation".
        const yes = b.length > 20 && String.fromCharCode(...b.subarray(12, 16)) === "VP8X" && (b[20]! & 0x02) !== 0;
        if (live) setWebpAnimated({ path: value, yes });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, isWebp, value]);
  if (!enabled) return false;
  return isGif || (isWebp && webpAnimated?.path === value && webpAnimated.yes);
}

function Thumb({ path, kind, className }: { path: string; kind: "image" | "video"; className: string }) {
  if (kind === "video") return <video src={path} muted playsInline preload="metadata" className={className} aria-hidden data-media-thumb="video" />;
  return <img src={path} alt="" className={className} loading="lazy" data-media-thumb="image" />;
}

export function MediaField({ value, onChange, accept, label, hint, children }: MediaFieldProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const reduced = useReducedMotion();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const animated = useMaybeAnimated(value, reduced && accept === "image");
  const what = accept === "video" ? "video" : "picture";
  const shown = isUpload(value) || (accept === "image" && typeof value === "string" && /^https?:\/\//i.test(value)) ? value : undefined;

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    // Clear the picker only after the upload: some browsers stop reading a picked file once its input
    // is reset, and the server then gets a cut-off form ("Send the file as a form upload").
    const picker = e.target;
    const file = picker.files?.[0];
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const up = await uploadFile(file, accept, setProgress);
      onChange(up.path);
    } catch (x) {
      setError(x instanceof Error ? x.message : "The upload failed.");
    } finally {
      setProgress(null);
      picker.value = "";
    }
  }

  const busy = progress !== null;
  return (
    <div className="flex flex-col gap-2" data-media-field={accept}>
      <label htmlFor={id} className="type-label text-fg-2">
        {label ?? (accept === "video" ? "Video" : "Picture")}
      </label>
      {hint ? <p className="-mt-1.5 type-caption text-fg-3" data-media-hint>{hint}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex size-16 flex-none items-center justify-center overflow-hidden border border-line-strong bg-bg-sunk" data-media-preview={shown ? "" : "empty"}>
          {shown ? (
            <Thumb path={shown} kind={accept} className="size-full object-cover" />
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden className="text-fg-3">
              {accept === "video" ? <path d="M3 6h13v12H3zM16 10l5-3v10l-5-3" fill="none" stroke="currentColor" strokeWidth="1.5" /> : <path d="M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" />}
            </svg>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap gap-2">
          <input ref={input} id={id} type="file" accept={ACCEPT[accept]} className="sr-only" onChange={pick} aria-describedby={`${id}-msg`} data-media-input />
          <Button variant="secondary" className={TALL} disabled={busy} onClick={() => input.current?.click()} data-media-upload>
            {busy ? `Uploading ${progress}%` : shown ? "Replace" : "Upload"}
          </Button>
          <Button variant="secondary" className={TALL} disabled={busy} onClick={() => setLibraryOpen(true)} data-media-library>
            Your uploads
          </Button>
        </div>
      </div>
      <p id={`${id}-msg`} role={error ? "alert" : "status"} aria-live="polite" className={`type-caption ${error ? "text-bad" : "text-fg-2"}`} data-media-message>
        {error ?? (busy ? `Uploading the ${what}: ${progress}%` : "")}
      </p>
      {animated ? <p className="type-caption text-fg-2" data-media-gif-note>{GIF_NOTE}</p> : null}
      {children ? (
        <details className="group/paste border-t border-line pt-2" data-media-paste>
          <summary className={`flex min-h-9 cursor-pointer list-none select-none items-center gap-2 type-label text-fg-2 touch:min-h-11 [&::-webkit-details-marker]:hidden ${TALL}`}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden className="flex-none transition-transform duration-150 group-open/paste:rotate-90 motion-reduce:transition-none reduced-motion:transition-none">
              <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
            </svg>
            Paste an address
          </summary>
          <div className="pt-2">{children}</div>
        </details>
      ) : null}
      {libraryOpen ? (
        <UploadsSheet
          kind={accept}
          current={shown}
          onClose={() => setLibraryOpen(false)}
          onPick={(p) => {
            onChange(p);
            setLibraryOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** The "Your uploads" sheet: this instance's uploads of one kind, newest first, searchable by name. */
function UploadsSheet({ kind, current, onClose, onPick }: { kind: "image" | "video"; current?: string; onClose(): void; onPick(path: string): void }) {
  const [items, setItems] = useState<UploadItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    let live = true;
    fetch(`/api/settings/uploads?kind=${kind}`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { items?: UploadItem[]; error?: { message?: string } };
        if (!r.ok || !j.items) throw new Error(j.error?.message ?? "Your uploads could not be loaded.");
        if (live) setItems(j.items);
      })
      .catch((x: unknown) => {
        if (live) setError(x instanceof Error ? x.message : "Your uploads could not be loaded.");
      });
    return () => {
      live = false;
    };
  }, [kind]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (items ?? []).filter((i) => !t || i.name.toLowerCase().includes(t));
  }, [items, q]);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Your uploads" path={`builder / your uploads / ${kind === "video" ? "videos" : "pictures"}`} name="media-library" width={480} description={kind === "video" ? "Pick a video already on this Atrium." : "Pick a picture already on this Atrium."}>
      <div className="flex flex-col gap-3" data-media-library-body>
        <input type="search" aria-label="Search your uploads by name" placeholder="Search by name" className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} data-media-search />
        {error ? (
          <p role="alert" className="type-body text-bad">{error}</p>
        ) : items === null ? (
          <p role="status" className="type-body text-fg-2">Loading your uploads.</p>
        ) : items.length === 0 ? (
          <p className="type-body text-fg-2" data-media-empty>{EMPTY_UPLOADS}</p>
        ) : shown.length === 0 ? (
          <p className="type-body text-fg-2" data-media-nomatch>No uploads match &quot;{q.trim()}&quot;.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-media-grid>
            {shown.map((i) => (
              <li key={i.path}>
                <button
                  type="button"
                  onClick={() => onPick(i.path)}
                  aria-pressed={current === i.path}
                  className="flex w-full min-h-11 cursor-pointer flex-col border border-line-strong bg-bg-hi text-left hover:bg-bg-sunk aria-pressed:border-accent aria-pressed:outline aria-pressed:outline-2 aria-pressed:outline-accent"
                  data-media-item={i.name}
                >
                  <span className="block aspect-square w-full overflow-hidden bg-bg-sunk">
                    <Thumb path={i.path} kind={kind} className="size-full object-cover" />
                  </span>
                  <span className="truncate px-2 pt-1 type-caption text-fg">{i.name}</span>
                  <span className="px-2 pb-1 type-caption text-fg-3">{sizeWords(i.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
