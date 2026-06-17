/*
 * Agent-oriented docs: a compact llms.txt-style markdown guide. Route
 * one-liners render from ROUTES; the conventions and recipes are the prose
 * an agent needs to use the API well. Served at /api/v1/docs and
 * /.well-known/llms.txt.
 */

import type { RouteDef } from './router'

export const CONVENTIONS = {
  time:
    'THREE UNITS, never mixed: search ranges (`from`/`to`) are unix SECONDS; trace/span anchors (`startUnixMs`, `spanStartUnixMs`) are epoch MILLISECONDS; every `*Ns` field is NANOSECONDS — and span/event `startNs`/`timeNs` are RELATIVE to the trace `startUnixMs`, not absolute.',
  ids: 'Trace/span ids are lowercase hex in responses; hex or base64 are accepted on input.',
  instances:
    'An instance is one emitting process (one node). Identity = resource `service.name`, plus `#service.instance.id` when present (e.g. `node-2` or `api#worker-001`). Each node emits its OWN trace, so a fetched trace is one node; to view or aggregate the same span across nodes, use /compare and /compare/aggregate (correlate by span name + attribute).',
  dedup:
    'Spans are deduplicated by span id (first occurrence wins; a warning is recorded). Trace search rows are deduplicated by trace id, event search rows by span id + event name.',
  ordering:
    'Search results are a deterministic "latest N in range", sorted newest-first (Tempo itself returns an arbitrary subset; the server walks the range in windows to fix that). There is no pagination — to see further back, narrow or shift the range.',
  errors:
    'Every non-2xx response is RFC 9457 `application/problem+json`; validation problems carry `invalidParams` with per-field reasons and corrected examples.',
} as const

export function renderDocs(routes: readonly RouteDef[]): string {
  const routeLines = routes.map(
    (r) => `- \`${r.method} ${r.pattern}\` — ${r.summary}\n  - example: \`${r.example}\``,
  ).join('\n')

  return `# tracer API — agent guide

A REST middle layer over Grafana Tempo for traces emitted by many nodes
running the SAME system (e.g. a consensus cluster). Each node emits its own
trace; the server does the heavy lifting — TraceQL compilation, deterministic
newest-first search, OTLP parsing, span dedup, and correlating the same span
across nodes' separate traces by name + attribute (/compare) — and serves
compact, schema-stable JSON.

Start here:
- \`GET /api/v1\` — machine-readable index: every route, parameter, example.
- \`GET /api/v1/openapi.json\` — OpenAPI 3.1 with every schema (field
  descriptions include units).
- \`GET /api/v1/health\` — is Tempo reachable (200/503).

## Conventions

- **Time**: ${CONVENTIONS.time}
- **Ids**: ${CONVENTIONS.ids}
- **Instances**: ${CONVENTIONS.instances}
- **Dedup**: ${CONVENTIONS.dedup}
- **Ordering**: ${CONVENTIONS.ordering}
- **Errors**: ${CONVENTIONS.errors}

## Routes

${routeLines}

## Recipes

\`$BASE\` is the deployment origin, e.g. \`http://localhost:8080\` —
\`export BASE=http://localhost:8080\` and the commands below run as-is.

### Which node was slow on a given operation?

Each node runs the operation in its OWN trace, so correlate them by span name +
an attribute that pins the operation (e.g. a consensus view). /compare assembles
the lanes; /compare/aggregate gives the per-node stats per code path directly.

\`\`\`sh
# discover the span name + the attribute that identifies one operation
curl -s "$BASE/api/v1/tags/span/name/values?q=view"
# per-node code-path stats for that one operation, no spans downloaded:
curl -s "$BASE/api/v1/compare/aggregate?name=simplex.voter.view&nameRegex=false&attr=span.view%3D1612&since=1h"
#   -> on each node, perInstance[instanceId].meanNs reveals the straggler
# or the full assembled trace (one lane per node, aligned on the earliest start):
curl -s "$BASE/api/v1/compare?name=simplex.voter.view&nameRegex=false&attr=span.view%3D1612&since=1h"
\`\`\`

### Chase errors

\`\`\`sh
curl -s "$BASE/api/v1/search/traces?errorsOnly=true&since=1h&limit=10"
curl -s "$BASE/api/v1/search/events?level=error&since=1h"
# then download the offending node's trace (one trace = one node):
curl -s "$BASE/api/v1/traces/$TRACE_ID"
\`\`\`

### Build filters incrementally

\`\`\`sh
# discover the attribute space
curl -s "$BASE/api/v1/tags/span"
curl -s "$BASE/api/v1/tags/resource/service.name/values"
# compile WITHOUT executing to check a filter
curl -s "$BASE/api/v1/traceql/compile?attr=span.view%3D5&minDuration=100ms"
# then run it
curl -s "$BASE/api/v1/search/traces?attr=span.view%3D5&minDuration=100ms&since=1h"
\`\`\`

### Full trace, when rollups are not enough

\`\`\`sh
curl -s "$BASE/api/v1/traces/$TRACE_ID"
# spans[] is flat; tree shape = parentSpanId / childSpanIds; all *Ns times
# are relative to startUnixMs. Events ride on their owning span.
\`\`\`

Raw Tempo remains available read-only under \`/tempo/*\` (e.g.
\`/tempo/api/echo\`) as an escape hatch — prefer the typed routes above.
`
}
