// Status marks differ by shape, never colour alone: up = filled circle, warn = triangle, down = square.
export type StatusState = "up" | "warn" | "down" | "unknown";

const LABELS: Record<StatusState, string> = { up: "Up", warn: "Warning", down: "Down", unknown: "Unknown" };

export function StatusMark({ state, label }: { state: StatusState; label?: string }) {
  return <span role="img" aria-label={label ?? LABELS[state]} className="status-mark" data-state={state} />;
}
