"use client";
// Control components (spec 3.1.6, architecture 6.2): button, toggle, slider and select. Each run goes
// to ctx.runControl (which owns the confirm rules, see control-runner.ts); the component shows a
// pending state until the answer, settles or springs back, shows a refusal in place and announces
// every result in a polite live region. In agent-render controls are drawn disabled; in edit mode
// clicks select the component instead of running it.
import { useEffect, useId, useRef, useState } from "react";
import { motion } from "motion/react";
import type { ComponentNode, ControlRunResponse, RenderContext } from "@/core/contracts";
import { transitionFor, useReducedMotion } from "@/features/shell";
import { text as textOf } from "../bindings";
import { useNodeEnv } from "./context";

type P = { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext };
const str = (v: unknown) => textOf(v);
export const SETTLE_TIMEOUT_MS = 8000;

function useRunner(node: ComponentNode, ctx: RenderContext, controlId: string) {
  const { status } = useNodeEnv();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const blocked = status.kind === "not_shared" || status.kind === "not_available" ? status.message : null;
  const disabled = ctx.mode === "agent-render" || !controlId || !!blocked;
  const inert = ctx.mode === "edit";
  async function run(input?: unknown): Promise<ControlRunResponse | null> {
    if (disabled || inert || pending) return null;
    setPending(true);
    setError(null);
    let res: ControlRunResponse;
    try {
      res = await ctx.runControl(node.id, controlId, input);
    } catch {
      res = { ok: false, code: "not_available", message: "Atrium could not be reached." };
    }
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      setAnnounce(res.message);
    } else setAnnounce(res.message ?? "Done");
    return res;
  }
  return { pending, error, announce, setAnnounce, disabled, inert, blocked, run };
}

function Live({ text }: { text: string }) {
  return (
    <span role="status" aria-live="polite" className="sr-only" data-control-announce>
      {text}
    </span>
  );
}

function Message({ error, blocked }: { error: string | null; blocked: string | null }) {
  const m = error ?? blocked;
  return m ? (
    <span className="atr-control-msg" data-control-message>
      {m}
    </span>
  ) : null;
}

export function ButtonView({ node, resolved, ctx }: P) {
  const label = str(resolved.label) || "Run";
  const r = useRunner(node, ctx, str(resolved.control));
  return (
    <div className="atr-control">
      <button
        type="button"
        data-slot="root"
        className="atr-button"
        data-variant={resolved.variant === "secondary" ? "secondary" : "primary"}
        disabled={r.disabled}
        data-disabled={r.disabled ? "" : undefined}
        aria-busy={r.pending || undefined}
        data-pending={r.pending ? "" : undefined}
        onClick={() => void r.run()}
      >
        <span data-slot="label">{label}</span>
        {r.pending ? <span className="atr-spinner" aria-hidden /> : null}
      </button>
      <Message error={r.error} blocked={r.blocked} />
      <Live text={r.announce} />
    </div>
  );
}

export function ToggleView({ node, resolved, ctx }: P) {
  const label = str(resolved.label) || "Switch";
  const reduced = useReducedMotion();
  const state = resolved.state === true || resolved.state === "on" || resolved.state === "true";
  const [desired, setDesired] = useState<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const r = useRunner(node, ctx, str(resolved.control));
  // Settles when the stream confirms the new state.
  useEffect(() => {
    if (desired !== null && state === desired && !r.pending) {
      setDesired(null);
      if (timer.current) clearTimeout(timer.current);
    }
  }, [state, desired, r.pending]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const shown = desired ?? state;
  const id = useId();
  async function flip() {
    if (r.disabled || r.inert || r.pending) return;
    const next = !shown;
    setDesired(next);
    const res = await r.run(next);
    if (!res || !res.ok) {
      setDesired(null); // springs back
      return;
    }
    r.setAnnounce(res.message ?? `${label} ${next ? "on" : "off"}`);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDesired(null), SETTLE_TIMEOUT_MS);
  }
  return (
    <div className="atr-control">
      <button
        type="button"
        role="switch"
        aria-checked={shown}
        aria-labelledby={`${id}-l`}
        data-slot="root"
        className="atr-toggle"
        data-state={shown ? "on" : "off"}
        disabled={r.disabled}
        data-disabled={r.disabled ? "" : undefined}
        aria-busy={r.pending || desired !== null || undefined}
        data-pending={r.pending || desired !== null ? "" : undefined}
        onClick={() => void flip()}
      >
        <span id={`${id}-l`} data-slot="label" className="atr-toggle-label">
          {label}
        </span>
        <span data-slot="track" className="atr-toggle-track" aria-hidden>
          <motion.span data-slot="thumb" className="atr-toggle-thumb" initial={false} animate={{ x: shown ? 20 : 0 }} transition={transitionFor("pop", reduced)} />
        </span>
      </button>
      <Message error={r.error} blocked={r.blocked} />
      <Live text={r.announce} />
    </div>
  );
}

export function SliderView({ node, resolved, ctx }: P) {
  const label = str(resolved.label) || "Level";
  const min = typeof resolved.min === "number" ? resolved.min : 0;
  const max = typeof resolved.max === "number" ? resolved.max : 100;
  const step = typeof resolved.step === "number" && resolved.step > 0 ? resolved.step : 1;
  const bound = typeof resolved.value === "number" ? resolved.value : min;
  const [local, setLocalState] = useState<number | null>(null);
  const localRef = useRef<number | null>(null);
  const setLocal = (v: number | null) => {
    localRef.current = v;
    setLocalState(v);
  };
  const dirty = useRef(false);
  const r = useRunner(node, ctx, str(resolved.control));
  useEffect(() => {
    if (!r.pending && local !== null && local === bound) setLocal(null);
  }, [bound, local, r.pending]);
  const value = local ?? bound;
  const id = useId();
  async function commit() {
    const v = localRef.current;
    if (!dirty.current || v === null) return;
    dirty.current = false;
    const res = await r.run(v);
    if (!res || !res.ok) setLocal(null);
  }
  const frac = Math.min(1, Math.max(0, (value - min) / (max - min || 1)));
  return (
    <div data-slot="root" className="atr-control atr-slider" data-disabled={r.disabled ? "" : undefined} data-pending={r.pending ? "" : undefined}>
      <div className="atr-slider-head">
        <label htmlFor={id} data-slot="label">
          {label}
        </label>
        <span data-slot="value" className="atr-num">
          {value}
          {resolved.unit ? ` ${str(resolved.unit)}` : ""}
        </span>
      </div>
      <div data-slot="track" className="atr-slider-track" style={{ ["--atr-frac" as string]: frac }}>
        <span data-slot="fill" className="atr-slider-fill" aria-hidden />
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={r.disabled}
          aria-busy={r.pending || undefined}
          data-slot="thumb"
          onChange={(e) => {
            if (r.inert) return;
            dirty.current = true;
            setLocal(Number(e.target.value));
          }}
          onPointerUp={() => void commit()}
          onKeyUp={(e) => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) void commit();
          }}
          onBlur={() => void commit()}
        />
      </div>
      <Message error={r.error} blocked={r.blocked} />
      <Live text={r.announce} />
    </div>
  );
}

export function SelectView({ node, resolved, ctx }: P) {
  const label = str(resolved.label) || "Choose";
  const options = (Array.isArray(resolved.options) ? resolved.options : []).filter((o): o is { label: string; value: string } => !!o && typeof o === "object" && typeof (o as { value?: unknown }).value === "string");
  const bound = str(resolved.value);
  const [local, setLocal] = useState<string | null>(null);
  const r = useRunner(node, ctx, str(resolved.control));
  useEffect(() => {
    if (!r.pending && local !== null && local === bound) setLocal(null);
  }, [bound, local, r.pending]);
  const id = useId();
  return (
    <div data-slot="root" className="atr-control atr-select" data-disabled={r.disabled ? "" : undefined}>
      <label htmlFor={id} data-slot="label">
        {label}
      </label>
      <select
        id={id}
        data-slot="field"
        value={local ?? bound}
        disabled={r.disabled}
        aria-busy={r.pending || undefined}
        onChange={async (e) => {
          if (r.inert) return;
          const v = e.target.value;
          if (!options.some((o) => o.value === v)) return;
          setLocal(v);
          const res = await r.run(v);
          if (!res || !res.ok) setLocal(null);
        }}
      >
        {!options.some((o) => o.value === (local ?? bound)) ? <option value={local ?? bound}>{local ?? bound ? local ?? bound : "Choose..."}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Message error={r.error} blocked={r.blocked} />
      <Live text={r.announce} />
    </div>
  );
}
