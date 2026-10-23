"use client";
// Shared by <Glow> and the window title bar: which glow play we are on, and whether a window inside
// the glow will draw the title bar flash (otherwise <Glow> draws its own outline flash).
import { createContext } from "react";

export type GlowState = { play: number; reduced: boolean; registerWindow: () => () => void };
export const GlowContext = createContext<GlowState | null>(null);
