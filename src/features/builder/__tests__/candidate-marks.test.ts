// Wave 2.10b F2: the markers a data choice carries in "What should this show?" (Empty, Zero, Error with its
// reason, Stale with its age), from the value the picker peeked.
import { describe, expect, it } from "vitest";
import { ageWords, candidateMarker } from "../candidate-marks";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const item = { defaultRefreshSec: 30 };
const series = (lastAgoSec: number, step = 60, v = 5) => ({
  kind: "series" as const,
  series: [{ name: "a", points: Array.from({ length: 10 }, (_, i) => [NOW - (lastAgoSec + (9 - i) * step) * 1000, v] as [number, number]) }],
});

describe("candidate markers (F2)", () => {
  it("an ordinary value has no marker; nothing peeked yet has none either", () => {
    expect(candidateMarker({ data: { kind: "stat", value: 7.8, label: "CPU" } }, item, NOW)).toBeNull();
    expect(candidateMarker(undefined, item, NOW)).toBeNull();
    expect(candidateMarker({ data: series(20) }, item, NOW)).toBeNull();
  });
  it("Zero for a zero value, a zero string or a series whose every line ends at zero", () => {
    expect(candidateMarker({ data: { kind: "stat", value: 0, label: "x" } }, item, NOW)).toEqual({ kind: "zero", words: "Zero" });
    expect(candidateMarker({ data: { kind: "stat", value: "0", label: "x" } }, item, NOW)?.kind).toBe("zero");
    expect(candidateMarker({ data: series(10, 60, 0) }, item, NOW)?.kind).toBe("zero");
  });
  it("Empty for no rows, no items, no points, a blank value, or a read whose check found nothing", () => {
    expect(candidateMarker({ data: { kind: "table", columns: [], rows: [] } }, item, NOW)).toEqual({ kind: "empty", words: "Empty: no rows" });
    expect(candidateMarker({ data: { kind: "status", items: [] } }, item, NOW)?.words).toBe("Empty: nothing listed");
    expect(candidateMarker({ data: { kind: "series", series: [] } }, item, NOW)?.words).toBe("Empty: no points");
    expect(candidateMarker({ data: { kind: "stat", value: " ", label: "x" } }, item, NOW)?.kind).toBe("empty");
    expect(candidateMarker({ error: "Prometheus has no value for this right now." }, { ...item, check: { status: "empty", at: "2026-10-29T11:00:00Z" } }, NOW)).toEqual({ kind: "empty", words: "Empty: no value right now" });
  });
  it("Error with its reason, in words", () => {
    expect(candidateMarker({ error: "Connection refused" }, item, NOW)).toEqual({ kind: "error", words: "Error: Connection refused", reason: "Connection refused" });
    expect(candidateMarker({ error: "  " }, item, NOW)?.words).toBe("Error: No answer.");
  });
  it("Stale with its age: a series whose newest point is 10 minutes old, or a value the server says is old", () => {
    expect(candidateMarker({ data: series(600) }, item, NOW)).toEqual({ kind: "stale", words: "Stale · 10 min old", ageSec: 600 });
    // The normal gap between points (a 5 minute step) never marks a series stale.
    expect(candidateMarker({ data: series(280, 300) }, item, NOW)).toBeNull();
    // A read refreshed every 5 minutes is not stale at 6 minutes.
    expect(candidateMarker({ data: series(360) }, { defaultRefreshSec: 300 }, NOW)).toBeNull();
    const old = new Date(NOW - 3 * 3600_000).toISOString();
    expect(candidateMarker({ data: { kind: "stat", value: 3, label: "x" }, fetchedAt: old }, item, NOW)?.words).toBe("Stale · 3 h old");
    expect(candidateMarker({ data: { kind: "stat", value: 3, label: "x" }, fetchedAt: new Date(NOW - 20_000).toISOString() }, item, NOW)).toBeNull();
  });
  it("ages read in plain words", () => {
    expect(ageWords(45)).toBe("45 s old");
    expect(ageWords(600)).toBe("10 min old");
    expect(ageWords(3 * 3600)).toBe("3 h old");
    expect(ageWords(86400 * 2)).toBe("2 days old");
    expect(ageWords(34 * 3600)).toBe("34 h old");
  });
});
