"use client";
// Saving with saved credentials (Amendment 2, "Locking"): when the server answers that a credential
// would be used on a server it is not locked to, ask "Also allow <credential> on <server>?" first,
// then retry with the confirm; a stale session then gets auth's step-up prompt, and one more retry.
// Cancelling either step saves nothing. Round 6 (Fix List r3 item 1): a credential not locked to any
// server yet asks the same way ("Lock <credential> to <server>?"), for a save and for a test, since
// every new server needs the confirm and a step-up before Atrium sends the credential there.
import { useCallback, useState, type ReactNode } from "react";
import { Button, Sheet } from "@/features/shell";
import { useStepUp } from "@/features/auth/components";
import { ApiFailure, type ApiError } from "./common";

export type OriginConfirm = { origin: string; credentials: { id: string; name: string; lockedOrigins: string[] }[] };

/** Thrown when the person cancels the confirm or the step-up: nothing was saved. */
export class SaveCancelled extends Error {
  constructor(readonly message: string) { super(message); }
}

export async function readJson<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: ApiError };
  if (!res.ok) throw new ApiFailure(res.status, data.error ?? { code: "internal", message: "Something went wrong." });
  return data as T;
}

export function sendJson(path: string, method: string, body: unknown): Promise<Response> {
  return fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
}

/**
 * Returns save(send) and the dialog to render. `send(confirmOrigins)` performs the request; save
 * resolves with the parsed body, or throws ApiFailure, or SaveCancelled when the person said no.
 */
/** How the cancelled note starts: "Not saved." for a save, "Not tested." for a test. */
export type LockedSaveOptions = { verb?: "saved" | "tested" };

function keptText(c: OriginConfirm["credentials"][number]): string {
  return c.lockedOrigins.length ? `is still locked to ${c.lockedOrigins.join(", ")}` : "is still not locked to any server";
}

export function useLockedSave(): { save: <T>(send: (confirmOrigins: boolean) => Promise<Response>, opts?: LockedSaveOptions) => Promise<T>; dialog: ReactNode } {
  const runStepUp = useStepUp();
  const [ask, setAsk] = useState<null | { confirm: OriginConfirm; resolve: (ok: boolean) => void }>(null);

  const save = useCallback(async <T,>(send: (confirmOrigins: boolean) => Promise<Response>, opts: LockedSaveOptions = {}): Promise<T> => {
    const first = await send(false);
    if (first.status !== 409) return readJson<T>(first);
    const body = (await first.clone().json().catch(() => ({}))) as { error?: ApiError; confirm?: OriginConfirm };
    if (body.error?.code !== "credential_origin_confirm" || !body.confirm) return readJson<T>(first);
    const confirm = body.confirm;
    const ok = await new Promise<boolean>((resolve) => setAsk({ confirm, resolve }));
    setAsk(null);
    const note = `Not ${opts.verb ?? "saved"}. ${confirm.credentials.map((c) => `${c.name} ${keptText(c)}`).join("; ")}.`;
    if (!ok) throw new SaveCancelled(note);
    const second = await runStepUp(() => send(true));
    if (!second) throw new SaveCancelled(note);
    return readJson<T>(second);
  }, [runStepUp]);

  const c = ask?.confirm;
  const names = c?.credentials.map((x) => x.name).join(", ") ?? "";
  const firstLock = !!c && c.credentials.every((x) => x.lockedOrigins.length === 0);
  const dialog = (
    <Sheet
      open={!!ask}
      onOpenChange={(o) => { if (!o) ask?.resolve(false); }}
      title={firstLock ? `Lock ${names} to ${c?.origin ?? ""}?` : `Also allow ${names} on ${c?.origin ?? ""}?`}
      path="integrations / credentials / new server"
      name="credential-origin-confirm"
      width={460}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="quiet" onClick={() => ask?.resolve(false)} data-origin-cancel>Cancel</Button>
          <Button variant="primary" onClick={() => ask?.resolve(true)} data-origin-confirm>{firstLock ? "Lock and continue" : "Also allow"}</Button>
        </div>
      }
    >
      {c && (
        <div className="flex flex-col gap-3" data-origin-question>
          {c.credentials.map((x) => (
            <p key={x.id} className="type-body text-fg">
              {x.lockedOrigins.length ? (
                <><strong>{x.name}</strong> is locked to <span className="font-mono">{x.lockedOrigins.join(", ")}</span>. Allowing it here also sends it to <span className="font-mono">{c.origin}</span>.</>
              ) : (
                <><strong>{x.name}</strong> is not locked to any server yet. Continuing locks it to <span className="font-mono">{c.origin}</span> and sends it there. You can remove the server later under Credentials.</>
              )}
            </p>
          ))}
          <p className="type-caption text-fg-2">You will be asked to confirm it is you. Atrium sends a saved credential only to the servers it is locked to.</p>
        </div>
      )}
    </Sheet>
  );
  return { save, dialog };
}
