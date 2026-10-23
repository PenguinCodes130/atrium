// Small fetch helper for settings screens: JSON in and out, errors as { message, code, issues, extra }.
export type ApiError = { message: string; code?: string; issues?: { path: string; message: string }[]; extra: Record<string, unknown>; status: number };

export async function api<T>(url: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const r = await fetch(url, {
    method: init.method ?? (init.body !== undefined || init.form ? "POST" : "GET"),
    headers: init.form ? undefined : { "content-type": "application/json", accept: "application/json" },
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  if (r.ok) return (await r.json()) as T;
  const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; code?: string }; issues?: ApiError["issues"] } & Record<string, unknown>;
  const err: ApiError = { message: j.error?.message ?? (r.status === 403 ? "You do not have permission to do that." : "Something went wrong. Try again."), code: j.error?.code, issues: j.issues, extra: j, status: r.status };
  throw err;
}

export function errorText(x: unknown, fallback = "Something went wrong. Try again."): string {
  return x && typeof x === "object" && "message" in x && typeof (x as { message: unknown }).message === "string" ? (x as { message: string }).message : fallback;
}
