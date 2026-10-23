// app-shell public surface. Other subsystems import from "@/features/shell".
export { springs, durations, timed, transitionFor, staggerDelay, typeInMs, REDUCED_CROSSFADE_MS, REDUCED_GLOW_RING_MS, MAX_INTERACTION_MS, GLOW_PEAK_MS, GLOW_HOLD_MS, glowKeyframes, glowOpacityAt } from "./motion";
export type { SpringName } from "./motion";
// Design v4 surfaces
export { Window, TitleBar, DoorGlyph, LiveDot, Tag, Well } from "./window";
export type { WindowProps, WindowTone } from "./window";
export { FloatGlass } from "./glass";
export { Switch } from "./switch";
export { SkyBand } from "./sky-band";
export type { SkyBandProps, SkyCrumb } from "./sky-band";
export { AuthShell } from "./auth-shell";
// Design v4 Note 1: the one screen header and the shell content column.
export { ScreenHeader, Screen } from "./screen-header";
export type { ScreenHeaderProps, ScreenTab } from "./screen-header";
export { TypeIn } from "./type-in";
// Drawn over a viewed app (architecture v3 A1.6). Server slot: AppSwitcherSlot from "@/features/shell/server".
export { AppSwitcher, switcherItems, switcherVisible } from "./app-switcher";
export type { AppSwitcherProps, SwitcherApp } from "./app-switcher";
export { DraftPreviewBar, ControlConfirm } from "./app-overlays";
export type { ControlConfirmProps } from "./app-overlays";
/** @deprecated v3 glass: now a paper window body. Use Window (or FloatGlass over an app). */
export { Glass, glassClass } from "./glass";
export type { GlassMaterial } from "./glass";
export { Button, buttonClass, PRESS_OFFSET_PX } from "./button";
export type { ButtonVariant, ButtonProps } from "./button";
export { Sheet } from "./sheet";
export type { SheetProps, SheetSide } from "./sheet";
export { Toaster, AppToaster, toast, useToasts, SUCCESS_TOAST_DELAY_MS } from "./toast";
export type { ToastKind, ToastInput } from "./toast-store";
export { useReducedMotion, useReduceTransparency, usePreferences, prefersReducedMotionNow } from "./use-preferences";
export { useShellLayout, useIsPhone, useOnline, layoutForWidth } from "./use-viewport";
export type { Preferences, ThemePreference } from "./preferences";
export * from "./icons";
export { Mark, Wordmark } from "./mark";
export { EmptyRoom, RoomIllustration, ROOM_COPY } from "./empty-room";
export { LightSweep, SettleItem, useSettled } from "./light-sweep";
export { Glow, StatusCheck } from "./glow";
export { LightDrift } from "./light-drift";
export { driftAt } from "./drift";
export { SkeletonPanel, SkeletonGrid } from "./skeleton";
export { ShellFrame } from "./shell-frame";
export { ShellGlobals } from "./globals";
export { usePageTitle, useShellNav, useEditToggle, useShell } from "./shell-context";
export type { ShellNav, ShellPage, ShellDraft, ShellUser, EditToggle } from "./shell-context";
export { openPalette, onPaletteRequest, PALETTE_EVENT } from "./palette-bridge";
export { AppearanceControls } from "./appearance";
export { ErrorScreen, NotFoundScreen, ComingScreen } from "./system-screens";
export { OFFLINE_MESSAGE } from "./top-bar";
export { StatusMark } from "./status-mark";
// User themes (design v4 section 2). Custom CSS scoping is server-only: "@/features/shell/server".
export { Canvas, CanvasSurface, CanvasGrid, useCanvasTone } from "./canvas";
export type { CanvasProps } from "./canvas";
export {
  controlRoom,
  dusk,
  solid,
  daylight,
  BUILT_IN_THEMES,
  THEME_FONTS,
  THEME_FONT_STACKS,
  resolveTokens,
  themeToCssVars,
  tokensToCssVars,
  themeCanvasCss,
  themeFontFaces,
  themeTone,
  fontStack,
  contrastReport,
  tokenContrast,
  isThemeColor,
  isThemeGradient,
  isUploadPath,
  ThemeTokensSchema,
  ThemeSchema,
  ThemePackageV3Schema,
  ThemePackageSchema,
  parseTheme,
  parseThemePackage,
  themeFromV3,
  toTheme,
  toThemePackage,
  MAX_CUSTOM_CSS_BYTES,
} from "./theme";
export type { Theme, ThemeTokens, ThemePackage, ThemePackageV3, ThemeFontFamily, ThemeFontUi, CanvasTone, ContrastWarning, ContrastReport, ContrastField, ParsedTheme, BuiltInThemeId } from "./theme";
export type { ScopedCss } from "./custom-css";
export { ROUTES_AVAILABLE, SOON_LABEL, SOON_TAG, SETTINGS_INTERIM_HREF, SETTINGS_HREF, USERS_HREF, SECURITY_HREF, USERS_AND_SECURITY_HREF, USERS_AND_SECURITY_LABEL, isUsersAndSecurity, comingRouteFor } from "./nav";
export type { RouteKey } from "./nav";
export { Tip } from "./tip";
