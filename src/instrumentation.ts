// Shared file (lead). Runs once at server start: owner bootstrap and the master key check
// happen at boot instead of on the first request (auth shared file request, Wave 1).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureBootstrapped } = await import("@/features/auth/server/bootstrap");
    await ensureBootstrapped();
    // Wave 2: app-builder's hooks (app access, data sources) must exist before the first guest link,
    // stream or control request, not only after some app-builder route has loaded.
    await import("@/features/apps/register");
    // Wave 2.8 (A9.2): the daily live check of recipe reads starts with the server, not on first use.
    const { ensureDailyChecks } = await import("@/features/recipes/daily");
    ensureDailyChecks();
    // Wave 2.9 (A10.6): the built-in `atrium` integration exists before the first page loads.
    const { getRegistry } = await import("@/features/integrations/runtime");
    getRegistry();
  }
}
