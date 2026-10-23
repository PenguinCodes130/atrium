// Loading state inside the shell frame (app-shell, design v4): windows with their title bars and sunk
// skeleton bars under a 1.6s shimmer; the frame itself renders at once.
import { SkeletonGrid } from "@/features/shell/skeleton";

export default function Loading() {
  return <SkeletonGrid />;
}
