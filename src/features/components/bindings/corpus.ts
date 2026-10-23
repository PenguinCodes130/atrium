// The shared binding test set (spec criterion 17): the same templates and data are evaluated in
// Node (unit tests) and in the browser (the gallery's binding harness, e2e), and must match exactly.
import type { BindingScope } from "@/core/contracts";

export const CORPUS_NOW = 1_760_000_000_000; // fixed clock, so `ago` and `$now` are deterministic

export function corpusScope(): BindingScope {
  const cpu = { kind: "stat" as const, value: 41.27, unit: "%", label: "CPU", delta: { value: -2.5, period: "1h" }, thresholds: { warn: 70, bad: 90 } };
  const mem = { kind: "stat" as const, value: "7.5", unit: "GB", label: "Memory" };
  const load = { kind: "series" as const, unit: "%", series: [{ name: "pve1", points: [[1, 10], [2, null], [3, 30]] as [number, number | null][] }, { name: "pve2", points: [[1, 5], [2, 6]] as [number, number | null][] }] };
  const hosts = {
    kind: "table" as const,
    columns: [
      { key: "name", label: "Name", type: "text" as const },
      { key: "cpu", label: "CPU", type: "number" as const },
      { key: "state", label: "State", type: "status" as const },
    ],
    rows: [
      { name: "web", cpu: 12, state: "up", bytes: 1536 },
      { name: "db", cpu: 64, state: "warn", bytes: 5_368_709_120 },
      { name: "cache", cpu: 3, state: "up", bytes: 512 },
    ],
    total: 312,
  };
  const svc = { kind: "status" as const, items: [{ label: "NPM", state: "up" as const }, { label: "Kuma", state: "down" as const, detail: "timeout" }] };
  return {
    $data: { cpu, mem, load, hosts, svc },
    $sources: { cpu: { state: "fresh", sourceTimestamp: "2026-10-18T10:00:00.000Z", refreshSec: 30 }, hosts: { state: "stale", refreshSec: 30 } },
    $page: { id: "p_aaaaaaaaaa", slug: "overview", title: "Overview" },
    $app: { id: "app1", slug: "homelab", name: "Homelab" },
    $user: { kind: "user", name: "Tristan" },
    $now: CORPUS_NOW,
  } as BindingScope;
}

export const CORPUS: string[] = [
  "{{ cpu.value | round(1) }}%",
  "{{ cpu.series }}",
  "{{ cpu.value }}",
  "{{ cpu }}",
  "CPU {{ cpu.value | round }} {{ cpu.unit }}",
  "{{ cpu.label | upper }}",
  "{{ cpu.label | lower }}",
  "{{ cpu.delta.value }}",
  "{{ cpu.thresholds.warn + 1 }}",
  "{{ cpu.value > 40 ? 'hot' : 'ok' }}",
  "{{ cpu.value >= cpu.thresholds.warn }}",
  "{{ !(cpu.value < 10) && true }}",
  "{{ mem.value * 2 }}",
  "{{ mem.value + ' ' + mem.unit }}",
  "{{ (cpu.value - 1.27) / 4 }}",
  "{{ 10 % 4 }}",
  "{{ -cpu.value }}",
  "{{ 1 / 0 }}",
  "{{ hosts.rows | count }}",
  "{{ hosts.total }}",
  "{{ hosts.first.name }}",
  "{{ hosts.rows[1].name }}",
  "{{ hosts.rows['1'].cpu }}",
  "{{ hosts.find('name', 'db').cpu }}",
  "{{ hosts.find('name', 'nope').cpu | default('none') }}",
  "{{ hosts.rows | map('name') | join(' / ') }}",
  "{{ hosts.rows | sum('cpu') }}",
  "{{ hosts.rows | avg('cpu') | round(2) }}",
  "{{ hosts.rows | min('cpu') }}",
  "{{ hosts.rows | max('cpu') }}",
  "{{ hosts.rows | sort('cpu') | map('name') }}",
  "{{ hosts.rows | sort('name', 'desc') | map('name') | join }}",
  "{{ hosts.rows | filter('state', 'up') | count }}",
  "{{ hosts.rows[1].bytes | bytes }}",
  "{{ hosts.first.bytes | bytes }}",
  "{{ 93784 | duration }}",
  "{{ 61 | duration }}",
  "{{ 0.4234 | percent }}",
  "{{ 0.4234 | percent(1) }}",
  "{{ 1760000000000 | date }}",
  "{{ 1760000000000 | date('DD MMM YYYY') }}",
  "{{ $now - 300000 | ago }}",
  "{{ '2026-10-18T10:00:00Z' | date('HH:mm') }}",
  "{{ svc.items | count }}",
  "{{ svc.first.label }}",
  "{{ svc.items | filter('state', 'down') | map('label') | join }}",
  "{{ svc.items[1].detail | truncate(3) }}",
  "{{ load.series | count }}",
  "{{ load.series[0].points[1][1] }}",
  "{{ load.series | map('name') }}",
  "{{ cpu.$state }}",
  "{{ hosts.$state }}",
  "{{ cpu.$updatedAt }}",
  "{{ $page.title }} / {{ $app.name }}",
  "{{ $viewer.kind }}",
  "Hello {{ $viewer.name }}",
  "{{ $now }}",
  "{{ null | default(5) }}",
  "{{ '' | default('empty') }}",
  "{{ true == 'true' }}",
  "{{ cpu.value != 41.27 }}",
  "{{ cpu.nothing.deeper }}",
  "plain text, no binding",
  "{{ unknownsource.value }}",
  "{{ cpu.constructor }}",
  "{{ cpu['__proto__'] }}",
  "{{ cpu.value | nofilter }}",
  "{{ cpu.value + }}",
  "{{ $item }}",
  "{{ $param.cpu }}",
];
