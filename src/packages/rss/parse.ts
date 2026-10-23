// A small, dependency-free RSS 2.0 / Atom / RSS 1.0 item parser. Text only; markup is stripped.
export type FeedItem = { title: string; link: string; published: number | null };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function text(raw: string | undefined): string {
  if (!raw) return "";
  const cdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  const noTags = cdata.replace(/<[^>]*>/g, "");
  return decodeEntities(decodeEntities(noTags).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function tag(block: string, name: string): string | undefined {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  return re.exec(block)?.[1];
}

function atomLink(block: string): string {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1] ?? "");
  const pick = links.find((a) => /rel=["']alternate["']/i.test(a)) ?? links.find((a) => !/rel=/i.test(a)) ?? links[0];
  return pick ? decodeEntities(/href=["']([^"']+)["']/i.exec(pick)?.[1] ?? "") : "";
}

function toTime(s: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export function isFeed(xml: string): boolean {
  return /<(rss|feed|rdf:RDF)[\s>]/i.test(xml.slice(0, 4096));
}

export function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  if (!isFeed(xml)) throw new Error("not a feed");
  const items: FeedItem[] = [];
  const atom = /<feed[\s>]/i.test(xml.slice(0, 4096));
  const blocks = atom ? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [] : xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  for (const b of blocks) {
    const title = text(tag(b, "title"));
    const link = atom ? atomLink(b) : text(tag(b, "link")) || text(tag(b, "guid"));
    const published = toTime(text(tag(b, atom ? "published" : "pubDate") ?? tag(b, "updated") ?? tag(b, "dc:date")));
    items.push({ title: title || "(untitled)", link, published });
  }
  items.sort((a, b) => (b.published ?? -Infinity) - (a.published ?? -Infinity));
  const head = atom ? xml : (tag(xml, "channel") ?? xml);
  const feedTitle = text(tag(head.replace(/<item\b[\s\S]*$/i, "").replace(/<entry\b[\s\S]*$/i, ""), "title"));
  return { title: feedTitle, items };
}
