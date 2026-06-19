---
name: tracer-api
description: Query a deployed tracer instance (the REST middle layer over Grafana Tempo for distributed systems where each node emits its own trace) to find slow or failing nodes, compare one span across the cluster by name + attribute, drill into spans/events, and answer natural-language analytics asks ("mean/median per node over the last N rounds", "worst tail latency"). Use when the user asks about traces, spans, consensus-round timing, straggler/slow nodes, or errors in a system observed by tracer, or mentions a tracer/Tempo deployment URL.
---

# Querying the tracer API

tracer ingests nothing itself — it reads a Grafana Tempo instance and serves
a typed REST API for distributed systems where many nodes run the SAME system
and EACH node emits its OWN trace. To view or compare one logical operation
across nodes, correlate the matching span across their separate traces by span
name + an attribute that pins the operation (e.g. a consensus view) with
`/compare` and `/compare/aggregate`.

`$BASE` below is the deployment origin, e.g. `http://localhost:8080`.

## Self-discovery (when in doubt, start here)

- `GET $BASE/api/v1` — every route with parameters, schemas, runnable curl
  examples, and the conventions block. **The API is self-describing; this
  skill is just the fast path.**
- `GET $BASE/api/v1/openapi.json` — OpenAPI 3.1; `components.schemas` has
  every response shape with per-field units.
- `GET $BASE/api/v1/docs` — markdown guide with recipes.
- `GET $BASE/api/v1/health` — 200 = Tempo reachable, 503 = not.

## Conventions that will bite you

- **Three time units**: search `from`/`to` are unix SECONDS; `startUnixMs` /
  `spanStartUnixMs` are epoch MILLISECONDS; every `*Ns` field is NANOSECONDS,
  and span/event `startNs`/`timeNs` are RELATIVE to the trace's `startUnixMs`.
- **Instances**: `service.name` + optional `#service.instance.id`
  (`node-2`, `api#worker-001`). An instance = one node/process. A fetched trace
  is ONE node; cross-node views come from `/compare` (which assembles one lane
  per node).
- **Search is "latest N in range", newest-first, deterministic.** No
  pagination — narrow or shift the range (`since=15m`, `from`/`to`) to go
  deeper.
- Errors are RFC 9457 `application/problem+json`; on 400 read
  `invalidParams[*].reason`/`example` and fix your request.

## Workflow: find the slow / failing node on an operation

Each node runs the operation in its OWN trace, so correlate them by span name +
an attribute that pins ONE operation (e.g. a consensus height).

```sh
# 1. resolve the span name + the pinning attribute (don't guess names)
curl -s "$BASE/api/v1/tags/span/name/values?q=round"  # the span
curl -s "$BASE/api/v1/tags/span/height/values"        # values that pin one operation
# 2. per-node code-path stats for ONE operation — flat flame nodes, each with
#    path[] and perInstance[id] = {count,minNs,maxNs,meanNs,totalNs,errorCount}
curl -s "$BASE/api/v1/compare/aggregate?name=round&nameRegex=false&attr=span.height%3D42&since=1h"
# 3. the full assembled comparison (one lane per node, aligned on the earliest start):
curl -s "$BASE/api/v1/compare?name=round&nameRegex=false&attr=span.height%3D42&since=1h"
# 4. one node's own trace in full (one trace = one node):
curl -s "$BASE/api/v1/traces/$TRACE_ID"
```

`/compare/aggregate` answers "which node was slowest / erroring on which code
path" in a few KB; `perInstance[id].meanNs` reveals the straggler. `/summary`
gives one node's rollup before you download its full trace.

## Natural-language analytics asks

Most requests arrive in workload vocabulary, not API vocabulary — e.g.
*"fetch the latest 50 rounds; table of each instance's mean and median
duration over all of them; which node has the worst tail latency and how far
behind is it?"*. The pattern, every time:

**1. Resolve the user's words to a span name AND the attribute that pins one
operation.** Never assume "round" / "commit" / "height" is a literal span name —
discover both:

```sh
curl -s "$BASE/api/v1/tags/span/name/values?q=round"   # the span name
curl -s "$BASE/api/v1/tags/span"                        # candidate pinning attrs (height, role, …)
curl -s "$BASE/api/v1/tags/span/height/values"         # the operation ids to iterate
```

A broad recent search also reveals vocabulary: `rootTraceName` in
`/search/traces?since=15m&limit=5` rows is what the workload calls its
top-level operation, and `/compare/aggregate` `path[]`s name every phase.

**2. Enumerate the N operations.** Each operation is one value of the pinning
attribute (e.g. `height=42`). Get the recent values from
`/api/v1/tags/span/<attr>/values` (widen `since` if you need more); each value
is one operation to compare across nodes.

**3. Analyze with a script, not by eyeballing JSON.** Loop the operation values
through `/compare/aggregate?name=<span>&nameRegex=false&attr=span.<attr>=<value>`
(a few KB each; the server caches per-node parses, concurrent calls are fine).
Per-instance duration for one operation = `perInstance[id].maxNs` on the
depth-0 node. Then aggregate ACROSS operations: mean / median / p95 / max per
instance, deltas between an instance and the rest, error counts. Tail latency =
the high quantiles, not the mean — a node can hide a terrible p95 behind a
normal average.

**4. Report only the signal.** Lead with the direct answer to what was
asked, then one compact table. Flag what the user didn't ask for but needs:
outlier operations (e.g. >2× the median duration), nodes with `errorCount > 0`,
phases that only one node executed (`/compare/aggregate` rows whose `perInstance`
has a single key — timeouts/retries often look like this). Link the web UI
for every operation you call out. No raw JSON dumps.

## Compare across nodes (the cross-node primitive)

Cross-node analysis always goes through compare, because each node emits its own
trace. Both endpoints take the search dialect; give an exact `name`
(`nameRegex=false`) plus an `attr` that pins one operation, or there is nothing
to correlate on (400).

- `/compare` returns the SAME shape as `/traces/:id` (a multi-instance wire
  trace, one lane per node, aligned on the earliest match's start and
  id-prefixed) — analyze or render it exactly like a fetched trace.
- `/compare/aggregate` returns the merged flame: nodes per `path[]` with
  `perInstance[id]` duration/error stats (add `spanIds=true` for the matching
  span ids). Prefer it for "who is slow on which path" — a few KB, no spans.

The UI exposes this as the **Compare** button (shareable at
`$BASE/#/compare?...`).

## Other moves

- Events: `GET /api/v1/search/events?level=error&since=1h` (event-level
  matching; timing is span-level — Tempo doesn't expose event timestamps).
- Discover the attribute space before filtering:
  `GET /api/v1/tags/span`, `GET /api/v1/tags/resource/service.name/values`.
- Check a filter without running it:
  `GET /api/v1/traceql/compile?attr=span.height%3D42&minDuration=100ms`
  (returns the exact TraceQL a search would execute; search responses echo
  it under `query.traceql`).
- Structured POST bodies (`{"filter": {...}, "range": {"lastSeconds": 900}}`)
  are equivalent to the GET params — schema at
  `openapi.json#/components/schemas/searchRequestSchema`.
- Raw Tempo (read-only escape hatch): `$BASE/tempo/...` — prefer the typed
  routes.

## Reporting

When you mention a notable operation (a straggler round, an error spike, an
outlier), include its web UI link so a human can open it directly. For a
cross-node comparison, link the compare view:
`$BASE/#/compare?name=<span>&nameRegex=false&attr=span.height=<id>&since=1h` —
it shows per-node lanes, stats, and the heatmap for that operation. For a single
node, link its trace: `$BASE/#/trace/<traceId>`.

## Don'ts

- Don't fetch full traces to compute per-node timing — `/compare/aggregate`
  already did the cross-node join.
- Don't expect multiple nodes in one trace — each node emits its own; cross-node
  analysis goes through `/compare`.
- Don't mix the time units; don't pass milliseconds to `from`/`to`.
- Don't hardcode workload span names (`round`, `commit`, …) in reusable
  tooling — discover names via search results or `/compare/aggregate` paths.
