---
name: tracer-api
description: Query a deployed tracer instance (the REST middle layer over Grafana Tempo for multi-instance traces) to find slow or failing nodes, compare code paths across a cluster, drill into spans/events, and answer natural-language analytics asks ("mean/median per node over the last N rounds", "worst tail latency"). Use when the user asks about traces, spans, consensus-round timing, straggler/slow nodes, or errors in a system observed by tracer, or mentions a tracer/Tempo deployment URL.
---

# Querying the tracer API

tracer ingests nothing itself — it reads a Grafana Tempo instance and serves
a typed REST API for traces emitted by many nodes running the SAME system
(one trace id per logical operation, e.g. a consensus round; every node's
spans live in that one trace, deduplicated and split per instance).

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
  (`node-2`, `api#worker-001`). An instance = one node/process.
- **Search is "latest N in range", newest-first, deterministic.** No
  pagination — narrow or shift the range (`since=15m`, `from`/`to`) to go
  deeper.
- Errors are RFC 9457 `application/problem+json`; on 400 read
  `invalidParams[*].reason`/`example` and fix your request.

## Workflow: find the slow / failing node

```sh
# 1. recent traces (add errorsOnly=true, service=, name=, attr=… to narrow)
curl -s "$BASE/api/v1/search/traces?since=15m&limit=5"
# 2. pre-flight ONE trace — small payload, per-instance rollups:
#    spanCount, errorCount, earliestStartNs/latestEndNs (who started late /
#    finished last)
curl -s "$BASE/api/v1/traces/$TRACE_ID/summary"
# 3. compare the same code path across nodes — flat flame nodes, each with
#    path[] and perInstance[id] = {count,minNs,maxNs,meanNs,totalNs,errorCount}
curl -s "$BASE/api/v1/traces/$TRACE_ID/aggregate"
# 4. only if rollups aren't enough — full spans (flat list; tree shape via
#    parentSpanId/childSpanIds; events ride on their span). Scope it:
curl -s "$BASE/api/v1/traces/$TRACE_ID?instance=node-2"
```

Prefer `/summary` and `/aggregate` over the full trace — they answer
"which node was slowest / erroring on which code path" in a few KB.

## Natural-language analytics asks

Most requests arrive in workload vocabulary, not API vocabulary — e.g.
*"fetch the latest 50 rounds; table of each instance's mean and median
duration over all of them; which node has the worst tail latency and how far
behind is it?"*. The pattern, every time:

**1. Resolve the user's words to real span names.** Never assume "round" /
"commit" / "block" is a literal span name — discover it:

```sh
curl -s "$BASE/api/v1/tags/span/name/values?q=round"   # substring match
curl -s "$BASE/api/v1/tags/span/name/values"           # no hit? list all, pick the closest
```

A broad recent search also reveals vocabulary: `rootTraceName` in
`/search/traces?since=15m&limit=5` rows is what the workload calls its
top-level operation, and `/aggregate` `path[]`s name every phase.

**2. Fetch the N matching operations.**
`/search/traces?name=<resolved>&nameRegex=false&since=15m&limit=50`.
If fewer rows than asked for come back, widen the range (`since=1h`, `24h`,
…) and retry — results are "latest N in range", so a too-narrow window is
the only reason to come up short.

**3. Analyze with a script, not by eyeballing JSON.** Loop the trace ids
through `/aggregate` (a few KB each; the server caches parses, concurrent
fetches are fine) and compute in the script. Per-instance duration for one
operation = `perInstance[id].maxNs` on the depth-0 node. Then aggregate
ACROSS operations: mean / median / p95 / max per instance, deltas between an
instance and the rest, error counts. Tail latency = the high quantiles, not
the mean — a node can hide a terrible p95 behind a normal average.

**4. Report only the signal.** Lead with the direct answer to what was
asked, then one compact table. Flag what the user didn't ask for but needs:
outlier operations (e.g. >2× the median duration), nodes with `errorCount > 0`,
phases that only one node executed (`/aggregate` rows whose `perInstance`
has a single key — timeouts/retries often look like this). Link the web UI
for every trace you call out. No raw JSON dumps.

## Other moves

- Events: `GET /api/v1/search/events?level=error&since=1h` (event-level
  matching; timing is span-level — Tempo doesn't expose event timestamps).
- Discover the attribute space before filtering:
  `GET /api/v1/tags/span`, `GET /api/v1/tags/resource/service.name/values`.
- Check a filter without running it:
  `GET /api/v1/traceql/compile?attr=span.view%3D5&minDuration=100ms`
  (returns the exact TraceQL a search would execute; search responses echo
  it under `query.traceql`).
- Structured POST bodies (`{"filter": {...}, "range": {"lastSeconds": 900}}`)
  are equivalent to the GET params — schema at
  `openapi.json#/components/schemas/searchRequestSchema`.
- Raw Tempo (read-only escape hatch): `$BASE/tempo/...` — prefer the typed
  routes.

## Reporting

When you mention a notable trace (a straggler round, an error spike, an
outlier), include its web UI link so a human can open it directly:
`$BASE/#/trace/<traceId>`, e.g.
`http://localhost:8080/#/trace/85765a68a1554a3106bd2742cc56db2e`.
The flamegraph there shows per-node lanes, the merged flame, stats, and the
heatmap for exactly the trace you analyzed.

## Don'ts

- Don't fetch full traces to compute per-node timing — `/aggregate` already
  did the cross-instance join.
- Don't mix the time units; don't pass milliseconds to `from`/`to`.
- Don't hardcode workload span names (`round`, `commit`, …) in reusable
  tooling — discover names via search results or `/aggregate` paths.
