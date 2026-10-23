// The label check (builder ease spec 3.2, criterion 9): every inspector field of every built-in
// component has a written label and a one-line hint, never a generated camelCase one, and every
// simple set names real fields. labels.ts's type makes a missing entry a build error as well.
import { describe, expect, it } from "vitest";
import { BUILT_IN_TYPES, propsSchemas } from "../catalogue/schemas";
import { fieldsFor, labelOf } from "./fields";
import { FIELD_WORDS } from "./labels";

describe("the label check", () => {
  for (const type of BUILT_IN_TYPES) {
    it(`${type}: every field has a written label and hint`, () => {
      const keys = Object.keys((propsSchemas[type] as unknown as { shape: Record<string, unknown> }).shape);
      const words = FIELD_WORDS[type] as { simple: readonly string[]; fields: Record<string, { label: string; hint: string; options?: Record<string, string> }> };
      for (const k of keys) {
        const w = words.fields[k];
        expect(w, `${type}.${k} has no written label`).toBeDefined();
        expect(w!.label.trim().length, `${type}.${k} label`).toBeGreaterThan(1);
        expect(w!.hint.trim().length, `${type}.${k} hint`).toBeGreaterThan(3);
        // One line, not the raw key, and no em dash.
        expect(w!.hint).not.toMatch(/\n/);
        expect(w!.label, `${type}.${k} label is its key`).not.toBe(k);
        expect(`${w!.label}${w!.hint}`).not.toMatch(/\u2014/);
      }
      // No stale entries, and the simple set names real fields.
      for (const k of Object.keys(words.fields)) expect(keys, `${type}.${k} is not a field`).toContain(k);
      for (const k of words.simple) expect(keys).toContain(k);
      // The inspector reads these words.
      for (const f of fieldsFor(type)) {
        expect(f.label).toBe(words.fields[f.key]!.label);
        expect(f.hint).toBe(words.fields[f.key]!.hint);
      }
    });
  }
  it("a field without a written label would show its generated label (the check above would fail)", () => {
    expect(labelOf("showUpdated")).toBe("Show updated");
    expect(fieldsFor("stat").find((f) => f.key === "decimals")).toMatchObject({ label: "Decimal places", hint: "How many digits after the point", simple: true });
  });
  it("enum values have words wherever a value is not already a word", () => {
    for (const type of BUILT_IN_TYPES)
      for (const f of fieldsFor(type))
        if (f.field.kind === "enum" && f.key !== "name")
          for (const o of f.field.options) expect(f.optionWords?.[String(o)], `${type}.${f.key}=${o}`).toBeTruthy();
  });
  it("the simple sets of the spec", () => {
    const simple = (t: (typeof BUILT_IN_TYPES)[number]) => fieldsFor(t).filter((f) => f.simple).map((f) => f.key);
    expect(simple("stat")).toEqual(expect.arrayContaining(["label", "value", "unit", "decimals"]));
    expect(simple("chart")).toEqual(expect.arrayContaining(["kind", "data"]));
    expect(simple("table")).toEqual(expect.arrayContaining(["columns", "maxRows"]));
    expect(simple("text")).toEqual(["text", "size"]);
    // Wave 2.7 (media layout spec 3.1): the Picture panel's controls are the simple set; Height is folded.
    expect(simple("image")).toEqual(["src", "alt", "fit", "shape", "rotate", "flipX", "flipY", "straighten", "zoom", "focusX", "focusY", "filters", "caption", "captionAt", "link"]);
    expect(simple("image")).not.toContain("height");
    expect(simple("video")).toEqual(expect.arrayContaining(["src", "shape", "fit", "rotate", "flipX", "flipY", "filters", "caption", "poster", "startAt"]));
    expect(simple("video")).not.toContain("height");
    for (const t of ["button", "toggle", "slider"] as const) expect(simple(t)).toEqual(expect.arrayContaining(["label", "control"]));
  });
});
