import { describe, expect, it } from "vitest";
import type { BindingScope } from "@/core/contracts";
import { evaluateBinding, evaluateTemplate, rootsOf, sourcesInTemplate, usesNow, resolveValue, pathsOf } from "./index";
import { CORPUS, corpusScope } from "./corpus";

const scope = (data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): BindingScope =>
  ({ $data: data, $page: { id: "p", slug: "s", title: "T" }, $app: { id: "a", slug: "a", name: "A" }, $user: { kind: "user" }, ...extra }) as BindingScope;

describe("bindings: criterion 12", () => {
  it("rounds and keeps text in a mixed template", () => {
    expect(evaluateBinding("{{ cpu.value | round(1) }}%", scope({ cpu: { kind: "stat", value: 41.27, label: "CPU" } }))).toBe("41.3%");
  });
  it("passes the raw array for a whole-template expression", () => {
    const series = [{ name: "a", points: [[1, 2]] }];
    const v = evaluateBinding("{{ cpu.series }}", scope({ cpu: { kind: "series", series } }));
    expect(Array.isArray(v)).toBe(true);
    expect(v).toBe(series);
  });
  it("whole templates keep numbers and booleans", () => {
    expect(evaluateBinding("{{ 1 + 2 }}", scope())).toBe(3);
    expect(evaluateBinding("  {{ 1 < 2 }}  ", scope())).toBe(true);
    expect(evaluateBinding("x{{ 1 + 2 }}", scope())).toBe("x3");
  });
});

describe("bindings: criterion 13 (safety)", () => {
  for (const t of ["{{ cpu.constructor }}", "{{ cpu.__proto__ }}", "{{ cpu.prototype }}", "{{ cpu['constructor'] }}", "{{ constructor }}", "{{ hosts.rows | map('__proto__') }}"]) {
    it(`refuses ${t}`, () => {
      const r = evaluateTemplate(t, scope({ cpu: { kind: "stat", value: 1, label: "x" }, hosts: { kind: "table", columns: [], rows: [{}] } }));
      if (t.includes("map(")) expect(r.ok && (r.value as unknown[]).every((x) => x === undefined)).toBe(true);
      else {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.message).toMatch(/cannot be used/);
      }
    });
  }
  it("refuses a computed prototype key at runtime", () => {
    const r = evaluateTemplate("{{ cpu[k] }}", scope({ cpu: { kind: "stat", value: 1, label: "x" } }, {}));
    expect(r.ok).toBe(false); // k is not a source
    const r2 = evaluateTemplate("{{ cpu['__pro' + 'to__'] }}", scope({ cpu: { kind: "stat", value: 1, label: "x" } }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe("binding.forbidden");
  });
  it("refuses a 3 KB template", () => {
    const t = `{{ cpu.value }}${"x".repeat(3072)}`;
    const r = evaluateTemplate(t, scope({ cpu: { kind: "stat", value: 1, label: "x" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/2 KB/);
  });
  it("stops past 10,000 steps and renders empty", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ x: i }));
    const s = scope({ big: { kind: "table", columns: [], rows } });
    const r = evaluateTemplate("{{ big.rows | sum('x') }}", s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("binding.too_many_steps");
    expect(evaluateBinding("{{ big.rows | sum('x') }}", s)).toBeUndefined();
  });
  it("has no way to call code", () => {
    for (const t of ["{{ cpu.toString() }}", "{{ alert(1) }}", "{{ (1)(2) }}", "{{ x = 1 }}", "{{ `a` }}", "{{ a; b }}"]) {
      expect(evaluateTemplate(t, scope({ cpu: { kind: "stat", value: 1, label: "x" } })).ok).toBe(false);
    }
  });
  it("does not read inherited properties", () => {
    expect(evaluateBinding("{{ cpu.hasOwnProperty }}", scope({ cpu: { kind: "stat", value: 1, label: "x" } }))).toBeUndefined();
    expect(evaluateBinding("{{ cpu.label.length }}", scope({ cpu: { kind: "stat", value: 1, label: "xyz" } }))).toBe(3);
  });
});

describe("bindings: errors name the problem and position", () => {
  it("syntax error with position", () => {
    const r = evaluateTemplate("CPU {{ cpu.value + }}", scope({ cpu: { kind: "stat", value: 1, label: "x" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The message is plain words (gauntlet w2-r1 Fix 13); the position stays on the error for the field.
      expect(r.error.message).not.toMatch(/position/);
      expect(r.error.position).toBe(19);
    }
  });
  it("unknown source", () => {
    const r = evaluateTemplate("{{ nope.value }}", scope());
    expect(!r.ok && r.error.code).toBe("binding.unknown_source");
    expect(!r.ok && r.error.message).toBe('No data source named "nope" yet.');
  });
  it("unknown filter lists filters", () => {
    const r = evaluateTemplate("{{ 1 | wat }}", scope());
    expect(!r.ok && r.error.message).toMatch(/not a filter/);
  });
  it("unclosed braces", () => {
    expect(evaluateTemplate("{{ 1 + 1", scope()).ok).toBe(false);
  });
  it("$param outside a library instance", () => {
    const r = evaluateTemplate("{{ $param.cpu }}", scope());
    expect(!r.ok && r.error.code).toBe("binding.param_outside");
  });
  it("$item outside a repeat", () => {
    expect(evaluateTemplate("{{ $item }}", scope()).ok).toBe(false);
    expect(evaluateBinding("{{ $index }}", scope({}, { $item: { a: 1 }, $index: 3 }))).toBe(3);
  });
});

describe("bindings: filters and shortcuts", () => {
  const s = corpusScope();
  const cases: [string, unknown][] = [
    ["{{ hosts.first.name }}", "web"],
    ["{{ hosts.find('name', 'db').cpu }}", 64],
    ["{{ hosts.rows[1].bytes | bytes }}", "5 GB"],
    ["{{ hosts.first.bytes | bytes }}", "1.5 KB"],
    ["{{ 93784 | duration }}", "1d 2h"],
    ["{{ 0.4234 | percent }}", "42%"],
    ["{{ 0.4234 | percent(1) }}", "42.3%"],
    ["{{ 1760000000000 | date('DD MMM YYYY') }}", "09 Oct 2025"],
    ["{{ $now - 300000 | ago }}", "5m ago"],
    ["{{ hosts.rows | sort('cpu') | map('name') | join }}", "cache, web, db"],
    ["{{ hosts.rows | filter('state', 'up') | count }}", 2],
    ["{{ svc.items[1].detail | truncate(3) }}", "tim..."],
    ["{{ cpu.$state }}", "fresh"],
    ["{{ hosts.$state }}", "stale"],
    ["{{ mem.$state }}", "fresh"],
    ["{{ null | default(5) }}", 5],
    ["{{ $viewer.name }}", "Tristan"],
    ["{{ 1 / 0 }}", null],
  ];
  for (const [t, want] of cases) it(t, () => expect(evaluateBinding(t, s)).toEqual(want));
});

describe("bindings: helpers", () => {
  it("roots, sources and $now", () => {
    expect(rootsOf("{{ cpu.value }} {{ $now | date }}").sort()).toEqual(["$now", "cpu"]);
    expect(sourcesInTemplate("{{ a.value + b.value }} {{ $page.title }}").sort()).toEqual(["a", "b"]);
    expect(usesNow("{{ cpu.value }}")).toBe(false);
    expect(usesNow("{{ $now | ago }}")).toBe(true);
    expect(pathsOf("{{ cpu.value | round(1) }} {{ hosts.rows[0].name }}").sort()).toEqual(["cpu.value", "hosts.rows.0.name"]);
  });
  it("resolveValue walks nested props and collects errors", () => {
    const errors: { prop: string }[] = [];
    const v = resolveValue({ a: { $bind: "{{ 1 + 1 }}" }, b: [{ $bind: "{{ bad. }}" }], c: "x" }, scope(), "p", errors as never);
    expect(v).toEqual({ a: 2, b: [undefined], c: "x" });
    expect(errors.map((e) => e.prop)).toEqual(["p.b[0]"]);
  });
});

describe("bindings: shared corpus (criterion 17, node side)", () => {
  it("has at least 50 templates and evaluates every one deterministically", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(50);
    const a = CORPUS.map((t) => evaluateTemplate(t, corpusScope()));
    const b = CORPUS.map((t) => evaluateTemplate(t, corpusScope()));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
