// Loading skeletons (design v4 "System screens"): the frame renders at once and each window shows
// its title bar with sunk skeleton bars and a 1.6s left-to-right shimmer (transform only; none under
// reduced motion).

/** A window that is still loading: its title bar, then sunk bars. */
export function SkeletonPanel({ className, height = 160, title = "loading" }: { className?: string; height?: number; title?: string; /** @deprecated v3 */ material?: string }) {
  const bars = Math.max(2, Math.floor((height - 40) / 28));
  return (
    <div aria-hidden data-skeleton data-window="skeleton" className={`flex flex-col border border-line-strong bg-bg-hi shadow-window ${className ?? ""}`} style={{ minHeight: height }}>
      <div className="flex h-(--titlebar-height) flex-none items-center gap-2 bg-titlebar px-2.5 type-label text-titlebar-fg">
        <svg viewBox="0 0 12 14" width={9} height={10} aria-hidden>
          <path d="M1 13V6a5 5 0 0 1 10 0v7Z" fill="var(--paper)" fillOpacity={0.6} />
        </svg>
        {title}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-(--window-pad)">
        {Array.from({ length: bars }, (_, i) => (
          <div key={i} className="atrium-skeleton h-4" style={{ width: `${[72, 92, 56, 84, 64][i % 5]}%` }} data-skeleton-bar />
        ))}
      </div>
    </div>
  );
}

export function SkeletonGrid({ count = 6 }: { count?: number; /** @deprecated v3 */ material?: string }) {
  // In the shell content column, with a bar where the screen header's title will be (one left edge).
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="screen-x flex flex-col gap-8 py-(--gutter)" data-loading>
      <span className="sr-only">Loading</span>
      <div aria-hidden className="atrium-skeleton h-(--type-title-1-line) w-[min(320px,60%)]" data-skeleton-title />
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: count }, (_, i) => (
          <SkeletonPanel key={i} height={i % 3 === 0 ? 200 : 160} />
        ))}
      </div>
    </div>
  );
}
