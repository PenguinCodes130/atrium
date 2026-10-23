#!/usr/bin/env bash
# Starts the review build (.next-review) on port 3121 for the Wave 2 lead checks, with a fresh data folder.
# ATRIUM_REVIEW_DATA picks another data folder (the gauntlet uses data/gauntlet-w2-r1).
# Build first with: ATRIUM_DIST_DIR=.next-review pnpm exec next build
# Test-only values: none of these are real credentials.
set -euo pipefail
cd "$(dirname "$0")/../../.."
port=3121
data="${ATRIUM_REVIEW_DATA:-./data/e2e-review}"
export NODE_ENV=production
export ATRIUM_DIST_DIR=.next-review
export ATRIUM_DATA_DIR="$data"
export ATRIUM_PUBLIC_URL="http://127.0.0.1:${port}"
export ATRIUM_LAN_ORIGINS="http://10.0.0.5:${port}"
export BETTER_AUTH_SECRET="e2e-only-not-a-real-secret-review-0123456789abc"
export ATRIUM_OWNER_EMAIL=owner@atrium.test
export ATRIUM_OWNER_PASSWORD=e2e-owner-password-123
export ATRIUM_TRUSTED_PROXIES="127.0.0.1,::1"
unset ATRIUM_MASTER_KEY ATRIUM_GOOGLE_CLIENT_ID ATRIUM_GOOGLE_CLIENT_SECRET ATRIUM_OIDC_CLIENT_ID ATRIUM_OIDC_CLIENT_SECRET
rm -rf "$data"
mkdir -p "$data"
pnpm exec drizzle-kit migrate >/dev/null
exec pnpm exec next start -p "$port" -H 127.0.0.1
