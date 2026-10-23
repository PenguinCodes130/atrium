# Package fixtures

- `prometheus-*.json`: recorded from the live Prometheus at http://10.77.99.7:9090 on 2026-10-17 (read-only GETs), trimmed to a few targets and series.
- `npm-*.json`, `proxmox-*.json`, `pfsense-*.json`, `uptime-kuma-metrics.txt`, `docker-*.json`, `feed-*.xml`: written by hand in each product's documented response format. They are not recordings, because no token is set for those services and no request with a guessed token is ever sent. Values are invented and contain no credentials.
