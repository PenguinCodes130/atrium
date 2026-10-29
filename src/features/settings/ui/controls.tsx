"use client";
// Design-system form controls for settings (settings gauntlet w2-r1 item 6; design v4 "Buttons",
// "Radius": every shell input is square). Native radios, checkboxes, file pickers, selects and bare
// numeric inputs are replaced by:
//   ChoiceGroup   square segmented choices, or rows with an ink-fill square radio (role radiogroup,
//                 arrow keys move and select, one tab stop)
//   Checkbox      a square box whose check draws in with the `pop` spring (instant under reduced motion)
//   FileField     a Secondary button plus the chosen file name in mono, 44px tall on touch
//   SelectMenu    the shell's square menu (Radix Select drawn like the account menu)
//   RangeField    a square slider with a mono readout you can also type into (the range is named)
// One label style (`type-label`), one input height (36px with a pointer, 44px on touch). Other
// subsystems (app-builder's app settings and New app sheet) can import these from
// "@/features/settings/ui/controls".
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { Select, Slider } from "radix-ui";
import { Button, transitionFor, useReducedMotion } from "@/features/shell";

/** The one text input style: square, 36px with a pointer, 44px on touch. */
export const INPUT_CLASS = "h-9 w-full min-w-0 border border-line-strong bg-bg-hi px-2 type-body text-fg touch:h-11 aria-[invalid=true]:border-bad";
/**
 * The mono input look without a width (colours, numbers, paths). Settings r3 (gauntlet w2-r2 item 2):
 * the width lives apart, because Tailwind orders `w-full` after `w-20` and a combined class could never
 * be narrowed, which collapsed every RangeField slider to 0px.
 */
export const MONO_FIELD_CLASS = "h-9 min-w-0 border border-line-strong bg-bg-hi px-2 font-mono text-[13px] text-fg touch:h-11 aria-[invalid=true]:border-bad";
/** The mono input at full width. */
export const MONO_INPUT_CLASS = `${MONO_FIELD_CLASS} w-full`;
/** The one field label style. */
export const LABEL_CLASS = "type-label text-fg-2";

/** A labelled field: label above, control, then an optional hint and error. */
export function Field({ label, hint, error, children, className, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ""}`}>
      <label htmlFor={htmlFor} className={LABEL_CLASS}>{label}</label>
      {children}
      {hint && <span className="type-caption text-fg-2">{hint}</span>}
      {error && <span role="alert" className="type-caption text-bad">{error}</span>}
    </div>
  );
}

export type ChoiceOption<T extends string | number> = { value: T; label: ReactNode; description?: ReactNode; data?: Record<string, string> };

/**
 * A single choice. `look="segmented"` draws square segments in a row that wraps (each at least 44 x 44
 * on touch); `look="rows"` draws one row per option with a square radio that fills with ink.
 */
export function ChoiceGroup<T extends string | number>({
  label,
  value,
  options,
  onChange,
  look = "segmented",
  name,
  hideLabel,
  className,
  columns,
}: {
  label: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange(v: T): void;
  look?: "segmented" | "rows";
  name?: string;
  hideLabel?: boolean;
  className?: string;
  /** Segmented only: an even grid of this many equal columns instead of a wrapping row. */
  columns?: number;
}) {
  const reduced = useReducedMotion();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const labelId = useId();
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const move = (e: KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ""}`} data-field={name} data-choice-group={look}>
      <span id={labelId} className={hideLabel ? "sr-only" : LABEL_CLASS}>{label}</span>
      <div role="radiogroup" aria-labelledby={labelId} className={look === "segmented" ? (columns ? "grid pr-px pb-px" : "flex flex-wrap") : "flex flex-col"} style={look === "segmented" && columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
        {options.map((o, i) => {
          const on = o.value === value;
          const common = {
            ref: (el: HTMLButtonElement | null) => { refs.current[i] = el; },
            type: "button" as const,
            role: "radio",
            "aria-checked": on,
            tabIndex: i === index ? 0 : -1,
            onClick: () => onChange(o.value),
            onKeyDown: (e: KeyboardEvent) => move(e, i),
            ...(o.data ? Object.fromEntries(Object.entries(o.data).map(([k, v]) => [`data-${k}`, v])) : {}),
          };
          if (look === "segmented") {
            return (
              <button
                key={String(o.value)}
                {...common}
                className={`-mr-px -mb-px inline-flex min-w-11 cursor-pointer items-center justify-center border border-line-strong type-label ${columns ? "min-h-11 flex-col gap-1.5 px-1.5 py-2 text-center" : "h-9 px-3 touch:h-11"} ${on ? "relative z-[1] bg-fg text-bg" : "bg-bg-hi text-fg hover:bg-bg-sunk"}`}
              >
                {o.label}
              </button>
            );
          }
          return (
            <button key={String(o.value)} {...common} className="flex min-h-11 cursor-pointer items-start gap-3 py-2.5 text-left">
              <span aria-hidden className="mt-[3px] inline-flex size-4 flex-none items-center justify-center border border-[color:var(--ink)] bg-bg-hi dark:border-line-strong" data-radio-box={on ? "on" : "off"}>
                <motion.span className="size-2 bg-[color:var(--ink)] dark:bg-fg" initial={false} animate={{ scale: on ? 1 : 0, opacity: on ? 1 : 0 }} transition={transitionFor("pop", reduced)} />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="type-body text-fg">{o.label}</span>
                {o.description && <span className="type-caption text-fg-2">{o.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A square checkbox with a `pop` check. The whole row is the control (44px on touch). */
export function Checkbox({ checked, onCheckedChange, label, description, tone = "default", className, ...data }: { checked: boolean; onCheckedChange(v: boolean): void; label: ReactNode; description?: ReactNode; tone?: "default" | "danger"; className?: string } & Record<`data-${string}`, string | boolean | undefined>) {
  const reduced = useReducedMotion();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={`flex min-h-11 w-full cursor-pointer items-start gap-3 py-2.5 text-left ${className ?? ""}`}
      {...data}
    >
      <span aria-hidden className={`mt-[3px] inline-flex size-4 flex-none items-center justify-center border ${tone === "danger" ? "border-bad" : "border-[color:var(--ink)] dark:border-line-strong"} ${checked ? (tone === "danger" ? "bg-bad" : "bg-[color:var(--ink)] dark:bg-fg") : "bg-bg-hi"}`} data-check-box={checked ? "on" : "off"}>
        <motion.svg viewBox="0 0 12 12" className="size-3" initial={false} animate={{ scale: checked ? 1 : 0.97, opacity: checked ? 1 : 0 }} transition={transitionFor("pop", reduced)}>
          <path d="M2.5 6.2 5 8.6 9.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" className={tone === "danger" ? "text-bad-confirm-fg" : "text-bg"} />
        </motion.svg>
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="type-body text-fg">{label}</span>
        {description && <span className="type-caption text-fg-2">{description}</span>}
      </span>
    </button>
  );
}

/** A file picker drawn as a Secondary button with the chosen file's name in mono. */
export function FileField({ label, accept, file, onFile, buttonLabel = "Choose file", emptyText = "no file chosen", ...data }: { label: string; accept?: string; file: File | null; onFile(f: File | null): void; buttonLabel?: string; emptyText?: string } & Record<`data-${string}`, string | boolean | undefined>) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span id={`${id}-label`} className={LABEL_CLASS}>{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <input ref={input} id={id} type="file" accept={accept} className="sr-only" aria-labelledby={`${id}-label`} tabIndex={-1} onChange={(e) => onFile(e.target.files?.[0] ?? null)} {...data} />
        <Button variant="secondary" onClick={() => input.current?.click()} aria-describedby={`${id}-name`} data-file-button>{buttonLabel}</Button>
        <span id={`${id}-name`} className="min-w-0 truncate font-mono text-[13px] text-fg-2" data-file-name>{file ? file.name : emptyText}</span>
      </div>
    </div>
  );
}

/**
 * The shell's square menu as a select. Also used by auth's Users panel (settings r3 shared file request,
 * gauntlet w2-r2): `size="large"` is 44px everywhere to line up with 44px buttons, `labelClassName`
 * keeps a panel's own label style, `disabled` and `invalid` behave like a native select's.
 */
export function SelectMenu<T extends string>({ label, value, options, onChange, name, hideLabel, disabled, invalid, size = "default", labelClassName, className }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange(v: T): void; name?: string; hideLabel?: boolean; disabled?: boolean; invalid?: boolean; size?: "default" | "large"; labelClassName?: string; className?: string }) {
  const id = useId();
  const reduced = useReducedMotion();
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ""}`} data-field={name}>
      <label id={`${id}-l`} htmlFor={id} className={hideLabel ? "sr-only" : (labelClassName ?? LABEL_CLASS)}>{label}</label>
      <Select.Root value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
        <Select.Trigger id={id} aria-labelledby={`${id}-l`} aria-invalid={invalid || undefined} className={`flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 border border-line-strong bg-bg-hi px-2 text-left type-body text-fg data-[state=open]:bg-bg-sunk disabled:cursor-default disabled:opacity-40 aria-[invalid=true]:border-bad ${size === "large" ? "h-11" : "h-9 touch:h-11"}`} data-select={name}>
          <Select.Value />
          <Select.Icon aria-hidden className="flex-none font-mono text-[11px] text-fg-2">▾</Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content position="popper" sideOffset={4} className="z-50 max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] border border-line-strong bg-bg-hi p-1.5 text-fg shadow-window-sm" data-select-menu={name}>
            <motion.div initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={transitionFor("pop", reduced)}>
              <Select.Viewport>
                {options.map((o) => (
                  <Select.Item key={o.value} value={o.value} className="flex min-h-9 cursor-pointer select-none items-center justify-between gap-3 px-2 type-body text-fg outline-none data-[highlighted]:bg-fg data-[highlighted]:text-bg touch:min-h-11" data-option={o.value}>
                    <Select.ItemText>{o.label}</Select.ItemText>
                    <Select.ItemIndicator aria-hidden className="font-mono text-[11px]">■</Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </motion.div>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

/**
 * A ranged number: a square slider plus a mono readout that also takes typing. Typed values outside
 * the range are refused at the field by the caller's `error` (the slider itself cannot leave it).
 * Settings r3 (gauntlet w2-r2 item 2): the track fills the row beside an 80px readout (at least 200px
 * on a 390px phone), the thumb sits at the value and grows on `pop` while it is held (instant under
 * reduced motion); a pointer or a finger drags it.
 */
// Wave 2.10a B3: `rangeText` replaces the "(min to max)" note and `valueText` is read out for the thumb,
// for a slider whose last stop is a word (the control radius's Pill).
export function RangeField({ label, min, max, step, value, text, onSlide, onType, error, name, rangeText, valueText, note }: { label: string; min: number; max: number; step: number; value: number; text: string; onSlide(v: number): void; onType(text: string): void; error?: string; name?: string; rangeText?: string; valueText?: string; note?: string }) {
  const id = useId();
  const reduced = useReducedMotion();
  const clamped = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-range={name}>
      <label htmlFor={id} className={LABEL_CLASS}>{label} <span className="text-fg-3">({rangeText ?? `${min} to ${max}`})</span></label>
      <div className="flex min-w-0 items-center gap-3">
        <Slider.Root min={min} max={max} step={step} value={[clamped]} onValueChange={([v]) => v !== undefined && onSlide(v)} className="relative flex h-9 min-w-24 flex-1 cursor-pointer touch-none select-none items-center touch:h-11" aria-label={label} data-slider={name}>
          <Slider.Track className="relative h-1 grow border border-line-strong bg-bg-sunk" data-slider-track>
            <Slider.Range className="absolute h-full bg-[color:var(--ink)] dark:bg-fg" />
          </Slider.Track>
          <Slider.Thumb asChild aria-label={label} {...(valueText ? { "aria-valuetext": valueText } : {})}>
            <motion.span
              className="block size-4 cursor-grab border border-[color:var(--ink)] bg-accent outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ink)] active:cursor-grabbing touch:size-6 dark:border-line-strong dark:focus-visible:ring-fg"
              whileTap={reduced ? undefined : { scale: 1.25 }}
              transition={transitionFor("pop", reduced)}
              data-slider-thumb
            />
          </Slider.Thumb>
        </Slider.Root>
        <input id={id} inputMode="decimal" value={text} onChange={(e) => onType(e.target.value)} className={`${MONO_FIELD_CLASS} w-20 flex-none text-right`} data-field={name} aria-invalid={!!error} />
      </div>
      {note && <span className="type-caption text-fg-2" data-range-note={name}>{note}</span>}
      {error && <span role="alert" className="type-caption text-bad" data-field-error={name}>{error}</span>}
    </div>
  );
}

/** A rotating chevron for folds (design v4 `pop`; the same fold as the builder inspector). */
export function FoldChevron({ open }: { open: boolean }) {
  const reduced = useReducedMotion();
  return (
    <motion.svg viewBox="0 0 12 12" width="12" height="12" aria-hidden className="flex-none text-fg-2" data-fold-chevron={open ? "open" : "closed"} initial={false} animate={{ rotate: open ? 90 : 0 }} transition={transitionFor("pop", reduced)}>
      <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </motion.svg>
  );
}

/**
 * A folding group (settings gauntlet w2-r2 item 7): a chevron that turns on `pop`, a body that opens on
 * `sheet` (instant under reduced motion). The body stays mounted while closed (inert and hidden), so a
 * half-typed field keeps its text and its error.
 */
export function Fold({ title, open, onToggle, children, name, foldRef, bodyClassName }: { title: ReactNode; open: boolean; onToggle(open: boolean): void; children: ReactNode; name: string; foldRef?: (el: HTMLElement | null) => void; bodyClassName?: string }) {
  const id = useId();
  const reduced = useReducedMotion();
  return (
    <section ref={foldRef} className="border border-line-strong bg-bg-hi" data-group={name} data-open={open ? "true" : "false"}>
      <h3 className="m-0">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => onToggle(!open)} className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-left type-label text-fg hover:bg-bg-sunk" data-group-toggle={name}>
          <FoldChevron open={open} />
          <span className="flex-1">{title}</span>
        </button>
      </h3>
      <motion.div
        id={id}
        className="overflow-hidden"
        initial={false}
        animate={open ? { height: "auto", visibility: "visible" } : { height: 0, transitionEnd: { visibility: "hidden" } }}
        transition={transitionFor("sheet", reduced)}
        inert={!open}
        data-fold-body={name}
      >
        <div className={bodyClassName}>{children}</div>
      </motion.div>
    </section>
  );
}
