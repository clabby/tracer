# tracer

A trace viewer for distributed systems where many nodes run the *same* system.
It reads spans and events from a [Grafana Tempo](https://grafana.com/oss/tempo/)
instance and renders them as multi-instance flamegraphs: spans emitted by
separate nodes executing the same protocol viewed side by side.

<p align="center">
<img width="1882" height="1212" alt="Screenshot 2026-06-11 at 2 42 04 AM" src="https://github.com/user-attachments/assets/670cd813-4f38-4961-9a32-f6f5202a2202" />
</p>


## Why tracer

### For multi-instance deployments

Distributed systems emit one logical operation (a consensus round, a quorum, a
broadcast) across many nodes at once. Most viewers show you one node's spans at
a time. tracer is built around the cross-node view:

- **One trace, every node.** When nodes share a trace id for the same round,
  tracer lays each instance out on its own lane on a shared time axis — so you
  see who started late, who stalled, and how the work overlapped across the
  cluster.
- **Merged aggregate flame.** Collapse all instances onto one flame, each span
  split into per-instance sub-bars, to compare the same code path across nodes.
- **Cross-node skew, surfaced.** A **stats** tab (per span: p50/p95/max, error
  rate, and the straggler node + its delta) and a **heatmap** (span × node, hot
  cells = the slow node per phase) make the lagging node obvious at a glance.
- **Focus a sub-tree across services.** Double-click a span to zoom every
  node's matching sub-tree at once — drill into "exchange" on all 20 nodes
  together, not one trace at a time.
- **Sort lanes** by duration / finish time / error count to float stragglers to
  the top.

### vs. Grafana's default Tempo viewer

Grafana renders a single trace as one span tree. tracer is a focused,
purpose-built viewer that goes further:

- **Multi-instance is the model, not an afterthought** — per-node lanes, the
  merged flame, and the cross-node stats/heatmap above have no equivalent in
  Grafana's single-tree view.
- **A real flamegraph canvas** — wheel-zoom around the cursor, drag-pan, a
  scrubbable timeline minimap, **self-time** and **wait-gap** shading, and
  live **span search/highlight** — fast for ~10k spans.
- **Events are first-class** — an events overlay on the flame plus a dedicated
  searchable events tab.
- **Zero setup to read.** No datasource config, no login: the deployment is
  pinned to one Tempo via `TEMPO_URL`, the browser only talks to the viewer's
  origin (no CORS), and it opens straight on results.
- **Dense, quiet, monospace UI** designed for reading traces, not dashboards.

## Quick start

Run the published image, pointed at your Tempo. The container reverse-proxies
`/tempo/*` to `TEMPO_URL`, so the browser only talks to the viewer's origin (no
CORS needed on Tempo):

```sh
docker run -p 8080:8080 -e TEMPO_URL=https://tempo.example.com \
  ghcr.io/clabby/tracer-web:latest
```

Then open http://localhost:8080. `TEMPO_URL` is required and accepts a
`host:port` (assumed http, e.g. `tempo:3200`) or a full URL; to reach a Tempo
running on the host, use `-e TEMPO_URL=http://host.docker.internal:3200`. See
[`docker/README.md`](docker/README.md) for deployment details.

## Demo

No Tempo handy? Run the bundled demo — single-binary Tempo, a simulated
multi-node consensus cluster, and the viewer:

```sh
cd docker && just demo
open http://localhost:8080
```

`just demo` builds the images and starts the stack with a fresh `RUN_ID`; the
nodes emit one consensus round per second. Stop it with `just demo-down`. See
[`docker/demo/README.md`](docker/demo/README.md).

## Development

```sh
cd web
bun install
bun run dev        # http://localhost:5173, proxies /tempo → localhost:3200
bun test src       # unit tests
bun run check      # typecheck
```

The Rust load generator lives in `docker/demo/loadgen/`
(`cargo run -p consensus-sim` from there), the deployment pieces in `docker/`.
Architecture and contracts: `DESIGN.md`.
