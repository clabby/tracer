# tracer demo stack

A self-contained demo: a single-binary Grafana Tempo, four simulated consensus
nodes (`consensus-sim`), and the **production** web image pointed at the
bundled Tempo (`TEMPO_URL=tempo:3200`). Everything here is demo-specific — the
shippable image and its build live one level up in [`../`](../).

## Run it

From the `docker/` directory:

```sh
just demo          # build the web + loadgen images and start the stack
```

Then open http://localhost:8080. The nodes emit one consensus round per second;
within a few seconds the search view returns traces. Each node emits its own
trace; compare rounds across nodes with `name=round` and the shared `height`
span attribute.

```sh
just demo-logs            # tail all services
just demo-logs node-0     # tail one service
just demo-down            # stop the stack (keeps the Tempo data volume)
just clean                # remove containers, the volume, and local images
```

## What's here

| File                  | Purpose                                             |
|-----------------------|-----------------------------------------------------|
| `docker-compose.yaml` | Tempo + 4 `consensus-sim` nodes + the web viewer    |
| `tempo.yaml`          | Single-binary Tempo config (local storage, 24h)     |
| `Dockerfile.loadgen`  | Builds the `consensus-sim` load generator           |
| `docker-bake.hcl`     | Bake target for the loadgen image                   |

## Scaling the cluster

Each node is its own compose service with a distinct `NODE_ID`; every node
shares `NUM_NODES`. To run more nodes, add `node-N` services and bump
`NUM_NODES` on all of them to match.

## Ports

| Port | Service | Purpose                          |
|------|---------|----------------------------------|
| 8080 | web     | Web viewer (proxies `/tempo/*`)  |
| 3200 | tempo   | Tempo HTTP API                   |
| 4317 | tempo   | OTLP gRPC ingest                 |
