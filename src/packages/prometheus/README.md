# Prometheus

Reads target health, instant queries and range queries from the Prometheus HTTP API v1.

- Requests: GET only. Queries are sent as URL parameters, so this package sends no POST requests.
- Paths: `/api/v1/status/buildinfo` (health and version), `/api/v1/targets?state=active`, `/api/v1/query`, `/api/v1/query_range`.
- Credentials: optional. "Login" picks no login (default), Basic auth (username in config, password sealed in the vault) or a bearer token (sealed). Secrets are only sent to the saved Prometheus address.
