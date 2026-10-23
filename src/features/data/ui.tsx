"use client";
// Data state marks and the shaped-data preview. The source lives in integrations/ui/data-state.tsx
// because the workspace .gitignore pattern "data/" hides this folder from Tailwind's class scanner
// (reported as a shared file request). Import from here.
export { DataStateBadge, ShapedPreview } from "@/features/integrations/ui/data-state";
