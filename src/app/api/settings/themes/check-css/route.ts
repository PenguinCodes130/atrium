// The theme editor's Custom CSS check (Wave 2.10c r2, gauntlet w210c-r1 Fix 15): { css } in, what the
// canvas sanitiser removes and why out, so the box names what it drops. Nothing is stored. Owners and
// members, as for editing a theme.
import { z } from "zod";
import { body, handle, send } from "@/features/settings/api";
import { themeCssReport } from "@/features/themes/css-report";
import { MAX_THEME_CSS } from "@/features/themes/revalidate";

export const dynamic = "force-dynamic";

const out = z.object({ removed: z.array(z.object({ text: z.string(), reason: z.string() })), tokenHint: z.boolean() });

export function POST(req: Request) {
  return handle(req, "member", async () => {
    const { css } = await body(req, z.object({ css: z.string().max(MAX_THEME_CSS, "Custom CSS is limited to 64 KB.") }));
    return send(out, themeCssReport(css));
  });
}
