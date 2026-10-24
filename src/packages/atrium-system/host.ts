// A10.6 `host`: the Atrium server's own CPU, memory, disk, uptime and network, read from the
// operating system (on Linux, /proc). Rates (CPU, network) compare two samples a moment apart; the
// last sample is kept, so a later read compares with it instead of waiting.
import { readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import type { ShapedData, ValueFormat } from "@/core/contracts";
import { dataDir } from "@/core/env";
import { fail } from "../lib";

export const HOST_MEASURES = ["cpu", "memory", "disk", "uptime", "netIn", "netOut"] as const;
export type HostMeasure = (typeof HOST_MEASURES)[number];

export const HOST_LABELS: Record<HostMeasure, { label: string; format: ValueFormat }> = {
  cpu: { label: "CPU in use", format: "percent" },
  memory: { label: "Memory in use", format: "percent" },
  disk: { label: "Disk in use", format: "percent" },
  uptime: { label: "Uptime", format: "seconds" },
  netIn: { label: "Network in", format: "bytesPerSec" },
  netOut: { label: "Network out", format: "bytesPerSec" },
};

type CpuSample = { at: number; idle: number; total: number };
type NetSample = { at: number; rx: number; tx: number };
const g = globalThis as unknown as { __atriumHostCpu?: CpuSample; __atriumHostNet?: NetSample };

function cpuSample(): CpuSample {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { at: Date.now(), idle, total };
}

function netSample(): NetSample | null {
  try {
    let rx = 0, tx = 0;
    for (const line of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
      const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const name = m[1]!.trim();
      if (name === "lo" || /^(veth|docker|br-|virbr|tap|fw)/.test(name)) continue;
      const f = m[2]!.trim().split(/\s+/).map(Number);
      rx += f[0] ?? 0;
      tx += f[8] ?? 0;
    }
    return { at: Date.now(), rx, tx };
  } catch {
    return null;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

async function cpuPercent(): Promise<number> {
  let prev = g.__atriumHostCpu;
  if (!prev || Date.now() - prev.at > 120_000) { prev = cpuSample(); await wait(300); }
  const now = cpuSample();
  g.__atriumHostCpu = now;
  const dt = now.total - prev.total;
  if (dt <= 0) return 0;
  return round(Math.min(100, Math.max(0, 100 * (1 - (now.idle - prev.idle) / dt))));
}

async function netRate(dir: "rx" | "tx"): Promise<number> {
  let prev = g.__atriumHostNet;
  if (!prev || Date.now() - prev.at > 120_000) { const s = netSample(); if (!s) fail("bad_response", "This server does not report its network traffic."); prev = s; await wait(500); }
  const now = netSample();
  if (!now) fail("bad_response", "This server does not report its network traffic.");
  g.__atriumHostNet = now;
  const sec = (now.at - prev.at) / 1000;
  if (sec <= 0) return 0;
  return round(Math.max(0, (now[dir] - prev[dir]) / sec), 0);
}

function memoryPercent(): number {
  try {
    const info = readFileSync("/proc/meminfo", "utf8");
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? NaN);
    const total = kb("MemTotal"), avail = kb("MemAvailable");
    if (Number.isFinite(total) && Number.isFinite(avail) && total > 0) return round(100 * (1 - avail / total));
  } catch { /* not Linux: fall back below */ }
  return round(100 * (1 - os.freemem() / os.totalmem()));
}

function diskPercent(): number {
  try {
    const s = statfsSync(dataDir());
    const total = s.blocks * s.bsize;
    if (total <= 0) throw new Error("no size");
    return round(100 * (1 - (s.bavail * s.bsize) / total));
  } catch {
    fail("bad_response", "This server does not report its disk space.");
  }
}

export function hostMeasure(v: unknown): HostMeasure {
  const k = typeof v === "string" && v ? v : "cpu";
  if (!(HOST_MEASURES as readonly string[]).includes(k)) fail("config", `"${k.slice(0, 40)}" is not a measure of this server.`, `Pick one of: ${HOST_MEASURES.join(", ")}.`);
  return k as HostMeasure;
}

export async function hostStat(measure: HostMeasure): Promise<ShapedData> {
  const { label, format } = HOST_LABELS[measure];
  const value =
    measure === "cpu" ? await cpuPercent()
    : measure === "memory" ? memoryPercent()
    : measure === "disk" ? diskPercent()
    : measure === "uptime" ? Math.round(os.uptime())
    : await netRate(measure === "netIn" ? "rx" : "tx");
  return { kind: "stat", value, label, format };
}
