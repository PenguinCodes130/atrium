// The data source form's own checks (gauntlet w2-r1 item 15): every problem lands at its field and bad
// Parameters JSON is reported, never dropped.
import { describe, expect, it } from "vitest";
import { sourceFormProblems } from "../inspector";

const base = { name: "cpu", integrationId: "int-1", endpointId: "cpu", refreshSec: "30", params: "" };
const fields = (r: ReturnType<typeof sourceFormProblems>) => r.problems.map((p) => p.where.field);

describe("sourceFormProblems", () => {
  it("accepts a good source and parses its parameters", () => {
    expect(sourceFormProblems(base, false)).toEqual({ problems: [] });
    expect(sourceFormProblems({ ...base, params: '{"domain":"light"}' }, false)).toEqual({ problems: [], params: { domain: "light" } });
  });
  it("names the field for each problem", () => {
    expect(fields(sourceFormProblems({ ...base, name: "" }, false))).toEqual(["name"]);
    expect(fields(sourceFormProblems({ ...base, name: "CPU load" }, false))).toEqual(["name"]);
    expect(fields(sourceFormProblems(base, true))).toEqual(["name"]);
    expect(fields(sourceFormProblems({ ...base, refreshSec: "soon" }, false))).toEqual(["refreshSec"]);
    expect(fields(sourceFormProblems({ ...base, params: "{domain: light" }, false))).toEqual(["params"]);
    expect(fields(sourceFormProblems({ ...base, params: "[1,2]" }, false))).toEqual(["params"]);
  });
});
