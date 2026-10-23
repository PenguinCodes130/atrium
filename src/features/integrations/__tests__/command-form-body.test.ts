// App-builder final r4 SFR (gauntlet w2-r3 item 3): the Custom API "Add a command" form says which declared
// parameters its body never sends, since only "{{ params.<name> }}" in the body carries a value.
import { describe, expect, it } from "vitest";
import { unsentDeclared } from "../ui/commands";

const PARAMS = '{ "type": "object", "properties": { "on": { "type": "boolean" }, "level": { "type": "integer" } } }';

describe("unsentDeclared", () => {
  it("lists declared parameters the body never uses", () => {
    expect(unsentDeclared(PARAMS, "")).toEqual(["on", "level"]);
    expect(unsentDeclared(PARAMS, '{ "on": "{{ params.on }}" }')).toEqual(["level"]);
    expect(unsentDeclared(PARAMS, '{ "on": "{{params.on}}", "x": ["{{ params.level }}"] }')).toEqual([]);
  });
  it("says nothing while either box is not valid JSON, or when nothing is declared", () => {
    expect(unsentDeclared("{", "")).toEqual([]);
    expect(unsentDeclared(PARAMS, "{ on: ")).toEqual([]);
    expect(unsentDeclared('{ "type": "object", "properties": {} }', "")).toEqual([]);
  });
});
