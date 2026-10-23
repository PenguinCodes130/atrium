// "Connect an integration" from the builder's data picker (Wave 2.5 data picking spec 3.2, criterion 3):
// the picker leaves a short note in this tab's session storage, and once an integration is saved the setup
// flows send the person back to the builder page they came from with the picker open on it. Only builder
// paths are honoured, and only for 30 minutes, so the note can never redirect anywhere else.
export const PICK_RETURN_KEY = "atrium:pick-return";
const MAX_AGE_MS = 30 * 60 * 1000;
const BUILDER_PATH = /^\/build\/[a-z0-9-]{1,60}(?:\/[a-z0-9-]{1,60})?$/;
const ID = /^[A-Za-z0-9_:-]{1,80}$/;

/** The builder address to go back to for a newly saved integration, or null (and the note is cleared). */
export function builderReturnFor(integrationId: string): string | null {
  try {
    const raw = window.sessionStorage.getItem(PICK_RETURN_KEY);
    window.sessionStorage.removeItem(PICK_RETURN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { path?: unknown; at?: unknown; node?: unknown; prop?: unknown };
    if (typeof v.path !== "string" || !BUILDER_PATH.test(v.path) || typeof v.at !== "number" || Date.now() - v.at > MAX_AGE_MS) return null;
    const q = new URLSearchParams({ connect: integrationId });
    if (typeof v.node === "string" && ID.test(v.node)) q.set("node", v.node);
    if (typeof v.prop === "string" && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(v.prop)) q.set("prop", v.prop);
    return `${v.path}?${q}`;
  } catch {
    return null;
  }
}
