"use client";
// Client-side imports from the components subsystem (wave-2-lead-prep.md "components provides"), kept
// in one module so the import path can follow the provider's client entry.
export { RenderNode, InspectorPanels, InspectorHeader, createControlRunner, RenderDeviceProvider, RenderEditProvider, NodeCssProvider } from "@/features/components";
export { ThemePicker } from "@/features/themes/client";
export { UploadField } from "@/features/uploads/client";
// Wave 2.10 B1: the builder reads each def's `sizing` (A11.2) to know which components grow to their content.
export { getComponentDef } from "@/features/components";
// Round 2 (seam with components' item 2): an inserted icon's box is made square on the measured canvas.
export { iconSlotIn, measureTableOverflow } from "@/features/components";
