#!/usr/bin/env bash
# Runs the built app (.next) on the LAN at http://<this machine's first IP>:3102 (override with ATRIUM_LAN_HOST).
# Uses its own data folder (data/live, git-ignored). On first run it generates the auth secret
# and a one-time owner password into data/live (mode 600); the password variable is only read
# while no owner exists. Build first with: pnpm build
set -euo pipefail
cd "$(dirname "$0")/.."

host="${ATRIUM_LAN_HOST:-$(hostname -I | awk '{print $1}')}"
port="${ATRIUM_LAN_PORT:-3102}"
data="./data/live"
mkdir -p "$data"
chmod 700 "$data"

[ -f "$data/auth-secret" ] || (umask 077; openssl rand -base64 32 > "$data/auth-secret")
[ -f "$data/owner-password" ] || (umask 077; openssl rand -base64 18 | tr -d '/+=' > "$data/owner-password")

export NODE_ENV=production
export ATRIUM_DATA_DIR="$data"
export ATRIUM_PUBLIC_URL="http://${host}:${port}"
export BETTER_AUTH_SECRET="$(cat "$data/auth-secret")"
export ATRIUM_OWNER_EMAIL="${ATRIUM_OWNER_EMAIL:?set ATRIUM_OWNER_EMAIL}"
# Only the very first boot needs the password; after that Atrium ignores it and warns.
[ -f "$data/atrium.db" ] || export ATRIUM_OWNER_PASSWORD="$(cat "$data/owner-password")"

exec pnpm exec next start -H 0.0.0.0 -p "$port"
