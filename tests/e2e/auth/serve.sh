#!/usr/bin/env bash
# Starts the already-built auth slot (.next-auth) on port 3111 with a fresh data folder and a given
# first-run scenario, so the e2e specs can reuse it (playwright reuseExistingServer).
#   tests/e2e/auth/serve.sh <scenario> [data-dir]
# Scenarios: owner (both owner variables), email-only, missing, invalid, locked (sealed secret, key removed),
# owner-direct (owner, but no trusted proxies: the per-IP limit keys on the socket peer only),
# reset (owner exists, then a restart with ATRIUM_RESET_OWNER_PASSWORD; use KEEP_DATA=1 on the second start),
# guest (owner; round3.spec.ts makes its guest apps through app-builder, since Wave 2 the real app access hook),
# owner-nogoogle (owner, with no Google and no OIDC variables: a first-time Docker install, round 5 criterion 24).
# The e2e runner sends X-Forwarded-For from 127.0.0.1, so the other scenarios trust loopback as a proxy
# (as NPM would be trusted in a real deployment) to give each test its own client address.
# Test-only values: none of these are real credentials.
set -euo pipefail
cd "$(dirname "$0")/../../.."
scenario="${1:-owner}"
data="${2:-./data/e2e-auth}"
port=3111

export NODE_ENV=production
export ATRIUM_DIST_DIR=.next-auth
export ATRIUM_DATA_DIR="$data"
export ATRIUM_PUBLIC_URL="http://127.0.0.1:${port}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-e2e-only-auth-secret-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
export ATRIUM_GOOGLE_CLIENT_ID="${ATRIUM_GOOGLE_CLIENT_ID:-e2e-google-client.apps.example}"
export ATRIUM_GOOGLE_CLIENT_SECRET="${ATRIUM_GOOGLE_CLIENT_SECRET:-e2e-google-placeholder}"
unset ATRIUM_OWNER_EMAIL ATRIUM_OWNER_PASSWORD ATRIUM_MASTER_KEY ATRIUM_RESET_OWNER_PASSWORD
export ATRIUM_TRUSTED_PROXIES="127.0.0.1,::1"

case "$scenario" in
  guest) export ATRIUM_OWNER_EMAIL=owner@atrium.test ATRIUM_OWNER_PASSWORD=e2e-owner-password-123 ;;
  owner-nogoogle) export ATRIUM_OWNER_EMAIL=owner@atrium.test ATRIUM_OWNER_PASSWORD=e2e-owner-password-123
                  unset ATRIUM_GOOGLE_CLIENT_ID ATRIUM_GOOGLE_CLIENT_SECRET ATRIUM_OIDC_CLIENT_ID ATRIUM_OIDC_CLIENT_SECRET ;;
  owner|locked) export ATRIUM_OWNER_EMAIL=owner@atrium.test ATRIUM_OWNER_PASSWORD=e2e-owner-password-123 ;;
  owner-direct) export ATRIUM_OWNER_EMAIL=owner@atrium.test ATRIUM_OWNER_PASSWORD=e2e-owner-password-123; unset ATRIUM_TRUSTED_PROXIES ;;
  reset) export ATRIUM_OWNER_EMAIL=owner@atrium.test ATRIUM_RESET_OWNER_PASSWORD=e2e-reset-password-456 ;;
  email-only) export ATRIUM_OWNER_EMAIL=owner@atrium.test ;;
  missing) ;;
  invalid) export ATRIUM_OWNER_EMAIL=not-an-email ;;
  *) echo "unknown scenario $scenario" >&2; exit 2 ;;
esac

if [ "${KEEP_DATA:-0}" != "1" ]; then
  rm -rf "$data"
  mkdir -p "$data"
  pnpm exec drizzle-kit migrate >/dev/null
  if [ "$scenario" = locked ]; then
    # A sealed secret whose master key is gone: random bytes stand in for the ciphertext.
    node -e '
      const db = require("better-sqlite3")(process.argv[1] + "/atrium.db");
      const r = (n) => require("crypto").randomBytes(n).toString("base64");
      db.prepare("INSERT INTO secret (id, owner_type, owner_id, key, ciphertext, iv, tag, key_version, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run("e2e-locked", "integration", "int-e2e", "token", r(24), r(12), r(16), 1, Date.now());
    ' "$data"
  fi
fi
exec pnpm exec next start -p "$port" -H 127.0.0.1
