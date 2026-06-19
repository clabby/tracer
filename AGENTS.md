# AGENTS.md

Agent guide for **tracer** — a scientific OTLP trace observatory. A Bun API
server (the middle layer between Grafana Tempo and clients) serves a React
SPA plus an agent-first REST API. Each node of a distributed system (e.g. a
`commonware` consensus cluster) emits its OWN trace; tracer correlates the same
span across those separate traces by name + attribute and renders one
multi-instance comparison (lanes per node).

## Commands

Web + server (`cd web`, bun is the package manager):

- `bun run dev` — Vite dev server (proxies `/api/*` → `localhost:7777`,
  `/tempo/*` → `localhost:3200`)
- `bun run dev:api` — the API server on :7777 (TEMPO_URL defaults to
  `localhost:3200` here; required everywhere else)
- `bun run check` — `tsc --noEmit` (the lint gate; no eslint configured).
  Also the schema drift gate: the `_Check*`/`SchemaDriftChecks` asserts in
  `src/lib/apischema.ts` fail compilation when a JSON Schema and its model
  type diverge.
- `bun test src server` — unit tests (`bun:test`)
- `bun run build` — `tsc --noEmit && vite build`

CI (`.github/workflows/ci.yml`) runs check → test → build on push/PR. Run all
three locally before handing work back.

Docker / demo (`cd docker`, uses `just`):

- `just build` — build the prod image (`tracer-web:local`): one Bun process
  serving the SPA + `/api/v1` + the GET-only `/tempo` passthrough
- `just app <tempo-url>` — run the standalone viewer/API against a Tempo endpoint
- `just demo` / `just demo-down` / `just demo-logs` / `just clean` — the local
  demo stack (Tempo + 4 `consensus-sim` nodes + viewer) on http://localhost:8080

Loadgen: `cd docker/demo/loadgen && cargo check` (single binary crate
`consensus-sim`; must compile with zero errors/warnings).

Version control is **jujutsu (`jj`)**, not plain git. Make each logical change
its own revision (`jj new -m "…"`); the working copy is always a commit.

## Repository layout

```
web/                  TypeScript + React 19 + Vite SPA, plus the Bun API server
  src/lib/model.ts    AUTHORITATIVE shared types — never redefine these shapes
  src/lib/wire.ts     JSON-safe wire encoding of TraceModel (+ aggregate flatten)
  src/lib/apischema.ts JSON Schemas for the API — single source for openapi.json,
                       compile-time-checked against model.ts/wire.ts types
  src/lib/format.ts   duration/time formatting + parsing helpers
  src/lib/trace.ts    OTLP JSON → TraceModel parser + aggregate flame tree
  src/lib/traceql.ts  FilterState → TraceQL compiler
  src/lib/range.ts    time-range presets + resolution
  src/api/tempo.ts    TempoClient — the server-side Tempo engine (windowed
                       search, v2→v1 fallbacks); no longer imported by the SPA
  src/api/client.ts   ApiClient (implements ITempoClient) — what the SPA uses
  src/components/      SearchPanel, Combobox, TraceList, FlameGraph, SpanStats,
                       HeatMap, SpanDetails, EventsView, RangePicker, Select,
                       ExportModal, Calendar (each with a co-located .css)
  src/App.tsx          shell: routing, state (written last)
  server/              the API server (Bun.serve; zero runtime deps)
    index.ts           entry: dispatch, static SPA, /tempo passthrough, errors
    routes.ts          THE route table — the only way to expose a route
    surface.ts         composed table (discovery routes + data routes)
    params.ts          GET dialect + POST body → FilterState/TimeRange
    search.ts traces.ts tags.ts misc.ts   handlers
    discovery.ts openapi.ts docs.ts       /api/v1 index, openapi.json, llms.txt
    registry.ts        published schema set; problem.ts — RFC 9457 errors
skills/tracer-api/    Claude Code skill for querying a deployed tracer API
docker/               prod image: Dockerfile.web (bun runtime), bake, justfile
docker/demo/          demo stack: compose, tempo.yaml, loadgen/ (consensus-sim)
.github/workflows/    ci.yml (build) + docker.yml (multi-arch release on v* tags)
```

## Hard rules

- **Types live in `web/src/lib/model.ts`** (wire forms in `lib/wire.ts`).
  Import them; never redefine a shape. Components implement exactly the
  `*Props` in model.ts.
- **API responses are schema-bound.** Every route body has a JSON Schema in
  `lib/apischema.ts`; schemas and types are locked together by compile-time
  asserts. New/changed routes go through `server/routes.ts` (the table feeds
  dispatch, the discovery index, AND openapi.json) with summary, params, and
  a runnable example. Non-2xx responses are `application/problem+json`.
- **Colors come from `web/src/styles/tokens.css` only** — never hardcode. Canvas
  code reads resolved values via `getComputedStyle` (re-read on theme change).
  Instance colors are generated per service name (`colorIndexForService` →
  `instanceColorVar` → an `hsl()` hue at the theme's `--instance-sat`/
  `--instance-lum`); levels use `--level-{name}`.
- **No new runtime deps** beyond package.json / Cargo.toml without strong reason.
  No UI component libraries; no virtualization deps. The server has ZERO runtime
  deps (`json-schema-to-ts` is type-only).
- Co-locate `ComponentName.css`; prefix classes by component (`.fg-`, `.sp-`,
  `.tl-`, `.hm-`, …). Reuse `global.css` classes: `.btn(.btn-primary/-ghost/-sm)
  .input .label .chip .swatch .panel .panel-header .panel-title table.data
  .level-{level} .spinner .empty-state .mono-num .muted .faint`.
- Display all durations via `formatNs` — never ad-hoc `toFixed`.
- `lib/` is importable in isolation; components import from `lib/`, never from
  `App.tsx`; the server imports from `lib/` and `api/`, never the reverse. No
  circular imports.
- fetch errors throw `Error` with a human message incl. HTTP status; components
  surface error states — never blank screens.

## Design language (diffs.com / Pierre aesthetic)

Everything monospace (`var(--font-mono)`). Quiet neutral surfaces, crisp 1px
borders, no heavy shadows or gradients. Radii: 10px panels, 6px controls, pills
for chips. Dense rows. Micro-labels uppercase/letter-spaced/faint. Dark theme
default, light supported. Keep it beautiful and uncluttered — prefer a new tab
over packing more into one view.

## Motion & performance

Snappy first — interactions never block on rendering. The SPA talks only to
the API server (`/api/v1`); React Query is its only cache, and statistical
insights (stats, heatmap, merged-mode aggregation, flame layout) are computed
client-side from the hydrated TraceModel — instance toggling never hits the
network. Animate with `--speed`/`--ease` (transform/opacity only, never
layout); dropdowns fade + 4px rise (120ms), views cross-fade (150ms). Respect
`prefers-reduced-motion`. Long tables cap at ~2000 rows with a notice (no
virtualization). Canvas precomputes layout — no per-frame allocations; keep
60fps for ~10k spans.

## Tempo & deployment gotchas

- **The endpoint is set at deploy time via the `TEMPO_URL` env var** (host:port
  or full URL); the API server consumes it and fails fast if unset. There is no
  in-UI setting. The SPA calls the relative `/api/v1` base; `/tempo/*` remains
  a GET-only raw passthrough.
- The server's upstream Tempo budget is 12s, strictly under the SPA's 15s fetch
  timeout, so Tempo stalls surface as structured 504 problems — keep that
  ordering. `TEMPO_URL` is redacted from error bodies.
- The Tempo client must handle both old/new API shapes (`/api/v2/...` with
  `/api/...` fallbacks). Span/event times are `*UnixNano` **strings** — use
  BigInt for absolute times, beware precision; relative offsets fit in doubles.
  Ids are hex strings (accept base64 too).
- Three time units, never mixed: search ranges are unix **seconds**,
  `startUnixMs` anchors are epoch **milliseconds**, every `*Ns` field is
  **nanoseconds** relative to the trace start.
- Each node emits its OWN trace; a fetched trace is one node. Cross-node views
  are built by the compare route (`assembleFromQuery` + `assembleComparison`):
  it correlates the same span across separate traces by name + attribute and
  assembles one synthetic multi-instance trace (`Instance` identity:
  `service.name` + optional `#service.instance.id`; lanes share a time axis
  anchored at the earliest match so start skew is visible, ids instance-prefixed).
  `/compare/aggregate` is the cross-node code-path view. Do not make workloads
  share deterministic trace ids to force grouping; trace ids remain trace
  identity, while cross-node operation identity lives in span attributes.
- Tempo search returns an unordered subset — the windowed newest-first search
  in `TempoClient` is what makes "latest N" deterministic. Don't bypass it.

## Conventions for trace data (decoupled from the demo)

Insights/views derive purely from generic span data (name, timing, status,
level, instance) — never hardcode workload-specific span names like `round` or
`commit`. The `consensus-sim` loadgen is just a rich example emitter.
