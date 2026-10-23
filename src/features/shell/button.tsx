"use client";
// Button primitive (design v4 "Buttons"). Six styles, square, body type at weight 500 with -0.01em
// tracking (settings r2 SFR, w2-r1 item 17: -0.02em left 2.7px word spaces at 15px) and the shell word
// spacing token (settings r3 SFR, w2-r2 item 8), 36px tall with a pointer and 44px on touch. Pressing moves the button 4px right and 4px
// down into the pressed shadow (2px) with the `press` spring; the shadow swaps, it never animates.
// Reduced motion: the shadow swaps with no movement. Disabled: 40% opacity, no shadow, no hover.
//   primary              gold fill, ink text, 1px ink border, 3px hard shadow; hover pale gold. One per view.
//   secondary            raised paper, strong border, ink text.
//   ink                  ink fill, paper text (dark: raised fill, fg text, 1px border). Commit actions in a window.
//   quiet                no fill, secondary text, sunk fill on hover. Toolbars.
//   destructive          no fill, 1px red border and red text.
//   destructive-confirm  red fill with #FBF9F3 text (light) or #15130F (dark). The final confirm.
import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { springs } from "./motion";
import { useReducedMotion } from "./use-preferences";

export type ButtonVariant = "primary" | "secondary" | "ink" | "quiet" | "destructive" | "destructive-confirm";

const base =
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-none type-body font-medium tracking-[-0.01em] [word-spacing:var(--type-word-spacing)] " +
  "h-9 min-w-9 touch:h-11 touch:min-w-11 cursor-pointer [&>svg]:flex-none " +
  "disabled:cursor-default disabled:opacity-40 disabled:shadow-none aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:shadow-none";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg border border-line-strong hover:bg-accent-hi disabled:hover:bg-accent aria-disabled:hover:bg-accent",
  secondary: "bg-bg-hi text-fg border border-line-strong hover:bg-bg-sunk disabled:hover:bg-bg-hi aria-disabled:hover:bg-bg-hi",
  ink: "bg-fg text-bg border border-fg hover:bg-accent hover:text-accent-fg hover:border-line-strong dark:bg-bg-hi dark:text-fg dark:border-line-strong disabled:hover:bg-fg disabled:hover:text-bg",
  quiet: "bg-transparent text-fg-2 hover:bg-bg-sunk hover:text-fg disabled:hover:bg-transparent aria-disabled:hover:bg-transparent",
  destructive: "bg-transparent text-bad border border-bad hover:bg-bg-sunk disabled:hover:bg-transparent",
  "destructive-confirm": "bg-bad text-bad-confirm-fg border border-bad",
};

/** Resting shadow per style (swapped for the pressed shadow while pressed). */
const resting: Record<ButtonVariant, string> = {
  primary: "shadow-window-sm",
  secondary: "",
  ink: "",
  quiet: "",
  destructive: "",
  "destructive-confirm": "",
};
/** Styles that move into the pressed shadow. Quiet toolbar buttons do not move. */
const PRESSABLE = new Set<ButtonVariant>(["primary", "secondary", "ink", "destructive", "destructive-confirm"]);

/** The press offset (design v4 --shadow-pressed: translate 4px, 4px). */
export const PRESS_OFFSET_PX = 4;

export function buttonClass(variant: ButtonVariant = "secondary", extra?: string, iconOnly = false, pressed = false): string {
  const shadow = pressed && PRESSABLE.has(variant) ? "shadow-pressed" : resting[variant];
  return `${base} ${variants[variant]}${shadow ? ` ${shadow}` : ""}${iconOnly ? " w-9 touch:w-11" : " px-4"}${extra ? ` ${extra}` : ""}`;
}

type Common = { variant?: ButtonVariant; iconOnly?: boolean; children?: ReactNode; className?: string };
type AsButton = Common & Omit<ComponentPropsWithoutRef<"button">, keyof Common | "onAnimationStart" | "onDrag" | "onDragStart" | "onDragEnd"> & { href?: undefined };
type AsLink = Common & { href: string; prefetch?: boolean; disabled?: boolean } & Omit<ComponentPropsWithoutRef<"a">, keyof Common | "href" | "onAnimationStart" | "onDrag" | "onDragStart" | "onDragEnd">;
export type ButtonProps = AsButton | AsLink;

const MotionLink = motion.create(Link);

export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(function Button(props, ref) {
  const reduced = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  const { variant = "secondary", iconOnly = false, className, children, ...rest } = props;
  const isLink = typeof (rest as AsLink).href === "string";
  const disabled = Boolean((rest as AsButton).disabled);
  const pressable = PRESSABLE.has(variant) && !disabled;
  const cls = buttonClass(variant, className, iconOnly, pressed && pressable);
  const offset = pressed && pressable && !reduced ? PRESS_OFFSET_PX : 0;
  const motionProps = {
    animate: { x: offset, y: offset },
    transition: reduced ? { duration: 0 } : springs.press,
    onTapStart: () => pressable && setPressed(true),
    onTap: () => setPressed(false),
    onTapCancel: () => setPressed(false),
    "data-variant": variant,
    "data-pressed": pressed && pressable ? "" : undefined,
  };
  if (isLink) {
    const { href, disabled: linkDisabled, ...anchor } = rest as AsLink;
    return (
      <MotionLink ref={ref as Ref<HTMLAnchorElement>} href={href} className={cls} aria-disabled={linkDisabled ? true : undefined} {...motionProps} {...anchor}>
        {children}
      </MotionLink>
    );
  }
  const { type = "button", ...button } = rest as AsButton;
  return (
    <motion.button ref={ref as Ref<HTMLButtonElement>} type={type} className={cls} disabled={disabled} {...motionProps} {...button}>
      {children}
    </motion.button>
  );
});
