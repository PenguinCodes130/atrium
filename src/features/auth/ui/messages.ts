// Plain messages for the sign-in screens. Each says what happened and what to do next.

export const MESSAGES = {
  wrongCredentials: "That email and password do not match. Check both and try again.",
  wrongCode: "That code is not right. Check your authenticator app and try again.",
  wrongBackupCode: "That backup code is not right or was already used. Try another one.",
  enterEmail: "Enter your email.",
  enterPassword: "Enter your password.",
  notAllowlisted: "This email is not on the allowlist. Ask the owner of this Atrium to add it.",
  unverified: "Your provider has not verified this email address. Verify it there, then try again.",
  providerFailed: "Sign-in with that provider did not complete. Try again.",
  network: "Atrium could not be reached. Check your connection and try again.",
  generic: "Something went wrong. Try again.",
} as const;

/** Maps the `?error=` code a provider sign-in returns with to a message. */
export function providerErrorMessage(code: string | undefined | null): string | null {
  if (!code) return null;
  const c = code.toLowerCase();
  if (c.includes("allowlist")) return MESSAGES.notAllowlisted;
  if (c.includes("verified") || c.includes("not_linked") || c.includes("not linked")) return MESSAGES.unverified;
  return MESSAGES.providerFailed;
}

type ApiError = { error?: { code?: string; message?: string }; code?: string; message?: string };

/** Turns a failed /api/auth response into the message to show. */
export async function messageFor(res: Response, context: "password" | "totp" | "backup"): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as ApiError;
  const code = body.error?.code ?? body.code ?? "";
  const message = body.error?.message ?? body.message ?? "";
  if (res.status === 429) return message.startsWith("Too many attempts") ? message : "Too many attempts. Try again in 1 minutes.";
  if (code === "not_allowlisted") return MESSAGES.notAllowlisted;
  if (code === "missing_email") return MESSAGES.enterEmail;
  if (code === "weak_password") return message;
  if (code === "no_password" && message) return message;
  if (context === "totp" && (res.status === 401 || res.status === 400)) return MESSAGES.wrongCode;
  if (context === "backup" && (res.status === 401 || res.status === 400)) return MESSAGES.wrongBackupCode;
  if (res.status === 401 || res.status === 400) return MESSAGES.wrongCredentials;
  return MESSAGES.generic;
}
