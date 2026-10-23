// Round 5 (Fix List r2 item 9, quality-bar r2): range chart series are distinguishable. The legend
// shows only the labels that differ between series, and each series has its own colour and dash.
import { describe, expect, it } from "vitest";
import { legendNames, parseSeriesName, SERIES_STYLES } from "../ui/series-chart";

const node = (mode: string) => `{cpu="0",host="ACE",instance="10.77.99.8:9100",job="node",mode="${mode}"}`;

describe("series legend", () => {
  it("parses a Prometheus series name", () => {
    expect(parseSeriesName(`node_cpu_seconds_total${node("idle")}`)).toEqual({ metric: "node_cpu_seconds_total", labels: { cpu: "0", host: "ACE", instance: "10.77.99.8:9100", job: "node", mode: "idle" } });
  });
  it("keeps only the labels that vary (the critic's five CPU modes)", () => {
    const names = ["iowait", "irq", "nice", "softirq", "steal"].map(node);
    expect(legendNames(names)).toEqual(['mode="iowait"', 'mode="irq"', 'mode="nice"', 'mode="softirq"', 'mode="steal"']);
  });
  it("falls back to the metric name when nothing varies, and keeps plain names", () => {
    expect(legendNames(['up{job="a"}'])).toEqual(["up"]);
    expect(legendNames(["Temperature", "Humidity"])).toEqual(["Temperature", "Humidity"]);
  });
  it("gives every drawn series a different colour token and dash", () => {
    expect(new Set(SERIES_STYLES.map((s) => s.stroke)).size).toBe(SERIES_STYLES.length);
    expect(new Set(SERIES_STYLES.map((s) => s.dash ?? "solid")).size).toBe(SERIES_STYLES.length);
  });
});
