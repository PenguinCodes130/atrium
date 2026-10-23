#!/usr/bin/env bash
# Settings r1 verification build. While components and app-builder are mid-build in the same tree, the
# whole-app `next build` cannot pass (their unfinished files fail to resolve). This copies the app to a
# scratch folder WITHOUT the two in-flight subsystems' directories (and a stub launcher page in place of
# app-builder's), then builds the settings slot there. It never edits the real tree. The lead's
# whole-app build after the wave is the real V3.
#   tests/e2e/settings/isolated-build.sh <scratch-dir>
set -euo pipefail
cd "$(dirname "$0")/../../.."
APP="$(pwd)"
OUT="${1:?scratch dir}"
rm -rf "$OUT"
mkdir -p "$OUT"
rsync -a --exclude /node_modules --exclude '/.next*' --exclude /data --exclude /evidence --exclude /test-results --exclude '/tsconfig.slot-*' "$APP/" "$OUT/"
cp -al "$APP/node_modules" "$OUT/node_modules"  # hard links: same disk, no extra space, the real tree is never written
cd "$OUT"
# The in-flight Wave 2 subsystems (components, app-builder) are left out of this build only.
rm -rf src/features/apps src/features/builder src/features/versions src/features/pwa src/features/components src/features/library \
  "src/app/(app)" "src/app/(shell)/build" "src/app/(shell)/library" src/app/api/apps src/app/api/library src/app/sandbox public/sandbox src/app/manifest.ts src/app/sw.ts
cat > "src/app/(shell)/page.tsx" <<'TSX'
// Isolated settings build only: stands in for app-builder's launcher.
import { EmptyRoom } from "@/features/shell";
export const dynamic = "force-dynamic";
export default function Home() {
  return <EmptyRoom headingLevel={1} title="Apps" body="The launcher is left out of this isolated settings build." />;
}
TSX
if grep -rln "features/apps\|features/components\|features/builder\|features/versions\|features/library" src --include=*.ts --include=*.tsx | grep -v '^src/features/settings/test/'; then
  echo "files above still import an in-flight subsystem" >&2
fi
ATRIUM_DIST_DIR=.next-settings ./node_modules/.bin/next build
