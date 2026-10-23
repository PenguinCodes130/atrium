// Counted nouns for the backup screens and refusals (settings gauntlet w2-r1 item 13): "1 library
// component", "2 library components". Pure, used on the server and in the browser.
const SINGULAR: Record<string, string> = {
  "other users": "other user",
  apps: "app",
  integrations: "integration",
  "saved credentials": "saved credential",
  "saved themes": "saved theme",
  uploads: "upload",
  "library components": "library component",
  people: "person",
};

/** "1 library component", "2 library components". `plural` is the label as stored (plural form). */
export function counted(n: number, plural: string): string {
  return `${n} ${n === 1 ? (SINGULAR[plural] ?? plural.replace(/s$/, "")) : plural}`;
}

/** "3 apps, 1 saved theme and 2 uploads" for a { label: count } map. */
export function countedList(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([k, n]) => counted(n, k));
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
