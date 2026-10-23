"use client";
// TEMPORARY app-shell preview scenes (design v4). Shell scenes render inside the real shell frame.
// The "app" and "signin" scenes cover the frame with a fixed full-screen layer to stand in for routes
// that other subsystems own (app-builder's /a/<slug> viewer, auth's sign-in layout), so the switcher,
// the draft bar, the control confirm and the AuthShell can be checked before those owners mount them.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import {
  AppSwitcher,
  AppToaster,
  AuthShell,
  BUILT_IN_THEMES,
  Button,
  Canvas,
  CanvasSurface,
  ControlConfirm,
  DraftPreviewBar,
  EmptyRoom,
  Glow,
  LightSweep,
  LiveDot,
  ROOM_COPY,
  SettleItem,
  SkeletonGrid,
  StatusCheck,
  StatusMark,
  Switch,
  Tag,
  TypeIn,
  Well,
  Window,
  springs,
  toast,
  useOnline,
  usePageTitle,
  useReducedMotion,
  useShellNav,
  Screen,
  ScreenHeader,
  type ScopedCss,
  type Theme,
  type ThemeFontFamily,
} from "@/features/shell";
import { SignInForm } from "@/features/auth/components";

export type PreviewParams = {
  scene: string;
  theme: "controlRoom" | "daylight" | "dusk" | "solid";
  count: number;
  approvals: number;
  drafts: number;
  forceSweep: boolean;
  drift: string | null;
  toasts: number;
  /** Already scoped on the server (page.tsx). */
  customCss?: ScopedCss;
  /** Override the theme's display and body font (theme font probe). */
  font?: ThemeFontFamily;
  viewer: "user" | "guest";
  canEdit: boolean;
  draft: boolean;
};

const SERVICES = ["pve1 cpu", "rp5-2 certs", "jellyfin", "docker1", "kuma", "pfsense", "n8n", "immich", "grafana", "unifi", "nas01", "backup"];

function DemoWindow({ i, lifted }: { i: number; lifted: boolean }) {
  const online = useOnline();
  const reduced = useReducedMotion();
  const [clicks, setClicks] = useState(0);
  const states = ["up", "up", "warn", "up", "down", "up"] as const;
  const state = states[i % states.length]!;
  const name = SERVICES[i % SERVICES.length]!;
  const words = { up: "up", warn: "slow", down: "down" } as const;
  return (
    <motion.div
      initial={false}
      animate={lifted && !reduced ? { x: -4, y: -4 } : { x: 0, y: 0 }}
      transition={reduced ? { duration: 0 } : springs.lift}
      className={lifted ? "[&>[data-window]]:shadow-lifted" : undefined}
      data-lift={lifted ? "up" : "down"}
    >
      <Window title={`homelab / ${name}`} status={online ? <LiveDot label={words[state]} tone={state === "up" ? "ok" : state === "warn" ? "warn" : "bad"} /> : <span data-stale>stale</span>} data-widget={i + 1}>
        <div className="flex items-baseline justify-between gap-3">
          <p className="type-readout" data-numeric>
            {(31 + i * 7.5).toFixed(1)}
            <span className="ml-0.5 type-body-lg text-fg-2">%</span>
          </p>
          <span className="type-label text-fg-2">8 cores</span>
        </div>
        <Well className="mt-4 flex items-center gap-2">
          <StatusMark state={online ? state : "warn"} label={online ? undefined : "Stale"} />
          <span className="type-label text-fg-2">load {(1.2 + i / 10).toFixed(2)} · 5m</span>
        </Well>
        <div className="mt-4 flex items-center justify-between">
          <span className="type-caption text-fg-3">synced 0.3s ago</span>
          <Button variant="quiet" className="h-8 px-2" onClick={() => setClicks((c) => c + 1)} data-widget-control data-clicks={clicks}>
            Refresh
          </Button>
        </div>
      </Window>
    </motion.div>
  );
}

function ConnectionWindow() {
  const [key, setKey] = useState<number | null>(null);
  return (
    <Glow successKey={key}>
      <Window title="integrations / proxmox" status={key !== null ? <LiveDot label="connected" /> : <span>untested</span>} data-connection-card>
        <div className="flex items-center gap-2">
          {key !== null ? <StatusCheck /> : <StatusMark state="unknown" />}
          <span className="type-title-3">Proxmox VE</span>
        </div>
        <p className="mt-2 type-body text-fg-2">{key !== null ? "Connected. Latency 18 ms." : "Not tested yet."}</p>
        <div className="mt-4">
          <Button
            variant="ink"
            data-test-connection
            onClick={() => {
              setKey((k) => (k ?? 0) + 1);
              toast.success("Connection test passed", { description: "Proxmox VE answered in 18 ms." });
            }}
          >
            Test connection
          </Button>
        </div>
      </Window>
    </Glow>
  );
}

function WindowsScene({ count, forceSweep, lifted, onLift }: { count: number; forceSweep: boolean; lifted: boolean; onLift: () => void }) {
  return (
    <LightSweep force={forceSweep}>
      <Screen>
        <ScreenHeader
          title="Overview"
          lead="Every service in the homelab, live."
          action={
            <Button variant="secondary" onClick={onLift} aria-pressed={lifted} data-lift-toggle>
              {lifted ? "Put down" : "Lift windows"}
            </Button>
          }
          tabs={[
            { label: "Overview", href: "/__shell-preview?scene=widgets", active: true },
            { label: "Media", href: "/__shell-preview?scene=buttons" },
          ]}
        />
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3" data-window-grid>
          {Array.from({ length: count }, (_, i) => (
            <SettleItem key={i} index={i}>
              {i === 1 ? <ConnectionWindow /> : <DemoWindow i={i} lifted={lifted} />}
            </SettleItem>
          ))}
        </div>
      </Screen>
    </LightSweep>
  );
}

/** The connection glow and the success toast over a window grid (design v4 Note 1, Fix 6). */
function GlowScene() {
  return (
    <Screen data-glow-scene>
      <ScreenHeader title="Integrations" lead="Test a connection: the title bar lights, then the toast arrives clear of every title bar." />
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3" data-window-grid>
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="min-h-[280px] [&>*]:h-full">
            {i === 4 ? <ConnectionWindow /> : <DemoWindow i={i} lifted={false} />}
          </div>
        ))}
      </div>
    </Screen>
  );
}

function ButtonsScene() {
  const [a, setA] = useState(true);
  const [b, setB] = useState(false);
  return (
    <div className="flex flex-col gap-10 p-(--gutter)" data-buttons-scene>
      <section className="flex flex-col gap-4">
        <Tag>[02] buttons</Tag>
        <div className="flex flex-wrap items-center gap-3" data-surface="bg">
          <Button variant="primary" data-btn="primary">Primary</Button>
          <Button variant="secondary" data-btn="secondary">Secondary</Button>
          <Button variant="ink" data-btn="ink">Run scene</Button>
          <Button variant="quiet" data-btn="quiet">Quiet</Button>
          <Button variant="destructive" data-btn="destructive">Revoke</Button>
          <Button variant="destructive-confirm" data-btn="destructive-confirm">Delete integration</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3" data-surface="disabled">
          <Button variant="secondary" disabled data-btn="secondary-disabled">Secondary</Button>
          <Button variant="quiet" disabled data-btn="quiet-disabled">Quiet</Button>
        </div>
      </section>
      <section className="grid grid-cols-1 gap-6 md:grid-cols-3" data-window-tones>
        <Window title="homelab / office · controls" status={<LiveDot />} data-tone-sample="paper">
          <div className="-mx-2 flex flex-col">
            <Switch label="Office lamp" description="light.toggle office_lamp" checked={a} onCheckedChange={setA} />
            <Switch label="Rack fan" description="switch.toggle rack_fan" checked={b} onCheckedChange={setB} />
          </div>
        </Window>
        <Window title="audit.log" tone="ink" status={<span>1 entry</span>} data-tone-sample="ink">
          <p className="type-label">
            <TypeIn text="06:38:12 control · owner · light.toggle office_lamp · ok" />
          </p>
        </Window>
        <Window title="guest-room / preview" tone="sky" live={false} data-tone-sample="sky">
          <p className="type-title-3">Bedroom</p>
          <p className="mt-1 type-body text-fg-2">What a guest sees, on the sky.</p>
        </Window>
      </section>
      <section className="flex flex-col gap-1" data-type-scale>
        <p className="type-display" data-type="display">Display</p>
        <p className="type-title-1" data-type="title-1">Title one</p>
        <p className="type-title-2" data-type="title-2">Title two</p>
        <p className="type-title-3" data-type="title-3">Title three</p>
        <p className="type-body-lg text-fg-2" data-type="body-lg">Body large, secondary</p>
        <p className="type-body" data-type="body">Body</p>
        <p className="type-label" data-type="label">label · mono</p>
        <p className="type-caption text-fg-3" data-type="caption">caption · tertiary</p>
        <p className="type-readout" data-type="readout">141 ms</p>
        <p className="type-body text-accent-ink" data-type="accent-ink">Accent ink link text</p>
        <table className="mt-2 w-full max-w-md type-label" data-type="table">
          <tbody>
            <tr><td>jellyfin.home</td><td className="text-right">62d</td></tr>
            <tr><td>n8n.home</td><td className="text-right">112d</td></tr>
          </tbody>
        </table>
      </section>
      <div className="flex items-center gap-4 type-label" data-status-marks>
        <StatusMark state="up" /> up <StatusMark state="warn" /> warn <StatusMark state="down" /> down
      </div>
    </div>
  );
}

function ToastsScene({ count }: { count: number }) {
  useEffect(() => {
    if (count <= 0) return;
    const kinds = ["info", "success", "error", "info", "success"] as const;
    for (let i = 0; i < count; i++) toast({ kind: kinds[i % kinds.length], title: `Toast ${i + 1}`, description: `A ${kinds[i % kinds.length]} message.` });
  }, [count]);
  return (
    <div className="flex flex-wrap gap-3 p-(--gutter)" data-toasts-scene>
      <Button variant="secondary" onClick={() => toast.info("Saved", { description: "Your layout is saved." })} data-raise="info">Info toast</Button>
      <Button variant="secondary" onClick={() => toast.success("Connection test passed")} data-raise="success">Success toast</Button>
      <Button variant="secondary" onClick={() => toast.error("Could not reach Proxmox", { description: "Timed out after 10 s." })} data-raise="error">Error toast</Button>
      <Button variant="secondary" onClick={() => toast.critical("Disk almost full on pve1")} data-raise="critical">Critical alert</Button>
      <Button variant="secondary" onClick={() => toast.secretsLocked()} data-raise="secrets-locked">Secrets locked</Button>
    </div>
  );
}

/** A setup-style form with fields down the page (keyboard handling on phones). */
function FormScene() {
  return (
    <div className="mx-auto w-full max-w-lg p-(--gutter)">
      <Window title="integrations / new · proxmox">
        <form className="flex flex-col gap-5" onSubmit={(e) => e.preventDefault()} data-form-scene>
          {["Name", "Base URL", "Username", "Notes", "API token"].map((label, i) => (
            <label key={label} className="flex flex-col gap-1.5">
              <span className="type-label text-fg-2">{label}</span>
              <input
                name={`field-${i}`}
                type={label === "API token" ? "password" : label === "Base URL" ? "url" : "text"}
                className="h-11 border border-line-strong bg-bg-hi px-3 type-body text-fg"
                data-form-field={label}
              />
            </label>
          ))}
          <Button variant="primary" type="submit" data-form-submit>
            Test connection
          </Button>
        </form>
      </Window>
    </div>
  );
}

/** A viewed app, full screen in its own theme, with the Atrium surfaces app-builder will mount. */
function AppScene(p: PreviewParams & { theme: PreviewParams["theme"] }) {
  const base: Theme = BUILT_IN_THEMES[p.theme] ?? BUILT_IN_THEMES.controlRoom;
  const theme = useMemo<Theme>(() => (p.font ? { ...base, tokens: { ...base.tokens, type: { ...base.tokens.type, display: p.font, body: p.font } } } : base), [base, p.font]);
  const [confirm, setConfirm] = useState(false);
  const [inner, setInner] = useState(false);
  const driftAt = useMemo(() => {
    if (!p.drift) return null;
    const [h, m] = p.drift.split(":").map(Number);
    const d = new Date();
    d.setHours(h ?? 12, m ?? 0, 0, 0);
    return d;
  }, [p.drift]);
  return (
    <div className="fixed inset-0 z-[45] overflow-auto bg-bg" data-viewed-app={p.theme}>
      <Canvas theme={theme} customCss={p.customCss} driftNow={driftAt} className="min-h-dvh" data-app-root>
        <div className={`flex flex-col gap-6 p-6 sm:p-10 ${p.draft ? "pt-14 sm:pt-16" : ""}`}>
          <header className="flex items-end justify-between gap-4" data-app-chrome>
            <div>
              <p className="type-label opacity-80">homelab</p>
              <h1 className="mt-1 text-[clamp(32px,5vw,56px)] leading-[0.95] font-semibold tracking-[-0.04em]">Overview</h1>
            </div>
            <nav className="hidden gap-4 type-body sm:flex" aria-label="App pages">
              <span className="underline underline-offset-4">Overview</span>
              <span className="opacity-70">Media</span>
              <span className="opacity-70">Network</span>
            </nav>
          </header>
          <div className="canvas-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" data-app-grid>
            {["pve1 cpu", "jellyfin", "rp5-2 certs", "docker1", "kuma", "office"].map((n, i) => (
              <CanvasSurface key={n} data-widget={i + 1}>
                <p className="type-label opacity-80">{n}</p>
                <p className="mt-2 text-[40px] leading-none font-semibold tracking-[-0.05em] tabular" data-numeric>
                  {(31 + i * 9.5).toFixed(1)}
                </p>
                {n === "office" ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" className="inline-flex h-10 items-center border px-3" style={{ borderColor: "currentColor" }} onClick={() => setConfirm(true)} data-open-confirm>
                      Turn on lamp
                    </button>
                    <button type="button" className="inline-flex h-10 items-center border px-3" style={{ borderColor: "currentColor" }} onClick={() => setInner(true)} data-open-inner-confirm>
                      Confirm (mounted here)
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-10 items-center border px-3"
                      style={{ borderColor: "currentColor" }}
                      onClick={() => (document.querySelector("[data-app-dialog]") as HTMLDialogElement | null)?.showModal()}
                      data-open-app-dialog
                    >
                      App dialog
                    </button>
                  </div>
                ) : (
                  <p className="mt-3 type-body opacity-80">up · 99.98%</p>
                )}
              </CanvasSurface>
            ))}
          </div>
          {/* Gauntlet r2 M1: a component's control handler renders the confirm inside the canvas. */}
          <ControlConfirm
            open={inner}
            title="Turn on Office lamp"
            command="home-assistant · light.turn_on office_lamp"
            body="Mounted inside the app canvas: app CSS still cannot reach it."
            confirmLabel="Turn on"
            onCancel={() => setInner(false)}
            onConfirm={() => setInner(false)}
          />
          {/* Gauntlet r2 L3: an app's own modal dialog, opened in the top layer over the draft bar. */}
          {/* Pinned to the top and full width with a strong backdrop, so it would cover the bar if it could. */}
          <dialog data-app-dialog className="border-0 bg-bad p-6 text-bg-hi backdrop:bg-bad/60" style={{ position: "fixed", inset: "0 0 auto 0", margin: 0, width: "100%", maxWidth: "100%", height: 140 }}>
            <p>An app dialog</p>
            <form method="dialog"><button data-close-app-dialog>Close</button></form>
          </dialog>
        </div>
      </Canvas>
      {p.draft && <DraftPreviewBar rev={42} builderHref="/build/homelab" />}
      <ControlConfirm
        open={confirm}
        title="Turn on Office lamp"
        command="home-assistant · light.turn_on office_lamp"
        body="This is a draft preview. The control is real: the lamp turns on."
        confirmLabel="Turn on"
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          toast.success("Office lamp is on", { description: "light.turn_on · ok" });
        }}
      />
      <AppToaster />
      <AppSwitcher
        viewer={p.viewer}
        currentSlug="homelab"
        apps={[{ slug: "homelab", name: "Homelab" }, { slug: "family", name: "Family" }, { slug: "guest-room", name: "Guest room" }]}
        canEdit={p.canEdit}
      />
    </div>
  );
}

/** A user-app canvas placed INSIDE the shell frame, so tests can prove themes and app CSS cannot
 *  reach the top bar, sky band, bottom bar, toasts or sheets even when they share a page. */
function CanvasInShell(p: PreviewParams) {
  const theme: Theme = BUILT_IN_THEMES[p.theme] ?? BUILT_IN_THEMES.controlRoom;
  return (
    <Canvas theme={theme} customCss={p.customCss} className="min-h-[60dvh]" data-canvas-in-shell>
      <div className="canvas-grid grid grid-cols-1 p-6 sm:grid-cols-3">
        {["pve1 cpu", "jellyfin", "kuma"].map((n, i) => (
          <CanvasSurface key={n} data-widget={i + 1}>
            <p className="type-label opacity-80">{n}</p>
            <p className="mt-2 text-[40px] leading-none font-semibold tabular" data-numeric>{(31 + i * 9.5).toFixed(1)}</p>
          </CanvasSurface>
        ))}
      </div>
      <div className="p-6">
        <Button variant="secondary" data-test-connection onClick={() => toast.success("Connection test passed", { description: "Proxmox VE answered in 18 ms." })}>
          Test connection
        </Button>
      </div>
    </Canvas>
  );
}

/** The sign-in screen as it looks once auth's layout mounts AuthShell (shared file request). */
function SignInScene() {
  return (
    <div className="fixed inset-0 z-[45] overflow-auto bg-bg" data-signin-preview>
      <AuthShell>
        <Window title="atrium / sign in" className="w-full" data-auth-window>
          <SignInForm providers={[{ id: "google", name: "Google" }]} next="/" />
        </Window>
      </AuthShell>
    </div>
  );
}

export function ShellPreview(p: PreviewParams) {
  const [lifted, setLifted] = useState(false);
  const drafts = useMemo(() => Array.from({ length: p.drafts }, (_, i) => ({ id: `d${i}`, title: `Draft ${i + 1}: add a Docker component` })), [p.drafts]);
  useShellNav({ approvalsCount: p.approvals, drafts, user: { name: "Tristan", email: "owner@atrium.test" } });
  usePageTitle(p.scene === "empty" ? "Apps" : `preview · ${p.scene}`);

  let body: ReactNode;
  switch (p.scene) {
    case "app":
      return <AppScene {...p} />;
    case "signin":
      return <SignInScene />;
    case "canvas":
      body = <CanvasInShell {...p} />;
      break;
    case "widgets":
    case "lift":
      body = <WindowsScene count={p.count} forceSweep={p.forceSweep} lifted={lifted} onLift={() => setLifted((v) => !v)} />;
      break;
    case "loading":
      body = <SkeletonGrid />;
      break;
    case "glow":
      body = <GlowScene />;
      break;
    case "buttons":
      body = <ButtonsScene />;
      break;
    case "toasts":
      body = <ToastsScene count={p.toasts} />;
      break;
    case "form":
      body = <FormScene />;
      break;
    default:
      body = (
        <EmptyRoom
          title={ROOM_COPY.page.title}
          body={ROOM_COPY.page.body}
          actions={
            <>
              <Button variant="primary" onClick={() => toast.info("Component picker", { description: "app-builder builds the picker." })} data-add-component>
                {ROOM_COPY.page.primary}
              </Button>
              <Button variant="secondary" onClick={() => toast.info("Templates", { description: "app-builder builds templates." })} data-start-template>
                {ROOM_COPY.page.secondary}
              </Button>
            </>
          }
        />
      );
  }
  return <div className="flex flex-1 flex-col">{body}</div>;
}
