// Shared Playwright fixtures (skeleton). Owner credentials match playwright.config.ts.
import { test as base, expect } from "@playwright/test";

export const OWNER = { email: "owner@atrium.test", password: "e2e-owner-password-123" };

export const test = base;
export { expect };
