// components: public surface (architecture v3 section 2, Wave 2 lead prep "components provides").
// Browser-safe. Server-only helpers (node CSS compiling) are in "@/features/components/server".
export { componentDefs, getComponentDef, registerPackageComponent } from "./catalogue/defs";
export { RenderNode, treeUsesNow } from "./render/render-node";
export { RenderDeviceProvider, NodeCssProvider, RenderEditProvider } from "./render/context";
export { evaluateBinding, evaluateTemplate, isBinding, sourcesInTemplate, usesNow, MAX_TEMPLATE_BYTES, MAX_STEPS, FILTERS } from "./bindings";
export type { BindingResult, BindingFailure } from "./bindings";
export { sourcesUsed, resolveGuestValues, pageScope, libraryRefs, findPage, eachNode } from "./page";
export { suggestComponent, suggestedType } from "./suggest";
export { insertCatalogue, newNode } from "./insert";
export type { InsertGroup } from "./insert";
export { InspectorPanels, HtmlCodeWindow, BindingField, InspectorHeader, nodeDisplayName, CODE_DOCK_SELECTOR } from "./inspector/inspector";
export type { InspectorProps } from "./inspector/inspector";
export { validateNodes, validateSubtree } from "./validate";
export type { ValidateOptions } from "./validate";
export { createControlRunner, draftConfirmText } from "./control-runner";
export { compileStyle, THEME_TOKENS } from "./style/compile";
export { expandInstance, detachInstance, findNodeDeep, instanceNodeFor, libraryDiff, parameterize, containsCode } from "./library-instance";
export { valueKey, NOT_SHARED, NOT_AVAILABLE } from "./render/resolve";
export type { PageScope, NodeStatus, ControlInfo, Device } from "./render/resolve";
export { HtmlBlockView as HtmlBlockHost, ESCAPE_MESSAGE, DATA_NOTICE } from "./render/html-block";
export { newId } from "./ids";
export { META as CATALOGUE_META } from "./catalogue/meta";
