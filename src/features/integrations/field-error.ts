// A user-facing error that belongs to one form field (integrations round 8). Route handlers send its
// `field` with the message ({ error: { code, message, field } }), so the form can mark that field
// invalid and point the field at the message (aria-describedby) instead of appending "(at path)".
import { AtriumError } from "@/core/errors";

export class FieldError extends AtriumError {
  constructor(
    message: string,
    readonly field: string,
    status = 400,
    code = "config",
  ) {
    super(message, status, code);
  }
}
