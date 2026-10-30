"use client";
// Wave 2.10b F10 ("show, don't name", design v4 Note 2 "Pickers show, not name"): the small drawn
// samples beside each theme choice, and the font picker whose rows are drawn in their own family.
// Every sample is aria-hidden and holds no text nodes (digits and letters are drawn with CSS `content`),
// so a choice's accessible name and text stay its plain label ("Dark", "Frosted glass").
// Colours: the theme's own values where the sample shows the theme (mode, wallpaper, materials), and
// the shell's ink and line roles for the neutral drawings (border, shadow, density, entrance, nav).
import { useId, type CSSProperties, type ReactNode } from "react";
import { Select } from "radix-ui";
import { motion } from "motion/react";
import type { Theme, ThemeTokens } from "@/core/contracts";
import { transitionFor, useReducedMotion } from "@/features/shell";
import { THEME_FONT_KINDS, THEME_FONT_KIND_LABELS, THEME_FONT_STACKS, resolveTokens, type ThemeFontFamily, type ThemeFontKind } from "@/features/shell/theme";
import { LABEL_CLASS } from "./controls";

/** The frame every sample sits in: 44 x 26 px, drawn above the choice's label. */
function Frame({ children, style, className }: { children?: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <span aria-hidden data-choice-sample className={`relative block h-[26px] w-11 flex-none overflow-hidden border border-line-strong ${className ?? ""}`} style={style}>
      {children}
    </span>
  );
}
/** A mini card inside a sample frame. */
function Card({ style, className }: { style?: CSSProperties; className?: string }) {
  return <span className={`absolute inset-x-[7px] inset-y-[5px] block ${className ?? ""}`} style={style} />;
}

const STRIPES = (a: string, b: string) => `repeating-linear-gradient(135deg, ${a} 0 5px, ${b} 5px 10px)`;

function wallpaperBg(w: ThemeTokens["wallpaper"]): string {
  if (w.kind === "color") return w.value;
  if (w.kind === "gradient") return w.value;
  if (w.kind === "sky") return w.colors ? `linear-gradient(100deg, ${w.colors[0]} 0%, ${w.colors[0]} 30%, ${w.colors[1]} 100%)` : "var(--bg-sunk)";
  if (w.kind === "image" && w.value.startsWith("/uploads/")) return `center / cover url("${w.value}")`;
  return "var(--bg-hi)";
}

// ---- the sweep's samples, one function per picker ----

export function ModeSample({ theme, mode }: { theme: Theme; mode: Theme["mode"] }) {
  const light = theme.tokens;
  const dark = theme.mode === "auto" && theme.dark ? resolveTokens(theme, "dark") : null;
  const lightFill = { background: light.color.surface, borderColor: light.color.surfaceText };
  // Dark with no dark set: the theme's own colours as a dark-mode theme draws them (the surface is the
  // theme's surface, so a dark theme shows dark); Auto: split light and dark.
  const darkSet = dark ?? light;
  if (mode === "light") return <Frame style={{ background: wallpaperBg(light.wallpaper) }}><Card className="border" style={lightFill} /></Frame>;
  if (mode === "dark") return <Frame style={{ background: "var(--ink, #15130F)" }}><Card className="border" style={{ background: dark ? darkSet.color.surface : "color-mix(in oklab, var(--ink, #15130F) 80%, white)", borderColor: dark ? darkSet.color.surfaceText : "transparent" }} /></Frame>;
  return (
    <Frame style={{ background: `linear-gradient(135deg, ${light.color.surface} 50%, var(--ink, #15130F) 50%)` }}>
      <Card className="border" style={{ background: `linear-gradient(135deg, ${light.color.surface} 50%, ${dark ? darkSet.color.surface : "color-mix(in oklab, var(--ink, #15130F) 80%, white)"} 50%)`, borderColor: light.color.line }} />
    </Frame>
  );
}

export function WallpaperSample({ kind, w }: { kind: ThemeTokens["wallpaper"]["kind"]; w: ThemeTokens["wallpaper"] }) {
  // The current wallpaper when it is this kind; otherwise a plain picture of the kind.
  const own = w.kind === kind ? wallpaperBg(w) : null;
  if (kind === "none") return <Frame className="bg-bg-hi"><span className="absolute inset-0 block" style={{ background: "linear-gradient(to top right, transparent calc(50% - 0.5px), var(--line-strong) 50%, transparent calc(50% + 0.5px))" }} /></Frame>;
  if (kind === "color") return <Frame style={{ background: own ?? "var(--accent)" }} />;
  if (kind === "gradient") return <Frame style={{ background: own ?? "linear-gradient(180deg, var(--accent), var(--bg-hi))" }} />;
  if (kind === "sky") return <Frame style={{ background: own ?? "linear-gradient(100deg, var(--bg-hi) 0%, var(--bg-hi) 30%, var(--accent) 100%)" }} />;
  return (
    <Frame style={own ? { background: own } : { background: "var(--bg-hi)" }}>
      {!own && (
        <>
          <span className="absolute left-[9px] top-[5px] block size-[5px] rounded-full bg-[color:var(--accent)]" />
          <span className="absolute inset-x-0 bottom-0 block h-[11px] bg-fg-3" style={{ clipPath: "polygon(0 100%, 30% 20%, 55% 70%, 75% 35%, 100% 100%)" }} />
        </>
      )}
    </Frame>
  );
}

/** Solid, Gradient or Frosted glass, drawn over a striped wallpaper so glass shows what it does. */
export function MaterialSample({ material, fill, gradient, opacity, blurPx, ink }: { material: "solid" | "gradient" | "glass"; fill: string; gradient?: [string, string]; opacity?: number; blurPx?: number; ink: string }) {
  const style: CSSProperties =
    material === "glass"
      ? { background: `color-mix(in oklab, ${fill} ${Math.round(Math.max(0.3, Math.min(1, opacity ?? 0.6)) * 100)}%, transparent)`, backdropFilter: `blur(${Math.max(2, Math.min(8, Math.round((blurPx ?? 16) / 3)))}px)`, borderColor: ink }
      : material === "gradient"
        ? { background: `linear-gradient(135deg, ${gradient?.[0] ?? fill}, ${gradient?.[1] ?? "var(--accent)"})`, borderColor: ink }
        : { background: fill, borderColor: ink };
  return (
    <Frame style={{ background: STRIPES(ink, "var(--accent)") }}>
      <Card className="border" style={style} />
    </Frame>
  );
}

export function BorderSample({ width }: { width: 0 | 1 | 2 }) {
  return <Frame className="bg-bg-sunk"><Card className="bg-bg-hi" style={{ border: `${width}px solid var(--ink, currentColor)` }} /></Frame>;
}

export function ShadowSample({ shadow }: { shadow: "none" | "soft" | "hard" }) {
  const box = shadow === "hard" ? "3px 3px 0 0 var(--ink, #15130F)" : shadow === "soft" ? "0 4px 8px oklch(0.2 0.02 70 / 0.35)" : "none";
  return <Frame className="bg-bg-sunk"><span className="absolute left-[8px] top-[4px] block h-[14px] w-[24px] border border-line-strong bg-bg-hi" style={{ boxShadow: box }} /></Frame>;
}

export function NumbersSample({ numbers }: { numbers: "tabular" | "proportional" }) {
  // Two rows of digits, right-aligned: tabular rows line up, proportional ones do not.
  const fv = numbers === "tabular" ? "tabular-nums" : "proportional-nums";
  return (
    <Frame className="flex flex-col items-end justify-center bg-bg-hi px-1 font-sans leading-[11px] text-fg">
      <span className="block text-[10px] before:content-[attr(data-digits)]" data-digits="1111" style={{ fontVariantNumeric: fv }} />
      <span className="block text-[10px] before:content-[attr(data-digits)]" data-digits="8088" style={{ fontVariantNumeric: fv }} />
    </Frame>
  );
}

export function WeightSample({ weight, family }: { weight: number; family: string }) {
  return <Frame className="flex items-center justify-center bg-bg-hi text-fg"><span className="block text-[15px] leading-none before:content-['Aa']" style={{ fontWeight: weight, fontFamily: family }} /></Frame>;
}

export function DensitySample({ density }: { density: "comfortable" | "compact" }) {
  // Two stacked mini cards: Compact draws them tighter, with less padding and a smaller gap.
  const c = density === "compact";
  return (
    <Frame className={`flex flex-col bg-bg-sunk ${c ? "gap-[2px] p-[3px]" : "gap-[4px] p-[2px]"}`}>
      {[0, 1].map((i) => (
        <span key={i} className={`block flex-1 border border-line-strong bg-bg-hi ${c ? "px-[3px] py-[1px]" : "px-[5px] py-[2px]"}`}>
          <span className="block h-[2px] w-1/2 bg-fg-3" />
        </span>
      ))}
    </Frame>
  );
}

export function EntranceSample({ enter }: { enter: "none" | "fade" | "rise" | "sweep" }) {
  // A still of each entrance mid-way: none (in place), fade (half see-through), rise (lifted, with its
  // starting place dashed), sweep (a band of light across the card). Play shows them moving.
  return (
    <Frame className="bg-bg-sunk">
      {enter === "rise" && <span className="absolute inset-x-[9px] bottom-[3px] top-[9px] block border border-dashed border-line-strong" />}
      <span className={`absolute block border border-line-strong bg-bg-hi ${enter === "rise" ? "inset-x-[9px] bottom-[8px] top-[4px]" : "inset-x-[9px] inset-y-[5px]"}`} style={{ opacity: enter === "fade" ? 0.45 : 1 }}>
        {enter === "sweep" && <span className="absolute inset-0 block" style={{ background: "linear-gradient(100deg, transparent 30%, color-mix(in oklab, var(--accent) 80%, transparent) 50%, transparent 70%)" }} />}
      </span>
    </Frame>
  );
}

export function NavStyleSample({ style }: { style: ThemeTokens["chrome"]["style"] }) {
  // A mini nav of three items, the second active, as each style draws it (design Note 2).
  const items = [0, 1, 2];
  return (
    <Frame className={`flex bg-bg-hi px-[3px] ${style === "boxed-tabs" ? "items-end gap-[2px] border-b-0" : style === "bar" ? "items-stretch" : "items-center gap-[2px]"}`}>
      {style === "boxed-tabs" && <span className="absolute inset-x-0 bottom-0 block h-px bg-[color:var(--ink,currentColor)]" />}
      {items.map((i) => {
        const on = i === 1;
        const base = "relative block w-[11px] flex-none";
        if (style === "bar") return <span key={i} className={`${base} ${on ? "bg-fg" : ""}`}><span className={`absolute inset-x-[2px] top-1/2 block h-[2px] -translate-y-1/2 ${on ? "bg-bg-hi" : "bg-fg-3"}`} /></span>;
        if (style === "boxed-tabs") return <span key={i} className={`${base} h-[13px] rounded-t-[3px] border border-[color:var(--ink,currentColor)] ${on ? "border-b-0 bg-fg" : "bg-bg-hi"}`} />;
        if (style === "pills") return <span key={i} className={`${base} h-[10px] rounded-full ${on ? "bg-fg" : "bg-transparent"}`}><span className={`absolute inset-x-[3px] top-1/2 block h-[2px] -translate-y-1/2 ${on ? "bg-bg-hi" : "bg-fg-3"}`} /></span>;
        return <span key={i} className={`${base} h-[10px]`}><span className={`absolute inset-x-[2px] top-1/2 block h-[2px] -translate-y-1/2 ${on ? "bg-fg" : "bg-fg-3"}`} />{on && <span className="absolute inset-x-0 bottom-0 block h-[2px] bg-[color:var(--accent)]" />}</span>;
      })}
    </Frame>
  );
}

/** A choice's label with its sample drawn above it (for ChoiceGroup's `columns` look). */
export function Sampled({ sample, children }: { sample: ReactNode; children: ReactNode }) {
  return (
    <>
      {sample}
      <span>{children}</span>
    </>
  );
}

// ---- the font picker (F10) ----

const KIND_ORDER: ThemeFontKind[] = ["sans", "serif", "mono", "display", "rounded"];

/**
 * The font menu: every built-in family grouped by kind, each row's name drawn in its own family (its
 * file loads only when the row is shown), then the theme's uploaded families. The trigger shows the
 * chosen family in itself too. Same data hooks as SelectMenu (data-select, data-select-menu, data-option).
 */
export function FontSelect({ label, name, value, uploaded, onChange, monoOnly }: { label: string; name: string; value: string; uploaded: readonly string[]; onChange(v: string): void; monoOnly?: boolean }) {
  const id = useId();
  const reduced = useReducedMotion();
  const stack = (f: string) => (f in THEME_FONT_STACKS ? THEME_FONT_STACKS[f as ThemeFontFamily] : `"${f}", var(--font-inter-tight), sans-serif`);
  const families = Object.keys(THEME_FONT_STACKS) as ThemeFontFamily[];
  const groups = KIND_ORDER.map((k) => ({ kind: k, items: families.filter((f) => THEME_FONT_KINDS[f] === k) })).filter((g) => g.items.length && (!monoOnly || g.kind === "mono"));
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-field={name}>
      <label id={`${id}-l`} htmlFor={id} className={LABEL_CLASS}>{label}</label>
      <Select.Root value={value} onValueChange={onChange}>
        <Select.Trigger id={id} aria-labelledby={`${id}-l`} className="flex h-9 w-full min-w-0 cursor-pointer items-center justify-between gap-2 border border-line-strong bg-bg-hi px-2 text-left text-[15px] text-fg data-[state=open]:bg-bg-sunk touch:h-11" data-select={name} style={{ fontFamily: stack(value) }}>
          <Select.Value />
          <Select.Icon aria-hidden className="flex-none font-mono text-[11px] text-fg-2">▾</Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content position="popper" sideOffset={4} className="z-50 max-h-[min(420px,var(--radix-select-content-available-height))] min-w-[max(var(--radix-select-trigger-width),240px)] border border-line-strong bg-bg-hi p-1.5 text-fg shadow-window-sm" data-select-menu={name}>
            <motion.div initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={transitionFor("pop", reduced)}>
              <Select.Viewport>
                {groups.map((g) => (
                  <Select.Group key={g.kind} data-font-group={g.kind}>
                    <Select.Label className="px-2 pb-1 pt-2 type-caption text-fg-2">{THEME_FONT_KIND_LABELS[g.kind]}</Select.Label>
                    {g.items.map((f) => (
                      <Select.Item key={f} value={f} className="flex min-h-9 cursor-pointer select-none items-center justify-between gap-3 px-2 text-[16px] text-fg outline-none data-[highlighted]:bg-fg data-[highlighted]:text-bg touch:min-h-11" data-option={f} data-font-kind={g.kind}>
                        <Select.ItemText><span data-font-name style={{ fontFamily: stack(f) }}>{f}</span></Select.ItemText>
                        <Select.ItemIndicator aria-hidden className="font-mono text-[11px]">■</Select.ItemIndicator>
                      </Select.Item>
                    ))}
                  </Select.Group>
                ))}
                {uploaded.length > 0 && (
                  <Select.Group data-font-group="uploaded">
                    <Select.Label className="px-2 pb-1 pt-2 type-caption text-fg-2">Uploaded</Select.Label>
                    {uploaded.map((f) => (
                      <Select.Item key={f} value={f} className="flex min-h-9 cursor-pointer select-none items-center justify-between gap-3 px-2 text-[16px] text-fg outline-none data-[highlighted]:bg-fg data-[highlighted]:text-bg touch:min-h-11" data-option={f} data-font-kind="uploaded">
                        <Select.ItemText><span data-font-name style={{ fontFamily: stack(f) }}>{f}</span></Select.ItemText>
                        <Select.ItemIndicator aria-hidden className="font-mono text-[11px]">■</Select.ItemIndicator>
                      </Select.Item>
                    ))}
                  </Select.Group>
                )}
              </Select.Viewport>
            </motion.div>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
