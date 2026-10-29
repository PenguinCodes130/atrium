#!/usr/bin/env bash
# Hot-reloading dev server for quick fixes: edits show in the browser in about a second, no build.
# Runs on http://<this machine's first IP>:3140 (override with ATRIUM_DEV_PORT / ATRIUM_LAN_HOST) from its
# own build folder (.next-dev) and its own data folder (data/dev), so it never touches the live :3102.
# The first run copies the live data (data/live) into data/dev so your real apps and sign-in are there;
# FRESH=1 takes a new copy. Stop it by pid: kill $(ss -ltnpH 'sport = :3140' | grep -o 'pid=[0-9]*' | cut -d= -f2)
set -euo pipefail
cd "$(dirname "$0")/.."

host="${ATRIUM_LAN_HOST:-$(hostname -I | awk '{print $1}')}"
port="${ATRIUM_DEV_PORT:-3140}"
live="./data/live"
data="./data/dev"

if [ "${FRESH:-0}" = "1" ] || [ ! -f "$data/atrium.db" ]; then
  [ -f "$live/atrium.db" ] || { echo "no live data at $live; start :3102 once first" >&2; exit 1; }
  rm -rf "$data"
  mkdir -p "$data"
  chmod 700 "$data"
  cp -a "$live/auth-secret" "$live/master.key" "$data/"
  [ -d "$live/uploads" ] && cp -a "$live/uploads" "$data/"
  # Online backup: safe while :3102 is running (a plain cp could catch a half-written WAL).
  node -e 'const D=require("better-sqlite3");new D(process.argv[1],{readonly:true}).backup(process.argv[2]).then(()=>console.log("copied live data to",process.argv[2]))' "$live/atrium.db" "$data/atrium.db"
fi

export ATRIUM_DIST_DIR=.next-dev
export ATRIUM_DATA_DIR="$data"
export ATRIUM_PUBLIC_URL="http://${host}:${port}"
export BETTER_AUTH_SECRET="$(cat "$data/auth-secret")"
export ATRIUM_OWNER_EMAIL="${ATRIUM_OWNER_EMAIL:-owner@atrium.local}"

exec pnpm exec next dev -H 0.0.0.0 -p "$port"
