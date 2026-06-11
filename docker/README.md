# `tracer-docker`

The production web image for the tracer viewer, plus the just recipes that
build and run it. The viewer is a static SPA served by Caddy, which also
reverse-proxies the Tempo HTTP API under `/tempo/*`.

The endpoint is **not** configurable in the UI — it is supplied at deploy time
via the `TEMPO_URL` environment variable. This keeps a deployment pinned to one
Tempo and avoids needing CORS on the Tempo server (the browser only ever talks
to the viewer's own origin).

The demo stack (Tempo + a simulated consensus cluster) lives in
[`demo/`](./demo/) and reuses this same production image.

## Install dependencies

* `docker`: https://www.docker.com/get-started/
* `docker-buildx`: https://github.com/docker/buildx?tab=readme-ov-file#installing
* `just`: https://github.com/casey/just

## Build & run the standalone viewer

From this directory:

```sh
just build                                  # build tracer-web:local
just app https://tempo.example.com          # run it against your Tempo
```

Then open http://localhost:8080.

`TEMPO_URL` accepts a `host:port` (assumed http, e.g. `tempo.internal:3200`) or
a full URL (e.g. `https://tempo.example.com`). To reach a Tempo running on the
host machine, use `just app http://host.docker.internal:3200`. If `TEMPO_URL`
is unset the container fails to start — the endpoint is required.

Deploying elsewhere is the same image with the env var set, e.g.:

```sh
docker run -p 8080:8080 -e TEMPO_URL=https://tempo.example.com \
  ghcr.io/clabby/tracer-web:latest
```

## Run the demo

```sh
just demo          # build images + start Tempo, the cluster, and the viewer
just demo-logs     # tail all services (or `just demo-logs node-0`)
just demo-down     # stop the demo (keeps the Tempo data volume)
just clean         # remove demo containers, the volume, and local images
```

See [`demo/README.md`](./demo/README.md) for details.

## Ports

| Port | Service | Purpose                          |
|------|---------|----------------------------------|
| 8080 | web     | Web viewer (proxies `/tempo/*`)  |

The demo additionally exposes Tempo's `3200` (HTTP API) and `4317` (OTLP gRPC).
