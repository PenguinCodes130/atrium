// Frozen contracts, copied from stages/01-architecture/output/atrium-architecture-v3.md.
// Do not edit without an approved architecture version bump (shared/wave-protocol.md).
import type { ZodType } from "zod";

export type JsonSchema = Record<string, unknown>;
export type Logger = {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
};

// Section 3: package format
export type PackageManifest = {
  atriumApi: "1";
  kind: "code" | "declarative";
  id: string;
  name: string;
  version: string;
  author: string;
  homepage?: string;
  description: string;
  icon: string;
  permissions: Permission[];
  config: JsonSchema;
  secrets: SecretField[];
  endpoints: EndpointDef[];
  components?: CustomComponentDef[];
  commands?: CommandDef[];
  detect?: { serverHeader?: string; probe?: { path: string; match: string } };
  service?: { kind: ServiceKind; headline?: HeadlineStat[] }; // A10.5
};
export type Permission =
  | { kind: "network"; hosts: "configured" | string[] }
  | { kind: "secret"; key: string }
  | { kind: "command"; ids: string[] };
export type SecretField = { key: string; label: string; hint: string; auth: AuthPlacement };
export type AuthPlacement =
  | { as: "bearer" }
  | { as: "header"; name: string }
  | { as: "query"; name: string }
  | { as: "basic"; userKey: string }
  | { as: "proxmox-token" };
export type EndpointDef = {
  id: string;
  label: string;
  description: string;
  params?: JsonSchema;
  shape: DataShapeKind;
  defaultRefreshSec: number;
  minRefreshSec: number;
  group?: string; // A8.1: a heading in words in the picker
  advanced?: boolean; // A8.1: listed under Advanced
  needs?: string; // A8.1: what the service must have, in words
  history?: { endpointId: string; params?: Record<string, PropValue> }; // A10.3: the series read for this value over time
  measure?: Measure; // A10.4
  headline?: boolean; // A10.4: one of the service's main reads
};
export type CustomComponentDef = { type: `pkg:${string}/${string}`; accepts: DataShapeKind[]; entry: string };

// Section 3.1: commands
export type CommandDef = {
  id: string;
  label: string;
  description: string;
  params: JsonSchema;
  target?: { endpointId: string; field: string };
  risk: "low" | "medium";
  ownerOnly?: boolean;
};
export type CommandResult = { ok: true; message?: string; at: string } | { ok: false; error: AdapterError; at: string };
export type CustomCommand = {
  id: string;
  label: string;
  description: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string>;
  auth?: string;
  headers?: Record<string, string>;
  body?: unknown;
  params: JsonSchema;
  risk: "low" | "medium";
};

export interface Adapter {
  health(ctx: AdapterContext): Promise<HealthResult>;
  read(ctx: AdapterContext, endpointId: string, params: unknown): Promise<ReadResult>;
  command?(ctx: AdapterContext, commandId: string, params: unknown): Promise<CommandResult>;
  /** A8.1: which endpoint ids have data on this service (missing ids count as available). */
  available?(ctx: AdapterContext): Promise<Record<string, boolean>>;
}
export type AdapterContext = {
  config: Record<string, unknown>;
  http: HostHttp;
  log: Logger;
  signal: AbortSignal;
  now: () => Date;
};
export interface HostHttp {
  // timeoutMs defaults to 10000. Redirects are followed only within the configured host (at most 3).
  fetch(req: {
    path: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; // PUT, PATCH, DELETE only during command()
    query?: Record<string, string>;
    body?: unknown;
    auth?: string;
    timeoutMs?: number;
  }): Promise<HostResponse>;
}
export type HostResponse = {
  status: number;
  headers: Record<string, string>;
  json(): Promise<unknown>;
  text(): Promise<string>;
};
export type HealthResult = { status: "ok" | "degraded" | "down"; latencyMs: number; message?: string; version?: string };
export type ReadResult =
  | { ok: true; data: ShapedData; sourceTimestamp: string; fetchedAt: string }
  | { ok: false; error: AdapterError; fetchedAt: string };
export type AdapterError = {
  code: "auth" | "unreachable" | "timeout" | "tls" | "bad_response" | "rate_limited" | "config" | "permission";
  message: string;
  hint?: string;
  retryAfterSec?: number;
};
export type CustomEndpoint = {
  id: string;
  label: string;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  auth?: string;
  headers?: Record<string, string>; // non-secret only (architecture v2 amendment)
  body?: unknown; // read-only POST endpoints only
  fields: { path: string; label: string; role: "value" | "label" | "time" | "status" | "column" }[];
  shape: DataShapeKind;
  refreshSec: number; // minimum 10 (architecture v2 amendment)
  // A9.3: spec import v2
  description?: string;
  params?: JsonSchema; // {{ params.x }} placeholders allowed in path and query values, URL-encoded
  group?: string;
  advanced?: boolean;
  format?: ValueFormat;
  columnFormats?: Record<string, ValueFormat>;
};

// Amendment 9: recipes (data-only presets of reads) and the live check
export type RecipeRead = {
  id: string;
  label: string;
  description?: string;
  group?: string;
  advanced?: boolean;
  needs?: string;
  params?: JsonSchema;
  request:
    | { kind: "http"; path: string; query?: Record<string, string> }
    | { kind: "promql"; expr: string; range?: { hours: number; stepSec: number } }
    | { kind: "label-values"; metric: string; label: string; display?: string };
  fields?: CustomEndpoint["fields"];
  shape: DataShapeKind;
  format?: ValueFormat;
  columnFormats?: Record<string, ValueFormat>;
  seriesName?: string;
  refreshSec?: number;
};
export type Recipe = {
  atriumRecipe: "1";
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  source: "builtin" | "file" | "url" | "grafana" | "spec";
  appliesTo: { package: string } | { spec: { title: string } } | { metrics: string[] };
  reads: RecipeRead[];
};
export type ReadCheck = { status: "ok" | "empty" | "failed" | "odd"; reason?: string; at: string };
export type Integration = {
  id: string;
  packageId: string;
  name: string;
  config: Record<string, unknown>;
  secrets: { key: string; set: boolean; updatedAt?: string; credentialId?: string }[]; // credentialId: amendment 2
  status: "draft" | "active" | "disabled";
  shared: boolean; // v3: false = only the owner and the creator may bind it into apps
  lastHealth?: HealthResult & { checkedAt: string };
  kind?: ServiceKind; // A10.5
  openUrl?: string; // A10.5: the service's own address for tiles; not config, not secret
  headline?: HeadlineStat[]; // A10.5: overrides the package's
  createdBy: Principal["kind"];
  createdById: string;
  createdAt: string;
  updatedAt: string;
};
export type EndpointSummary = { method: "GET" | "POST"; path: string; summary?: string; params?: JsonSchema; suggestedShape?: DataShapeKind };
export type PackageProblem = { packageId: string; source: "official" | "declarative" | "community"; reason: string; at: string };

// Section 4: apps, pages and components
export type DataShapeKind = "stat" | "series" | "table" | "status";
// A8.4: how a number is shown by default
export type ValueFormat = "percent" | "bytes" | "bytesPerSec" | "seconds" | "celsius" | "number";
export type ShapedData =
  | { kind: "stat"; value: number | string; unit?: string; format?: ValueFormat; label: string; delta?: { value: number; period: string }; thresholds?: { warn?: number; bad?: number } }
  | { kind: "series"; unit?: string; format?: ValueFormat; series: { name: string; display?: string; points: [t: number, v: number | null][] }[]; total?: number } // total: amendment A4.1, series the source holds when known
  | { kind: "table"; columns: { key: string; label: string; type: "text" | "number" | "time" | "status" | "link"; format?: ValueFormat }[]; rows: Record<string, unknown>[]; total?: number }
  | { kind: "status"; items: { label: string; state: "up" | "down" | "warn" | "unknown"; detail?: string; href?: string }[] };

// Section 5: auth model
export type Role = "owner" | "member" | "viewer";
export type AgentScope = "atrium:read" | "atrium:edit" | "atrium:propose";
export type Principal =
  | { kind: "user"; userId: string; role: Role; via: "session" }
  | { kind: "agent"; userId: string; role: Role; via: "mcp-oauth" | "pat"; tokenId: string; agentName: string; scopes: AgentScope[] }
  | { kind: "builtin-agent"; userId: string; role: Role; conversationId: string }
  | { kind: "guest"; guestLinkId: string; appId: string; label: string; via: "guest-link" };

// Section 5.1: guest links
export type GuestLink = {
  id: string;
  appId: string;
  label: string;
  tokenHash: string;
  pinHash?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
};

// Section 6: actions
export type PlanContext = { principal: Principal; log: Logger; signal: AbortSignal };
export type ActionDef = {
  id: string;
  label: string;
  description: string;
  input: JsonSchema;
  webhookPath: string;
  risk: "low" | "medium" | "high";
  plan(ctx: PlanContext, input: unknown): Promise<{ steps: string[]; impact: string[]; warnings?: string[] }>;
  timeoutSec: number;
  controlAllowed: boolean;
};
export type ActionResult = { status: "succeeded" | "failed" | "rolled_back"; steps: { name: string; ok: boolean; message?: string }[]; message: string };
export type Proposal = {
  id: string;
  actionId: string;
  input: unknown;
  plan: { steps: string[]; impact: string[]; warnings?: string[] };
  proposedBy: Principal;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "rejected" | "expired" | "executing" | "succeeded" | "failed" | "rolled_back" | "unknown";
  decidedBy?: string;
  decidedAt?: string;
  executionId?: string;
  result?: ActionResult;
};

// Section 7: audit log
export type AuditEvent =
  | "action.proposed" | "action.approved" | "action.rejected" | "action.executed" | "action.result"
  | "draft.created" | "draft.published" | "draft.discarded"
  | "tool.called"
  | "app.created" | "app.deleted" | "app.access_changed" | "app.draft_changed" | "app.published" | "app.draft_discarded" | "app.restored" | "app.imported" | "app.exported"
  | "control.run" | "guest_link.created" | "guest_link.revoked" | "guest.opened" | "guest.pin_failed"
  | "library.saved" | "library.imported" | "library.deleted"
  | "credential.created" | "credential.updated" | "credential.deleted" | "credential.locked"
  | "account.invite_created" | "account.invite_used" | "account.reset_created" | "account.reset_used" | "account.link_revoked"
  | "integration.created" | "integration.updated" | "integration.deleted" | "secret.updated"
  | "auth.signin" | "auth.signin_failed" | "auth.2fa_changed" | "token.created" | "token.revoked"
  | "backup.exported" | "backup.imported" | "settings.updated";
export type AuditEntry = {
  id: string;
  at: string;
  actor: { kind: Principal["kind"] | "system"; userId?: string; // "system": amendment A1.8
    tokenId?: string; agentName?: string; guestLinkId?: string; guestLabel?: string; ip?: string };
  event: AuditEvent;
  target?: { type: string; id: string; label?: string };
  proposalId?: string;
  result: "ok" | "error";
  detail?: Record<string, unknown>;
};

// Section 8: notifications
export type Severity = "info" | "warning" | "critical";
export type Alert = {
  id: string;
  source: "integration" | "action" | "system" | "n8n";
  severity: Severity;
  title: string;
  body: string;
  url?: string;
  at: string;
  dedupeKey?: string;
};
export type ChannelTarget = { id: string; kind: Channel["kind"]; name: string; config: Record<string, unknown> };
export interface Channel {
  kind: "ntfy" | "discord" | "gotify" | "email" | "webpush";
  send(alert: Alert, target: ChannelTarget): Promise<{ ok: boolean; providerId?: string; error?: string }>;
}
export type Route = {
  id: string;
  match: { source?: Alert["source"][]; minSeverity: Severity; titleContains?: string };
  channels: string[];
  quietHours?: { start: string; end: string; tz: string; allowCritical: boolean };
};

// Section 9: command palette
export type PaletteEntry = {
  id: string;
  title: string;
  subtitle?: string;
  group: "Apps" | "Pages" | "Components" | "Controls" | "Integrations" | "Services" | "Actions" | "Settings";
  keywords?: string[];
  icon?: string;
  run: { kind: "navigate"; href: string } | { kind: "tool"; tool: string; input?: unknown } | { kind: "control"; appId: string; controlId: string };
};

// Section 9b: agent tool registry
export type ToolDef<I = unknown, O = unknown> = {
  name: string;
  title: string;
  description: string;
  input: ZodType<I>;
  output: ZodType<O>;
  scope: AgentScope;
  effect: "none" | "draft" | "proposal";
  surfaces: ("palette" | "builtin-agent" | "mcp")[];
  minRole: Role;
  handler(ctx: { principal: Principal; signal: AbortSignal }, input: I): Promise<O>;
};
export type Draft = {
  id: string;
  kind: "theme" | "integration" | "package"; // v3: app edits use AppDraft
  targetId?: string;
  patch: unknown;
  createdBy: Principal;
  createdAt: string;
  status: "open" | "published" | "discarded";
  note?: string;
};

// Section 10: caching and refresh
export type DataState = "fresh" | "stale" | "failed" | "empty";

// ---------------------------------------------------------------------------
// Architecture v3 additions (scope v4: the app builder)
// ---------------------------------------------------------------------------

// Section 4.2: apps
export type UserSet = "owner" | "everyone" | { userIds: string[] };
export type App = {
  id: string;
  slug: string;
  name: string;
  icon?: string;
  access: { view: UserSet; edit: UserSet; guests: boolean };
  publishedVersion?: number;
  draftRev: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

// Section 4.3: the app document
export type AppDocument = {
  format: "atrium-app";
  formatVersion: 1;
  app: { name: string; icon?: string; homePage: string; pageOrder: string[] };
  theme: ThemeRef;
  chrome: ChromeDef;
  dataSources: DataSourceDef[];
  controls: ControlDef[];
  pages: PageDoc[];
};
export type ThemeRef = { themeId: string } | { inline: Theme };
export type ChromeDef = {
  layout: "sidebar" | "topbar" | "tabs" | "none";
  title?: string;
  logo?: string;
  style?: StyleOverride;
  css?: string;
};
export type PageDoc = {
  id: string;
  slug: string;
  title: string;
  icon?: string;
  inNav: boolean;
  theme?: ThemeRef;
  maxWidth?: 1280 | 1440 | 1920; // A7.5: absent fills the screen
  padding?: "none" | number; // A7.5: absent uses the theme's page padding; a number is 0 to 64 px
  root: ComponentNode;
};
export type DataSourceDef = {
  name: string;
  integrationId: string;
  endpointId: string;
  params?: Record<string, PropValue>;
  refreshSec: number;
  label?: string; // A8.6: the source's name in words
  managed?: boolean; // A10.1: created, shared and removed by Atrium, never named by a person
};

// Section 4.4: components
export type ComponentNode = {
  id: string;
  type: ComponentType;
  name?: string;
  props: Record<string, PropValue>;
  overrideTheme?: boolean;
  style?: StyleOverride;
  css?: string;
  slot?: GridSlot;
  hidden?: boolean; // A7.3: desktop only; phones use responsive.mobile.hidden
  title?: string; // A8.5: shown in the title bar
  showTitle?: boolean; // A8.5
  refreshSec?: number; // A10.1: this component's own refresh; managed sources run at the fastest
  responsive?: { mobile?: { slot?: GridSlot; hidden?: boolean; props?: Record<string, PropValue>; style?: StyleOverride } };
  visibleWhen?: Binding;
  children?: ComponentNode[];
  libraryRef?: { componentId: string; version: number };
};
// In the parent grid's columns (A7.4): x and w are multiples of 0.125, y and h whole 8px rows.
export type GridSlot = { x: number; y: number; w: number; h: number };
export type Binding = { $bind: string };
export type PropValue = string | number | boolean | null | PropValue[] | { [k: string]: PropValue } | Binding;
export type ComponentType =
  | "grid" | "stack" | "card" | "tabs" | "section" | "repeat"
  | "stat" | "chart" | "table" | "list" | "status" | "gauge" | "progress"
  | "heading" | "text" | "image" | "video" | "icon" | "link" | "divider" | "spacer" | "clock"
  | "button" | "toggle" | "slider" | "select"
  | "html"
  | "service-tile" | "group" | "resource-bar" | "bookmarks" // A10.7
  | `pkg:${string}/${string}` | `lib:${string}`;
export type ComponentState = "hover" | "active" | "focus" | "on" | "off" | "disabled";

export type ComponentCategory = "layout" | "data" | "content" | "control" | "code";
export type ComponentDef = {
  type: ComponentType;
  title: string;
  category: ComponentCategory;
  container: boolean;
  props: ZodType; // with .describe() on every field; agents read these
  defaults: Record<string, PropValue>;
  accepts?: DataShapeKind[];
  styleSlots: string[];
  states?: ComponentState[];
  docs: { summary: string; whenToUse: string; examples: ComponentNode[] };
  Component: (props: { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext }) => unknown; // a React component
};

// Amendment A4.2: what every component gets while rendering
export type RenderMode = "edit" | "view" | "draft-preview" | "agent-render";
/** The binding roots of section 4.5 for one page ($param only inside a library instance, amendment A4.2). */
export type BindingScope = {
  $data: Record<string, ShapedData | undefined>;
  $input?: unknown;
  $param?: Record<string, unknown>;
  $item?: unknown;
  $index?: number;
  $page: { id: string; slug: string; title: string };
  $app: { id: string; slug: string; name: string };
  $user: { kind: "user" | "guest"; name?: string };
  [root: `$${string}`]: unknown;
};
export type RenderContext = {
  mode: RenderMode;
  principal: Principal;
  appId: string;
  pageId: string;
  version: number | "draft";
  values: BindingScope;
  /** "agent-render" never runs (controls show disabled); "draft-preview" always goes through the shell confirm. */
  runControl(nodeId: string, controlId: string, input?: unknown): Promise<ControlRunResponse>;
  confirm(text: string): Promise<boolean>;
  /** Same-app pages, or same-origin paths only. */
  navigate(target: { pageId: string } | { href: string }): void;
};

// Section 4.6: styles
export type Len = string | number;
export type Paint = string;
export type StyleProps = Partial<{
  display: string; flexDirection: string; gap: Len; alignItems: string; justifyContent: string;
  padding: Len; margin: Len; width: Len; height: Len; minHeight: Len; maxWidth: Len; overflow: string;
  color: Paint; background: Paint; backgroundImage: string; opacity: number; mixBlendMode: string;
  backdropFilter: string; filter: string;
  border: string; borderColor: Paint; borderWidth: Len; borderRadius: Len; boxShadow: string; outline: string;
  fontFamily: string; fontSize: Len; fontWeight: number | string; lineHeight: Len | number; letterSpacing: Len;
  textAlign: string; textTransform: string; fontVariantNumeric: string; textShadow: string;
  transition: string; transform: string; animation: "none" | "pulse" | "fade-in" | "rise" | "glow";
}>;
export type StyleOverride = { [slot: string]: StyleProps & { states?: Partial<Record<ComponentState, StyleProps>> } };

// Section 4.7: the HTML block
export type HtmlBlockProps = {
  html: string;
  css?: string;
  js?: string;
  data: Record<string, Binding>;
  controls: string[];
  height: "auto" | number;
  libs?: ("uplot" | "d3" | "motion")[];
  images?: string[];
};
export type HostToFrame =
  | { t: "init"; html: string; css?: string; js?: string; libs: string[]; images: Record<string, string>; data: Record<string, unknown>; theme: Record<string, string>; viewer: { kind: "user" | "guest" } }
  | { t: "data"; data: Record<string, unknown> }
  | { t: "theme"; theme: Record<string, string> }
  | { t: "controlResult"; reqId: string; ok: boolean; message?: string };
export type FrameToHost =
  | { t: "ready" }
  | { t: "resize"; height: number }
  | { t: "control"; reqId: string; controlId: string; input?: unknown }
  | { t: "navigate"; page: string }
  | { t: "log"; level: "info" | "warn" | "error"; message: string };

// Section 4.8: component library
export type LibraryParam = {
  name: string;
  label: string;
  kind: "data" | "text" | "number" | "color" | "control" | "boolean";
  default?: PropValue;
};
export type LibraryComponent = {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  version: number;
  node: ComponentNode;
  params: LibraryParam[];
  containsCode: boolean;
  source: "local" | "imported";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

// Section 4.9: drafts, publish and versions
export type AppDraft = { appId: string; rev: number; doc: AppDocument; updatedAt: string; updatedBy: Principal };
export type DraftOp =
  | { op: "page.add"; page: PageDoc; index?: number }
  | { op: "page.update"; pageId: string; patch: Partial<Omit<PageDoc, "id" | "root">> }
  | { op: "page.remove"; pageId: string }
  | { op: "page.move"; pageId: string; index: number }
  | { op: "node.add"; parentId: string; index?: number; node: ComponentNode }
  | { op: "node.update"; nodeId: string; patch: Partial<Omit<ComponentNode, "id" | "children">> }
  | { op: "node.move"; nodeId: string; parentId: string; index?: number; slot?: GridSlot }
  | { op: "node.remove"; nodeId: string }
  | { op: "source.set"; source: DataSourceDef }
  | { op: "source.remove"; name: string }
  | { op: "control.set"; control: ControlDef }
  | { op: "control.remove"; controlId: string }
  | { op: "app.update"; patch: Partial<AppDocument["app"]> }
  | { op: "theme.set"; theme: ThemeRef }
  | { op: "chrome.update"; patch: Partial<ChromeDef> };
export type DraftChange = { id: string; appId: string; rev: number; by: Principal; at: string; ops: DraftOp[]; summary: string };
export type AppVersion = {
  appId: string;
  version: number;
  doc: AppDocument;
  publishedBy: string;
  publishedAt: string;
  note?: string;
  source: "publish" | "restore" | "import" | "agent-layout";
  restoredFrom?: number;
};
export type VersionDiff = {
  app: string[];
  theme: boolean;
  chrome: string[];
  pages: { added: string[]; removed: string[]; changed: string[]; moved: string[] };
  nodes: { added: string[]; removed: string[]; moved: string[]; props: string[]; style: string[]; code: string[] };
  sources: { added: string[]; removed: string[]; changed: string[] };
  controls: { added: string[]; removed: string[]; changed: string[] };
};

// Section 6.2: controls
export type ControlDef = {
  id: string;
  label: string;
  run:
    | { kind: "command"; integrationId: string; commandId: string; params?: Record<string, PropValue> }
    | { kind: "workflow"; actionId: string; input?: Record<string, PropValue> };
  confirm?: string;
  cooldownMs?: number;
};
export type ControlRun = {
  id: string;
  appId: string;
  version: number;
  controlId: string;
  by: Principal;
  at: string;
  input?: unknown;
  result: "ok" | "error";
  message?: string;
  durationMs: number;
};

// Section 9b: validate
export type Problem = {
  severity: "error" | "warning" | "hint";
  code: string;
  where: { pageId?: string; nodeId?: string; field?: string };
  message: string;
  fix?: string;
};

// Design v4 section 2: user themes
export type Theme = {
  atriumTheme: "2";
  id: string;
  name: string;
  author: string;
  version: string;
  mode: "light" | "dark" | "auto";
  tokens: ThemeTokens;
  dark?: Partial<ThemeTokens>;
  fonts?: { family: string; file: string; weight: string; style: "normal" | "italic" }[];
  customCss?: string;
};
export type ThemeTokens = {
  wallpaper: {
    kind: "none" | "color" | "gradient" | "image" | "sky";
    value: string;
    colors?: [string, string];
    blurPx: 0 | 8 | 16 | 32;
    dim: number;
    grain: number;
    position?: "center" | "top" | "bottom";
  };
  color: {
    surface: string; surfaceText: string; surfaceMuted: string; canvasText: string;
    accent: string; accentText: string;
    ok: string; warn: string; bad: string; info: string;
    line: string;
  };
  surface: {
    material: "solid" | "glass";
    opacity: number;
    blurPx: number;
    border: { widthPx: 0 | 1 | 2; color: string };
    shadow: "none" | "soft" | "hard";
    shadowOffsetPx: number;
    titleBars: boolean;
  };
  type: {
    display: string; body: string; mono: string;
    scale: number;
    numbers: "tabular" | "proportional";
    headingTracking: number;
    headingWeight: 400 | 500 | 600 | 700 | 800;
  };
  shape: { radiusPx: number; controlRadiusPx: number };
  space: { gapPx: number; padPx: number; density: "comfortable" | "compact" };
  motion: { enter: "none" | "fade" | "rise" | "sweep"; lightDrift: boolean };
  chrome: { background: string; text: string; activeFill: string; activeText: string; style: "bar" | "boxed-tabs" | "pills" | "underline" };
};

// Section 2 skeleton: hooks that let an earlier wave call a later one (src/core/hooks.ts)
export type AppAccessResolver = {
  appBySlug(slug: string): Promise<App | null>;
  appById(appId: string): Promise<App | null>; // amendment A1.2
  appsFor(principal: Principal): Promise<App[]>; // amendment A1.2; [] for guests
  /** Amendment A1.2: resolved values for a guest page, keyed "nodeId:prop". */
  guestValues(appId: string, pageId: string, sources: Record<string, ShapedData>): Promise<Record<string, unknown>>;
  canOpenApp(principal: Principal, appId: string): Promise<boolean>;
  canEditApp(principal: Principal, appId: string): Promise<boolean>;
  /** The control and node as published (or as drafted, for an editor in preview); null when either is missing. */
  publishedControl(
    appId: string,
    controlId: string,
    nodeId: string,
    opts: { draft: boolean; principal: Principal }
  ): Promise<{ version: number; control: ControlDef; node: ComponentNode } | null>;
};

// Amendment A1.4: controls
export type ControlRunRequest = { appId: string; nodeId: string; controlId: string; input?: unknown; draft?: boolean; confirmed?: boolean };
export type ControlRunResponse =
  | { ok: true; message?: string }
  | { ok: false; code: "forbidden" | "not_available" | "not_shared" | "invalid_input" | "rate_limited" | "busy"; message: string };
export type CommandListing = { integrationId: string; integrationName: string; command: CommandDef; targets?: { id: string; label: string }[] };

// Amendment 2: saved credentials
export type CredentialKind = "token" | "username-password" | "proxmox-token";
export type Credential = {
  id: string;
  name: string;
  kind: CredentialKind;
  fields: { key: string; set: boolean; updatedAt?: string }[];
  lockedOrigins: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  usedBy: { integrationId: string; name: string }[];
};

// Amendment 3: member invites and resets
export type AccountLink = {
  id: string;
  kind: "invite" | "reset";
  email: string;
  role?: "member" | "viewer";
  tokenHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  revokedAt?: string;
};

// Amendment 10: direct data and service tiles
export type Measure = "cpu" | "memory" | "disk" | "network" | "temperature" | "uptime" | "count" | "status" | "other";
export type ServiceKind = "media" | "monitoring" | "network" | "smart-home" | "storage" | "containers" | "other";
/** value: a template body evaluated against that read's source, e.g. "value" or `rows | filter("state", "running") | count`. */
export type HeadlineStat = { label: string; endpointId: string; params?: Record<string, PropValue>; value: string; format?: ValueFormat };
/** A10.2: color is "series1" to "series8" (theme tokens) or a hex colour. */
export type ChartLine = { data: Binding; label?: string; color?: string; hidden?: boolean };
export type CatalogueItem = {
  key: string;
  integrationId: string;
  integrationName: string;
  packageId: string;
  serviceIcon: string;
  endpointId: string;
  label: string;
  thing?: { param: string; value: string; label: string; detail?: string };
  params: Record<string, PropValue>;
  needsSettings?: boolean;
  shape: DataShapeKind;
  format?: ValueFormat;
  group?: string;
  measure: Measure;
  headline?: boolean;
  history?: { endpointId: string; params: Record<string, PropValue> };
  check?: ReadCheck;
  from?: string;
  defaultRefreshSec: number;
  minRefreshSec: number;
};
export type CatalogueService = {
  integrationId: string;
  name: string;
  packageId: string;
  icon: string;
  kind: ServiceKind;
  openUrl?: string;
  headline: HeadlineStat[];
  health?: HealthResult["status"];
};
export type CatalogueResponse = { items: CatalogueItem[]; fits: boolean[]; services: CatalogueService[]; pending: string[] };
export type PeekRequest = { items: { integrationId: string; endpointId: string; params: Record<string, PropValue> }[] };
export type PeekResponse = { values: { key: string; data?: ShapedData; error?: string }[] };
export type StartPageRequest = { integrationIds: string[]; links: { name: string; href: string }[]; machine?: { integrationId: string; thing: string } };
