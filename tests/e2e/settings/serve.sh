#!/usr/bin/env bash
# Starts the settings slot on port 3116 from the isolated build (tests/e2e/settings/isolated-build.sh),
# with its own data folder, so the specs can reuse it (playwright reuseExistingServer).
#   tests/e2e/settings/serve.sh <build-dir> [normal|locked] > evidence/settings/r1/logs/server.log 2>&1 &
# "locked" copies the normal data folder without its master key: sealed secrets, no key (AC 10).
# Stop it by pid: ss -ltnpH 'sport = :3116'. Test-only values below; none are real credentials.
set -euo pipefail
cd "$(dirname "$0")/../../.."
APP="$(pwd)"
BUILD="${1:?build dir}"
scenario="${2:-normal}"
port=3116
export NODE_ENV=production
export ATRIUM_DIST_DIR=.next-settings
export ATRIUM_PUBLIC_URL="http://127.0.0.1:${port}"
export BETTER_AUTH_SECRET="e2e-settings-only-not-a-credential-0001"
export ATRIUM_OWNER_EMAIL=owner@atrium.test
export ATRIUM_OWNER_PASSWORD=e2e-owner-password-123
export ATRIUM_TRUSTED_PROXIES="127.0.0.1,::1"
unset ATRIUM_MASTER_KEY ATRIUM_ALLOW_DOCKER_SOCKET
case "$scenario" in
  normal)
    export ATRIUM_DATA_DIR="$APP/data/e2e-settings"
    if [ "${FRESH:-0}" = "1" ]; then rm -rf "$ATRIUM_DATA_DIR"; fi
    mkdir -p "$ATRIUM_DATA_DIR"
    # The migrations (0006 has the Wave 2 tables).
    ./node_modules/.bin/drizzle-kit migrate >/dev/null
    ;;
  locked)
    export ATRIUM_DATA_DIR="$APP/data/e2e-settings-locked"
    rm -rf "$ATRIUM_DATA_DIR"
    cp -r "$APP/data/e2e-settings" "$ATRIUM_DATA_DIR"
    rm -f "$ATRIUM_DATA_DIR/master.key"
    ;;
  *) echo "unknown scenario $scenario" >&2; exit 2 ;;
esac
cd "$BUILD"
exec ./node_modules/.bin/next start -p "$port" -H 127.0.0.1
