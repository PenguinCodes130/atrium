// fetchFavicon (Wave 2.10c N4, A11.6): ask THIS Atrium to fetch a website's icon and store it as an
// image upload. The browser only talks to its own Atrium; the website is read by the server.
//   const { path, name } = await fetchFavicon("https://plex.example");  // rejects with the server's sentence
const ROUTE = "/api/settings/uploads/favicon";
const FALLBACK = "Atrium could not fetch that icon. Try again.";

export type FetchedFavicon = { path: string; name: string };

/** `refresh: true` skips the server's 7 day store and fetches the site again. */
export async function fetchFavicon(url: string, opts: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<FetchedFavicon> {
  let res: Response;
  try {
    res = await fetch(ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: url.trim(), ...(opts.refresh ? { refresh: true } : {}) }), signal: opts.signal, credentials: "same-origin" });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    throw new Error(FALLBACK);
  }
  const body = (await res.json().catch(() => null)) as { path?: unknown; name?: unknown; error?: { message?: unknown } } | null;
  if (res.ok && body && typeof body.path === "string" && typeof body.name === "string") return { path: body.path, name: body.name };
  throw new Error(typeof body?.error?.message === "string" ? body.error.message : FALLBACK);
}
