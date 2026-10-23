// Owner password recovery from the server (auth gauntlet r1, fix 4). Run from the app folder with the
// same environment as the server (ATRIUM_DATA_DIR, BETTER_AUTH_SECRET):
//
//   pnpm exec tsx --conditions=react-server src/features/auth/cli/reset-owner.ts
//
// It asks for the new password twice without echoing it, or reads it from stdin when piped:
//
//   printf '%s' "$NEW_PASSWORD" | pnpm exec tsx --conditions=react-server src/features/auth/cli/reset-owner.ts
//
// The password is never taken as an argument (it would land in the shell history and the process list).
// It must meet the password rules. Every session of every user is signed out, and the reset is logged
// and written to <data>/audit-auth.jsonl. The server can stay running.
import { resetOwnerPassword } from "../server/recovery";

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPiped(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

async function main() {
  let password: string;
  if (process.stdin.isTTY) {
    password = await readHidden("New owner password: ");
    const again = await readHidden("Type it again: ");
    if (again !== password) throw new Error("The two passwords do not match. Nothing was changed.");
  } else {
    password = await readPiped();
  }
  const r = await resetOwnerPassword(password, "cli");
  process.stdout.write(`The owner ${r.ownerEmail} can sign in with the new password. Signed out ${r.sessionsRevoked} session${r.sessionsRevoked === 1 ? "" : "s"}.\n`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : "The reset failed."}\n`);
    process.exit(1);
  },
);
