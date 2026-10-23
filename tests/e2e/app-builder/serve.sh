#!/usr/bin/env bash
# Starts the built app-builder slot (.next-app-builder) on port 3115 with a fresh data folder: the
# migrations (0006 has app-builder's tables). Playwright reuses the running server.
#   tests/e2e/app-builder/serve.sh            fresh data
#   KEEP_DATA=1 tests/e2e/app-builder/serve.sh  keep the data folder
# Test-only values: none of these are real credentials.
set -euo pipefail
cd "$(dirname "$0")/../../.."
port=3115
data="./data/e2e-app-builder"
export NODE_ENV=production
export ATRIUM_DIST_DIR=.next-app-builder
export ATRIUM_DATA_DIR="$data"
export ATRIUM_PUBLIC_URL="http://127.0.0.1:${port}"
export BETTER_AUTH_SECRET="e2e-only-not-a-real-secret-app-builder-0123456789"
export ATRIUM_OWNER_EMAIL=owner@atrium.test
export ATRIUM_OWNER_PASSWORD=e2e-owner-password-123
export ATRIUM_TRUSTED_PROXIES="127.0.0.1,::1"
unset ATRIUM_MASTER_KEY ATRIUM_GOOGLE_CLIENT_ID ATRIUM_GOOGLE_CLIENT_SECRET ATRIUM_OIDC_CLIENT_ID ATRIUM_OIDC_CLIENT_SECRET
if [ "${KEEP_DATA:-0}" != "1" ]; then
  rm -rf "$data"
  mkdir -p "$data"
  pnpm exec drizzle-kit migrate >/dev/null
fi
exec pnpm exec next start -p "$port" -H 127.0.0.1
