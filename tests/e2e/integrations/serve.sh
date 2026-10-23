#!/usr/bin/env bash
# Starts the built integrations slot (.next-integrations) on port 3113 so the specs can reuse it
# (playwright reuseExistingServer). Build first: ATRIUM_DIST_DIR=.next-integrations pnpm exec next build
#   tests/e2e/integrations/serve.sh [normal|locked] > evidence/integrations/r6/logs/server-normal.log 2>&1 &
# "locked" copies the normal data folder without its master key: sealed secrets, no key.
# Test-only values below; none are real credentials.
set -euo pipefail
cd "$(dirname "$0")/../../.."
scenario="${1:-normal}"
port=3113
export NODE_ENV=production
export ATRIUM_DIST_DIR=.next-integrations
export ATRIUM_PUBLIC_URL="http://127.0.0.1:${port}"
export BETTER_AUTH_SECRET="e2e-integrations-only-not-a-credential-0001"
export ATRIUM_OWNER_EMAIL=owner@atrium.test
export ATRIUM_OWNER_PASSWORD=e2e-owner-password-123
unset ATRIUM_MASTER_KEY ATRIUM_ALLOW_DOCKER_SOCKET
case "$scenario" in
  normal)
    export ATRIUM_DATA_DIR=./data/e2e-integrations
    if [ "${FRESH:-0}" = "1" ]; then rm -rf "$ATRIUM_DATA_DIR"; mkdir -p "$ATRIUM_DATA_DIR"; pnpm exec drizzle-kit migrate >/dev/null; fi
    pnpm exec drizzle-kit migrate >/dev/null
    ;;
  locked)
    export ATRIUM_DATA_DIR=./data/e2e-integrations-locked
    rm -rf "$ATRIUM_DATA_DIR"
    cp -r ./data/e2e-integrations "$ATRIUM_DATA_DIR"
    # Keep the WAL files: recent writes may not be checkpointed yet. Only the key goes.
    rm -f "$ATRIUM_DATA_DIR/master.key"
    ;;
  *) echo "unknown scenario $scenario" >&2; exit 2 ;;
esac
exec pnpm exec next start -p "$port" -H 127.0.0.1
