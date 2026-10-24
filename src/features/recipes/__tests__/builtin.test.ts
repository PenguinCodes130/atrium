// Criterion 1: the built-in recipe files give exactly the Wave 2.7 reads (ids, labels, words, groups,
// params, refresh, needs) and the same records the interpreter runs.
import { describe, expect, it } from "vitest";
import { BUILTIN_RECIPES, prometheusManifest, RECIPES } from "@/packages/prometheus/full-manifest";
import { loadRecipes } from "@/packages/prometheus/recipe";
import w27Manifest from "@/packages/__fixtures__/prometheus-w27-manifest.json";
import w27Recipes from "@/packages/__fixtures__/prometheus-w27-recipes.json";
import { exportText, validateRecipe } from "../schema";

describe("built-in Prometheus recipes (criterion 1)", () => {
  it("give the same manifest endpoints as Wave 2.7, in the same order", () => {
    // Wave 2.9 (Amendment 10) only adds: the service block, measure, headline and history fields, and
    // the h:<id> history reads after every other endpoint. Without those it is the Wave 2.7 manifest.
    const m = JSON.parse(JSON.stringify(prometheusManifest)) as { service?: unknown; endpoints: Record<string, unknown>[] };
    delete m.service;
    m.endpoints = m.endpoints.filter((e) => !String(e.id).startsWith("h:")).map((e) => {
      const { measure, headline, history, ...rest } = e;
      void measure; void headline; void history;
      return rest;
    });
    expect(m).toEqual(w27Manifest);
  });
  it("rebuild exactly the Wave 2.7 recipe records", () => {
    expect(RECIPES).toEqual(loadRecipes(w27Recipes));
  });
  it("are three files that validate and export byte-identically", async () => {
    expect(BUILTIN_RECIPES.map((r) => r.id)).toEqual(["prometheus/node-exporter", "prometheus/cadvisor", "prometheus/proxmox"]);
    const fs = await import("node:fs");
    for (const r of BUILTIN_RECIPES) {
      const file = fs.readFileSync(`src/packages/prometheus/recipes/${r.id.split("/")[1]}.atrium-recipe.json`, "utf8");
      expect(exportText(r)).toBe(file);
      expect(validateRecipe(JSON.parse(file)).ok).toBe(true);
    }
  });
});
