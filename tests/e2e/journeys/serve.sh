#!/usr/bin/env bash
# Journey suite server: the app-builder slot's build (.next-app-builder holds the whole app) on port 3117
# with its own fresh data folder. Build first: ATRIUM_DIST_DIR=.next-app-builder pnpm exec next build
#   tests/e2e/journeys/serve.sh            fresh data (always use this before a run)
# Test-only values: none of these are real credentials.
set -euo pipefail
cd "$(dirname "$0")/../../.."
port=3117
data="./data/e2e-journeys"
export NODE_ENV=production
export ATRIUM_DIST_DIR=.next-app-builder
export ATRIUM_DATA_DIR="$data"
export ATRIUM_PUBLIC_URL="http://127.0.0.1:${port}"
export BETTER_AUTH_SECRET="e2e-only-not-a-real-secret-journeys-0123456789"
export ATRIUM_OWNER_EMAIL=owner@atrium.test
export ATRIUM_OWNER_PASSWORD=e2e-owner-password-123
export ATRIUM_TRUSTED_PROXIES="127.0.0.1,::1"
unset ATRIUM_MASTER_KEY ATRIUM_GOOGLE_CLIENT_ID ATRIUM_GOOGLE_CLIENT_SECRET ATRIUM_OIDC_CLIENT_ID ATRIUM_OIDC_CLIENT_SECRET
rm -rf "$data"
mkdir -p "$data"
pnpm exec drizzle-kit migrate >/dev/null
exec pnpm exec next start -p "$port" -H 127.0.0.1
