// Bindings in words (builder ease spec 3.2 and 3.3): errors as sentences naming the source with the
// closest real name, the data chip's line, the Data group's sentence and "Last read 3 min ago". Pure.

/** Edit distance between two names (case-insensitive). */
function distance(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** The real name closest to a typed one, when it is close enough to be a typo (or null). */
export function closestName(name: string, names: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const n of names) {
    const d = distance(name, n);
    if (d < bestD) {
      best = n;
      bestD = d;
    }
  }
  if (best === null) return null;
  const limit = Math.max(name.length > 3 ? 2 : 1, Math.floor(Math.max(name.length, best.length) / 3));
  return bestD <= limit || best.toLowerCase().startsWith(name.toLowerCase()) || name.toLowerCase().startsWith(best.toLowerCase()) ? best : null;
}

/** "There is no data source called lightz. Did you mean lights?" */
export function unknownSourceSentence(name: string, sources: readonly string[]): string {
  const near = closestName(name, sources);
  if (near) return `There is no data source called ${name}. Did you mean ${near}?`;
  if (sources.length) return `There is no data source called ${name}. This app's sources are ${listWords(sources)}.`;
  return `There is no data source called ${name}. This app has no data sources yet: add one with Pick data.`;
}

const ROOT_WORDS: Record<string, string> = {
  $item: "the current row of a repeat",
  $index: "the current row's number",
  $input: "what a control sends",
  $page: "this page",
  $app: "this app",
  $viewer: "the person viewing",
  $user: "the person viewing",
  $now: "the current time",
  $param: "a library component's settings",
  $data: "the block's data",
};

/** "$itme is not something a template can read. Did you mean $item (the current row of a repeat)?" */
export function unknownRootSentence(root: string): string {
  const near = closestName(root, Object.keys(ROOT_WORDS));
  return near ? `${root} is not something a template can read. Did you mean ${near} (${ROOT_WORDS[near]})?` : `${root} is not something a template can read. Use a data source's name, or $item, $now or $viewer.`;
}

function listWords(names: readonly string[]): string {
  const n = names.slice(0, 6);
  const tail = names.length > 6 ? ` and ${names.length - 6} more` : "";
  return n.length < 2 ? `${n[0] ?? ""}${tail}` : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}${tail}`;
}

/** Facts about a data source for the chip: where it reads from and how it is doing right now. */
export type SourceFacts = {
  /** The integration's name in words ("Home Assistant"). */
  integration?: string;
  refreshSec?: number;
  state?: "fresh" | "stale" | "failed" | "empty";
  /** When it was last read (an ISO time or epoch ms). */
  fetchedAt?: string | number;
};

/** What a chip needs to describe a template: words for it, and facts about a source. */
export type BindingDescriber = {
  /** Words for a template the picker could have written ("Number of rows in lights"), or null. */
  words?(template: string): string | null;
  source?(name: string): SourceFacts | null;
};

/** "every 10 s" */
export function refreshWords(sec: number | undefined): string {
  if (!sec || sec <= 0) return "";
  if (sec < 60) return `every ${sec} s`;
  if (sec % 3600 === 0) return `every ${sec / 3600} h`;
  if (sec % 60 === 0) return `every ${sec / 60} min`;
  return `every ${sec} s`;
}

/** "Last read 3 min ago" (or "Not read yet"). */
export function lastReadWords(at: string | number | undefined, now = Date.now()): string {
  if (at === undefined || at === null || at === "") return "Not read yet";
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return "Not read yet";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "Last read just now";
  const m = Math.round(s / 60);
  if (m < 60) return `Last read ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `Last read ${h} h ago`;
  return `Last read ${Math.round(h / 24)} days ago`;
}

/** A value as the chip shows it: short, no quotes. */
export function chipValue(v: unknown): string {
  if (v === undefined || v === null) return "no value yet";
  if (typeof v === "string") return v === "" ? "empty" : v.length > 40 ? `${v.slice(0, 37)}...` : v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (typeof v === "boolean") return v ? "on" : "off";
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? "item" : "items"}`;
  if (typeof v === "object") {
    const d = v as { kind?: string; value?: unknown; unit?: string; rows?: unknown[]; total?: number; series?: unknown[]; items?: { state?: string }[] };
    if (d.kind === "stat") return `${chipValue(d.value)}${d.unit ? ` ${d.unit}` : ""}`;
    if (d.kind === "table") return `${d.total ?? d.rows?.length ?? 0} rows`;
    if (d.kind === "series") return `${d.series?.length ?? 0} series`;
    if (d.kind === "status") return `${(d.items ?? []).filter((i) => i.state === "up").length} of ${(d.items ?? []).length} up`;
    return `${Object.keys(v).length} fields`;
  }
  return String(v);
}

/** The chip's first part: the template in words, or "Custom value from lights". */
export function chipWords(template: string, source: string, describe?: BindingDescriber): string {
  return describe?.words?.(template) ?? `Custom value from ${source}`;
}

/** Where the value comes from: "Home Assistant, every 10 s". */
export function chipFrom(source: string, facts: SourceFacts | null | undefined): string {
  const every = refreshWords(facts?.refreshSec);
  return [facts?.integration ?? source, every].filter(Boolean).join(", ");
}

/** "Lights on · 4 · Home Assistant, every 10 s" */
export function chipLine(words: string, value: string, from: string): string {
  return [words, value, from].filter(Boolean).join(" · ");
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
/** "Number of rows in lights" reads "the number of rows in lights" inside a sentence. */
const inSentence = (w: string) => (/^(All|The) /.test(w) ? lowerFirst(w) : `the ${lowerFirst(w)}`);

/**
 * The Data group's opening sentence: "Shows the number of rows in lights, from Home Assistant, refreshed
 * every 10 seconds." A template with no words reads "Shows a custom value from lights".
 */
export function dataSentence(template: string, source: string, describe?: BindingDescriber, facts?: SourceFacts | null): { sentence: string; custom: boolean } {
  const words = describe?.words?.(template) ?? null;
  if (!words) return { sentence: `Shows a custom value from ${source}`, custom: true };
  const parts = [`Shows ${inSentence(words)}`];
  if (facts?.integration) parts.push(`from ${facts.integration}`);
  if (facts?.refreshSec) parts.push(`refreshed every ${facts.refreshSec} ${facts.refreshSec === 1 ? "second" : "seconds"}`);
  return { sentence: `${parts.join(", ")}.`, custom: false };
}
