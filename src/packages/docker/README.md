# Docker

Lists containers through the Docker Engine API.

- Requests: GET only. The host refuses any other method for this package, whatever endpoint is configured.
- Endpoint: `tcp://host:port`, recommended through a read-only Docker socket proxy that allows only container, image, info and stats reads. The raw socket `unix:///var/run/docker.sock` is root-equivalent on the host and is refused unless the server sets `ATRIUM_ALLOW_DOCKER_SOCKET=true`.
- Paths: `/version` (health), `/containers/json?all=1`.
