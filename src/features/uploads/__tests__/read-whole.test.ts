// The uploader reads a picked file in full before sending it (operator, 2026-10-20): an iCloud photo
// that is not yet on the computer used to reach the server as a cut-off form.
import { describe, expect, it } from "vitest";
import { NOT_ON_COMPUTER, readWhole, uploadFile } from "../ui/upload-file";

describe("readWhole", () => {
  it("passes a readable file through with its bytes, name and type", async () => {
    const f = new File([new Uint8Array([1, 2, 3])], "dot.png", { type: "image/png" });
    const out = await readWhole(f);
    expect(out.name).toBe("dot.png");
    expect(out.type).toBe("image/png");
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("names the cloud-file cause when the browser cannot read the file", async () => {
    const f = new File([new Uint8Array(10)], "IMG_0001.jpeg", { type: "image/jpeg" });
    Object.defineProperty(f, "arrayBuffer", { value: () => Promise.reject(new DOMException("NotReadableError")) });
    await expect(readWhole(f)).rejects.toThrow(NOT_ON_COMPUTER);
  });
  it("names it too when fewer bytes come back than the file claims", async () => {
    const f = new File([new Uint8Array(10)], "IMG_0002.jpeg", { type: "image/jpeg" });
    Object.defineProperty(f, "arrayBuffer", { value: () => Promise.resolve(new ArrayBuffer(4)) });
    await expect(uploadFile(f, "image")).rejects.toThrow(NOT_ON_COMPUTER);
  });
});
