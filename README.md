<p align="center"><img src="public/brand/mark.svg" width="72" alt="Atrium"></p>

# Atrium

A self-hosted, Notion-like dashboard for homelabs. Build pages that pull live data from Prometheus, Proxmox, Nginx Proxy Manager, Docker, RSS and any JSON API into components you arrange yourself.

**Status:** early and under active development. Expect breaking changes.

## What it does

- **App builder:** pages, layouts and components (stats, charts, tables, media, links) bound to live data.
- **Integrations:** built-in adapters plus a generic one for any HTTP API. Paste a curl command or import an OpenAPI spec; Grafana dashboards can be imported as recipes.
- **Secrets stay on the server:** credentials are encrypted at rest and never sent to the browser.
- **Private by default:** owner account set from the environment, TOTP 2FA, OIDC, an allowlist, rate-limited sign-in, and guest links with expiry and an optional PIN.
- **Themes:** shareable theme files, light and dark.

## Requirements

- Node.js 22 or newer
- pnpm 11

## Run it

```bash
pnpm install
pnpm build

export ATRIUM_DATA_DIR=./data/live
export ATRIUM_PUBLIC_URL=http://localhost:3102
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
export ATRIUM_OWNER_EMAIL=you@example.com
export ATRIUM_OWNER_PASSWORD='a long password'   # only read on first boot

pnpm start
```

Open http://localhost:3102 and sign in as the owner. To serve it on your LAN, `scripts/serve-lan.sh` generates the secret and a one-time owner password into the data folder for you.

## Develop

```bash
pnpm dev          # dev server on :3102
pnpm typecheck
pnpm lint
pnpm test         # unit tests (Vitest)
```

End-to-end tests use Playwright (`tests/e2e/`).

## License

[AGPL-3.0](LICENSE). You can self-host, modify and share Atrium freely. If you run a modified version as a service for others, you must publish your changes under the same license.
