// Server-side imports from the Wave 2 subsystems app-builder consumes (wave-2-lead-prep.md,
// "Cross-subsystem exports"). Kept in one module so unit tests can replace it with a local fake
// (vi.mock("@/features/apps/deps")) while components and settings are built in parallel. Shipped
// code always goes through the real exports below.
import "server-only";
export { componentDefs, getComponentDef, sourcesUsed, resolveGuestValues, validateNodes, insertCatalogue, suggestComponent, detachInstance } from "@/features/components";
export { resolveTheme, snapshotTheme, canvasThemeCss, canvasThemeCssWithReport } from "@/features/themes";
export { readUpload, saveUpload, signImageUrl } from "@/features/uploads";
export { registerAppPort } from "@/features/settings/app-port";
export { getInstanceSettings } from "@/features/settings/store";
export { compileDocumentCss, compileChromeCss, compileNodeCss } from "@/features/components/server";
// Wave 2 lead wiring (components SFR-6). Importing the library's server module also registers the
// library with components, so the guest resolver expands instances and the Insert tab lists them.
export { libraryForDoc, getLibrary, registerLibraryDeleteHandler, importLibrary, toComponentFile, parseComponentFile, CONTAINS_CODE_NOTICE } from "@/features/library/server";
export { registerComponentToolsBackend } from "@/features/components/tools";
