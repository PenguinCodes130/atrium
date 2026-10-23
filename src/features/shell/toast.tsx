"use client";
// Toasts and the toaster (design v4 "Toasts"). Call toast.info / success / error / critical, or
// toast.secretsLocked(), from any client component. The <Toaster /> is mounted once by the root layout.
// Each toast is a small window titled "toast · <kind>", 360px wide on desktop (full width minus 32px
// on phones), entering with `sheet` and leaving with `fade`. Over a viewed app the app route group
// mounts <AppToaster />, which puts the same toasts on the floating glass.
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { createToastStore, politenessFor, type ToastInput, type ToastItem, type ToastKind } from "./toast-store";
import { timed, transitionFor } from "./motion";
import { useReducedMotion } from "./use-preferences";
import { useIsPhone } from "./use-viewport";
import { CheckCircleIcon, CloseIcon, ErrorIcon, InfoIcon, LockIcon, WarnIcon } from "./icons";
import { TitleBar } from "./window";

const store = createToastStore();

type Options = Omit<ToastInput, "kind" | "title">;
function make(kind: ToastKind) {
  return (title: string, options: Options = {}) => store.push({ ...options, kind, title });
}

/** The success toast enters this long after the event, so the title bar glow is seen first (design v4 Note 1). */
export const SUCCESS_TOAST_DELAY_MS = 300;

export const toast = Object.assign((input: ToastInput) => (input.kind === "success" ? store.pushAfter(input, SUCCESS_TOAST_DELAY_MS) : store.push(input)), {
  info: make("info"),
  success: (title: string, options: Options = {}) => store.pushAfter({ ...options, kind: "success", title }, SUCCESS_TOAST_DELAY_MS),
  error: make("error"),
  /** Critical alerts only: stays until dismissed. */
  critical: make("critical"),
  /** The "Secrets locked" notice: stays until dismissed. */
  secretsLocked: (options: Options = {}) =>
    store.push({ kind: "secrets-locked", title: "Secrets locked", description: "Atrium cannot read stored credentials until the master key is available.", ...options }),
  dismiss: (id: string) => store.dismiss(id),
  clear: () => store.clear(),
});

export function useToasts() {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

const iconFor: Record<ToastKind, { Icon: typeof InfoIcon; className: string }> = {
  info: { Icon: InfoIcon, className: "text-sky-ink" },
  success: { Icon: CheckCircleIcon, className: "text-ok" },
  error: { Icon: ErrorIcon, className: "text-bad" },
  critical: { Icon: WarnIcon, className: "text-bad" },
  "secrets-locked": { Icon: LockIcon, className: "text-warn-ink" },
};

/** The kind word in the toast's title bar. */
export const KIND_LABEL: Record<ToastKind, string> = { info: "info", success: "success", error: "error", critical: "critical", "secrets-locked": "secrets locked" };

/** Upward swipe (px) or speed (px/s) that dismisses a toast on a phone. */
export const TOAST_SWIPE_PX = 40;
export const TOAST_SWIPE_VELOCITY = 400;

function ToastCard({ item, phone }: { item: ToastItem; phone: boolean }) {
  const reduced = useReducedMotion();
  const { Icon, className } = iconFor[item.kind];
  return (
    <motion.li
      layout={!reduced}
      data-toast={item.kind}
      data-toast-id={item.id}
      data-window="toast"
      className={`pointer-events-auto relative flex w-full flex-col border border-line-strong bg-bg-hi text-fg shadow-window will-change-transform${phone ? " touch-none" : ""}`}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: reduced ? { duration: 0.12 } : timed("fade") }}
      transition={transitionFor("sheet", reduced)}
      // Phones: toasts sit at the top and swipe up to dismiss.
      drag={phone ? "y" : false}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 1, bottom: 0 }}
      dragSnapToOrigin
      onDragEnd={(_, info) => {
        if (info.offset.y < -TOAST_SWIPE_PX || info.velocity.y < -TOAST_SWIPE_VELOCITY) store.dismiss(item.id);
      }}
      data-swipe={phone ? "up" : undefined}
      onPointerEnter={() => store.pause(item.id)}
      onPointerLeave={() => store.resume(item.id)}
      onFocus={() => store.pause(item.id)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) store.resume(item.id);
      }}
      tabIndex={-1}
    >
      <TitleBar title={`toast · ${KIND_LABEL[item.kind]}`} live={item.kind === "success" || item.kind === "info"} />
      <div className="flex items-start gap-3 p-4">
        <Icon className={`mt-px flex-none ${className}`} />
        <div className="min-w-0 flex-1">
          <p className="type-body font-semibold">{item.title}</p>
          {item.description && <p className="mt-0.5 type-body text-fg-2">{item.description}</p>}
          {item.action && (
            <button
              type="button"
              className="mt-2 inline-flex h-8 cursor-pointer items-center type-label text-accent-ink underline underline-offset-4 touch:h-11"
              onClick={() => {
                item.action?.onClick();
                store.dismiss(item.id);
              }}
            >
              {item.action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label={`Dismiss: ${item.title}`}
          className="-m-1 inline-flex size-8 flex-none cursor-pointer items-center justify-center text-fg-2 hover:bg-bg-sunk touch:size-11"
          onClick={() => store.dismiss(item.id)}
        >
          <CloseIcon size={16} />
        </button>
      </div>
    </motion.li>
  );
}

/** Gap kept between the toast stack and a window title bar it would otherwise cover. */
export const TOAST_TITLEBAR_GAP_PX = 8;

/**
 * Bottom offset (px from the viewport bottom) for a desktop toast stack of `rect` size so that it
 * covers no title bar (design v4 Note 1: "never covers a title bar"). It starts at the 24px edge; each
 * title bar it would overlap pushes the stack up to sit above that bar. Overlapping window bodies is
 * fine. If no position fits on screen, it stays at the edge.
 */
export function toastOffsetAvoiding(stack: { width: number; height: number; right: number }, bars: { top: number; bottom: number; left: number; right: number }[], viewportH: number, edge = 24): number {
  let offset = edge;
  for (let guard = 0; guard < 24; guard++) {
    const bottom = viewportH - offset;
    const top = bottom - stack.height;
    const left = stack.right - stack.width;
    const hit = bars.find((b) => b.left < stack.right && b.right > left && b.top < bottom && b.bottom > top);
    if (!hit) return offset;
    offset = viewportH - hit.top + TOAST_TITLEBAR_GAP_PX;
    if (offset + stack.height > viewportH - 8) return edge;
  }
  return edge;
}

function useTitleBarAvoidance(ref: RefObject<HTMLElement | null>, active: boolean, count: number): number {
  const [offset, setOffset] = useState(24);
  useEffect(() => {
    if (!active) return setOffset(24);
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        const list = el.querySelector("ol");
        const height = list?.getBoundingClientRect().height ?? 0;
        if (!height) return setOffset(24);
        const width = el.getBoundingClientRect().width;
        const right = window.innerWidth - 24;
        const bars = [...document.querySelectorAll<HTMLElement>("[data-titlebar]")]
          .filter((b) => !el.contains(b) && b.offsetParent !== null)
          .map((b) => b.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0);
        setOffset(toastOffsetAvoiding({ width, height, right }, bars, window.innerHeight));
      });
    };
    measure();
    window.addEventListener("scroll", measure, { passive: true, capture: true });
    window.addEventListener("resize", measure);
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", measure, { capture: true } as EventListenerOptions);
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, [active, count, ref]);
  return offset;
}

export function Toaster() {
  const { visible } = useToasts();
  const isPhone = useIsPhone();
  const section = useRef<HTMLElement>(null);
  const bottom = useTitleBarAvoidance(section, !isPhone && visible.length > 0, visible.length);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const announced = useRef(new Set<string>());

  // Announce each new toast once, in the live region that matches its politeness.
  useEffect(() => {
    for (const item of visible) {
      if (announced.current.has(item.id)) continue;
      announced.current.add(item.id);
      const text = item.description ? `${item.title}. ${item.description}` : item.title;
      if (politenessFor(item.kind) === "assertive") setAssertive(text);
      else setPolite(text);
    }
  }, [visible]);

  return (
    <>
      <div aria-live="polite" aria-atomic="true" role="status" className="sr-only" data-toast-announcer="polite">
        {polite}
      </div>
      <div aria-live="assertive" aria-atomic="true" role="alert" className="sr-only" data-toast-announcer="assertive">
        {assertive}
      </div>
      <section
        ref={section}
        aria-label="Notifications"
        data-toaster={isPhone ? "phone" : "desktop"}
        data-toast-offset={isPhone ? undefined : bottom}
        className={
          isPhone
            ? "pointer-events-none fixed inset-x-4 top-[calc(env(safe-area-inset-top,0px)+8px)] z-[60]"
            : "pointer-events-none fixed right-6 z-[60] w-(--toast-width)"
        }
        style={isPhone ? undefined : { bottom }}
      >
        <ol className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {visible.map((item) => (
              <ToastCard key={item.id} item={item} phone={isPhone} />
            ))}
          </AnimatePresence>
        </ol>
      </section>
    </>
  );
}

/**
 * Mount inside the (app) route group (architecture v3 A1.6): while a viewed app is open, toasts use
 * the floating glass. It renders nothing itself; the root <Toaster /> draws the toasts.
 */
export function AppToaster() {
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-toast-surface", "float");
    return () => root.removeAttribute("data-toast-surface");
  }, []);
  return null;
}
