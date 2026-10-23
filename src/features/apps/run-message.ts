// What a failed control run says to someone who cannot edit the app (gauntlet w2-r2 item 2). Pure.

/** Run messages that tell an author how to fix the app, which a guest or viewer cannot act on. */
const AUTHOR_HINT = /\s*(Fix the control's parameters in the builder\.|[^.]*\bin the builder\b[^.]*\.)\s*$/;

/**
 * What a person who cannot edit the app reads when a run fails because of how it was built (w2-r2
 * item 2): the plain failure without the builder repair text, and who can fix it.
 */
export function viewerRunMessage(message: string, canEdit: boolean, guest: boolean): string {
  if (canEdit || !AUTHOR_HINT.test(message)) return message;
  const who = guest ? "the person who shared this app" : "whoever edits this app";
  return `This control is not set up correctly yet. Ask ${who} to fix it.`;
}

