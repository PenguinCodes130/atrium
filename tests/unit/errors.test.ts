import { describe, expect, it } from "vitest";
import { RateLimited, errorResponse } from "@/core/errors";

describe("errorResponse", () => {
  it("returns 429 with Retry-After for rate limits", async () => {
    const res = errorResponse(new RateLimited(120));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect((await res.json()).error.message).toBe("Too many attempts. Try again in 2 minutes.");
  });
});
