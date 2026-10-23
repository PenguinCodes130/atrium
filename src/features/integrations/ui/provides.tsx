// The right-hand window on a setup screen (premium-feel r2): what the integration will provide once
// it is connected, so the screen is not half empty. Names and shapes only, from the package card.
import { Window } from "@/features/shell";
import type { PackageCard } from "../service";
import { packageSegment } from "./titles";

const SHAPE_WORD: Record<string, string> = { stat: "one value", series: "values over time", table: "a table", status: "up and down list" };

/** Wave 2.7 (A8.1): a package with many reads lists them by group, names only; Advanced ones are counted. */
function Grouped({ endpoints }: { endpoints: PackageCard["endpoints"] }) {
  const groups: { name: string; labels: string[] }[] = [];
  for (const e of endpoints.filter((x) => !x.advanced)) {
    const name = e.group ?? "Other";
    (groups.find((g) => g.name === name) ?? groups[groups.push({ name, labels: [] }) - 1]!).labels.push(e.label);
  }
  const advanced = endpoints.filter((x) => x.advanced);
  return (
    <ul className="flex flex-col">
      {groups.map((g) => (
        <li key={g.name} className="flex flex-col gap-0.5 border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0" data-provides-group={g.name}>
          <span className="type-callout text-fg">{g.name}</span>
          <span className="type-body text-fg-2">{g.labels.join(", ")}</span>
        </li>
      ))}
      {advanced.length > 0 && (
        <li className="flex flex-col gap-0.5 py-3 last:pb-0" data-provides-group="Advanced">
          <span className="type-callout text-fg">Advanced</span>
          <span className="type-body text-fg-2">{advanced.map((e) => e.label).join(", ")}</span>
        </li>
      )}
    </ul>
  );
}

export function ProvidesWindow({ pkg }: { pkg: PackageCard }) {
  return (
    <Window title={`${packageSegment(pkg.id)} / provides`} status={`${pkg.endpoints.length} ${pkg.endpoints.length === 1 ? "endpoint" : "endpoints"}`} padded={false} data-provides={pkg.id}>
      <div className="flex flex-col gap-3 p-5 max-sm:p-4">
        <h2 className="type-title-3 text-fg">What it provides</h2>
        {pkg.endpoints.length === 0 ? (
          <p className="type-body text-fg-2">You pick its endpoints after it is connected.</p>
        ) : pkg.endpoints.some((e) => e.group) ? (
          <Grouped endpoints={pkg.endpoints} />
        ) : (
          <ul className="flex flex-col">
            {pkg.endpoints.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0" data-provides-endpoint={e.id}>
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="type-callout text-fg">{e.label}</span>
                  <span className="type-label text-fg-3">{SHAPE_WORD[e.shape] ?? e.shape}</span>
                </span>
                <span className="type-body text-fg-2">{e.description}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="type-body text-fg-3">Apps bind to these as data sources once the integration is saved.</p>
      </div>
    </Window>
  );
}
