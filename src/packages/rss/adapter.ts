// RSS / Atom feed adapter. Read-only, GET only. The feed URL is the configured base URL.
import type { AdapterContext } from "@/core/contracts";
import { checkStatus, defineAdapter, fail, num } from "../lib";
import { parseFeed } from "./parse";

async function load(ctx: AdapterContext) {
  const res = await ctx.http.fetch({ path: "" });
  checkStatus(res);
  try {
    return parseFeed(await res.text());
  } catch {
    return fail("bad_response", "That address did not return an RSS or Atom feed.", "Use the feed's own address, often ending in /rss, /feed or .xml.");
  }
}

export default defineAdapter({
  async health(ctx) {
    const feed = await load(ctx);
    return { status: feed.items.length ? "ok" : "degraded", message: feed.items.length ? `${feed.items.length} items${feed.title ? ` in ${feed.title}` : ""}` : "The feed has no items." };
  },
  reads: {
    async items(ctx) {
      const feed = await load(ctx);
      const limit = Math.min(Math.max(num(ctx.config.limit) ?? 20, 1), 100);
      const rows = feed.items.slice(0, limit).map((i) => ({ title: i.title, link: i.link, published: i.published }));
      const newest = feed.items.find((i) => i.published !== null)?.published;
      return {
        data: {
          kind: "table",
          columns: [
            { key: "title", label: "Title", type: "text" },
            { key: "link", label: "Link", type: "link" },
            { key: "published", label: "Published", type: "time" },
          ],
          rows,
          total: feed.items.length,
        },
        ...(newest ? { sourceTimestamp: new Date(newest).toISOString() } : {}),
      };
    },
  },
});
