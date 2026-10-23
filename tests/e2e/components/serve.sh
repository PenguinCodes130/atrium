#!/usr/bin/env bash
# Starts the built components slot (.next-components) on port 3114 so the specs can reuse it
# (playwright reuseExistingServer). Build first: ATRIUM_DIST_DIR=.next-components pnpm exec next build
#   tests/e2e/components/serve.sh > evidence/components/r1/logs/server.log 2>&1 &
# Test-only values below; none are real credentials. The migrations (0006 has the Wave 2 tables) are enough.
set -euo pipefail
cd "$(dirname "$0")/../../.."
port=3114
export NODE_ENV=production
export ATRIUM_DIST_DIR=.next-components
export ATRIUM_PUBLIC_URL="http://127.0.0.1:${port}"
export ATRIUM_LAN_ORIGINS="http://localhost:${port}"
export BETTER_AUTH_SECRET="e2e-components-only-not-a-credential-0001"
export ATRIUM_OWNER_EMAIL=owner@atrium.test
export ATRIUM_OWNER_PASSWORD=e2e-owner-password-123
export ATRIUM_DATA_DIR=./data/e2e-components
# The test-only component gallery (/library/gallery) answers 404 without this (gauntlet w2-r1 Fix 18).
export ATRIUM_TEST_GALLERY="${ATRIUM_TEST_GALLERY-1}"
unset ATRIUM_MASTER_KEY ATRIUM_ALLOW_DOCKER_SOCKET
if [ "${FRESH:-0}" = "1" ]; then rm -rf "$ATRIUM_DATA_DIR"; fi
mkdir -p "$ATRIUM_DATA_DIR"
pnpm exec drizzle-kit migrate >/dev/null
exec pnpm exec next start -p "$port" -H 127.0.0.1
