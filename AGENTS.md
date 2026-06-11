# AGENTS.md

Agent guide for **tracer** — a scientific OTLP trace observatory. A static SPA
reads a Grafana Tempo instance and renders multi-instance flamegraphs: spans
from separate nodes executing the same protocol (e.g. a `commonware` consensus
cluster) overlaid on one trace, separated by bar color. **`DESIGN.md` is the
full spec & contracts — read it before changing parsers, the Tempo client,
TraceQL, or component props.**

## Commands

Web (`cd web`, bun is the package manager):

- `bun run dev` — Vite dev server (proxies `/tempo/*` → `localhost:3200`)
- `bun run check` — `tsc --noEmit` (the lint gate; no eslint configured)
- `bun test src` — unit tests (`bun:test`)
- `bun run build` — `tsc --noEmit && vite build`

CI (`.github/workflows/ci.yml`) runs check → test → build on push/PR. Run all
three locally before handing work back.

Docker / demo (`cd docker`, uses `just`):

- `just build` — build the prod web image (`tracer-web:local`)
- `just app <tempo-url>` — run the standalone viewer against a Tempo endpoint
- `just demo` / `just demo-down` / `just demo-logs` / `just clean` — the local
  demo stack (Tempo + 4 `consensus-sim` nodes + viewer) on http://localhost:8080

Loadgen: `cd docker/demo/loadgen && cargo check` (single binary crate
`consensus-sim`; must compile with zero errors/warnings).

Version control is **jujutsu (`jj`)**, not plain git. Make each logical change
its own revision (`jj new -m "…"`); the working copy is always a commit.

## Repository layout

```
web/                  TypeScript + React 19 + Vite SPA
  src/lib/model.ts    AUTHORITATIVE shared types — never redefine these shapes
  src/lib/format.ts   duration/time formatting + parsing helpers
  src/lib/trace.ts    OTLP JSON → TraceModel parser + aggregate flame tree
  src/lib/traceql.ts  FilterState → TraceQL compiler
  src/lib/range.ts    time-range presets + resolution
  src/api/tempo.ts    TempoClient (implements ITempoClient from model.ts)
  src/components/      SearchPanel, Combobox, TraceList, FlameGraph, SpanStats,
                       HeatMap, SpanDetails, EventsView, RangePicker, Select,
                       ExportModal, Calendar (each with a co-located .css)
  src/App.tsx          shell: routing, state (written last)
docker/               prod web image: Dockerfile.web, Caddyfile, bake, justfile
docker/demo/          demo stack: compose, tempo.yaml, loadgen/ (consensus-sim)
.github/workflows/    ci.yml (build) + docker.yml (multi-arch release on v* tags)
```

## Hard rules

- **Types live in `web/src/lib/model.ts`.** Import them; never redefine a shape.
  Components implement exactly the `*Props` in model.ts.
- **Colors come from `web/src/styles/tokens.css` only** — never hardcode. Canvas
  code reads resolved values via `getComputedStyle` (re-read on theme change).
  Instances use `--instance-0..11` (`instanceColorVar(colorIndex)`); levels use
  `--level-{name}`.
- **No new runtime deps** beyond package.json / Cargo.toml without strong reason.
  No UI component libraries; no virtualization deps.
- Co-locate `ComponentName.css`; prefix classes by component (`.fg-`, `.sp-`,
  `.tl-`, `.hm-`, …). Reuse `global.css` classes: `.btn(.btn-primary/-ghost/-sm)
  .input .label .chip .swatch .panel .panel-header .panel-title table.data
  .level-{level} .spinner .empty-state .mono-num .muted .faint`.
- Display all durations via `formatNs` — never ad-hoc `toFixed`.
- `lib/` is importable in isolation; components import from `lib/`, never from
  `App.tsx`. No circular imports.
- fetch errors throw `Error` with a human message incl. HTTP status; components
  surface error states — never blank screens.

## Design language (diffs.com / Pierre aesthetic)

Everything monospace (`var(--font-mono)`). Quiet neutral surfaces, crisp 1px
borders, no heavy shadows or gradients. Radii: 10px panels, 6px controls, pills
for chips. Dense rows. Micro-labels uppercase/letter-spaced/faint. Dark theme
default, light supported. Keep it beautiful and uncluttered — prefer a new tab
over packing more into one view.

## Motion & performance

Snappy first — interactions never block on rendering. No backend; the SPA only
talks to Tempo via the reverse-proxy path, React Query is the cache. Animate
with `--speed`/`--ease` (transform/opacity only, never layout); dropdowns fade
+ 4px rise (120ms), views cross-fade (150ms). Respect
`prefers-reduced-motion`. Long tables cap at ~2000 rows with a notice (no
virtualization). Canvas precomputes layout — no per-frame allocations; keep
60fps for ~10k spans.

## Tempo & deployment gotchas

- The viewer always calls the relative `/tempo` base. **The endpoint is set at
  deploy time via the `TEMPO_URL` env var** (Caddy reverse-proxies `/tempo/*`
  to it; the prod image fails fast if unset). There is no in-UI setting. Dev
  uses the Vite proxy to `localhost:3200`.
- The Tempo client must handle both old/new API shapes (`/api/v2/...` with
  `/api/...` fallbacks). Span/event times are `*UnixNano` **strings** — use
  BigInt for absolute times, beware precision; relative offsets fit in doubles.
  Ids are hex strings (accept base64 too). See `DESIGN.md` for exact shapes.
- Cross-node traces: every node shares a deterministic trace id per round, so
  one trace holds all nodes' spans; the parser splits them into `Instance`s.

## Conventions for trace data (decoupled from the demo)

Insights/views derive purely from generic span data (name, timing, status,
level, instance) — never hardcode workload-specific span names like `round` or
`commit`. The `consensus-sim` loadgen is just a rich example emitter.
