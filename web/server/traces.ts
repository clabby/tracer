/*
 * Trace handlers: one node's full trace and its pre-flight overview, plus the
 * cross-node comparison (and its merged aggregate) assembled from separate
 * per-node traces by `assembleComparison`. Parsing is the shared lib
 * (`parseTrace` via TempoClient); a small TTL cache absorbs repeat fetches
 * (overview -> trace, and the per-node fetches a comparison makes) with a
 * single Tempo fetch + parse inside the 15s window the Cache-Control advertises.
 */

import type { FilterState, SpanMatch, TimeRange, TraceModel } from '../src/lib/model'
import { assembleComparison, buildAggregateTree } from '../src/lib/trace'
import { flattenAggregate, serializeTrace } from '../src/lib/wire'
import type { AggregateResponse, TraceOverview } from '../src/lib/apischema'
import { parseSearchQuery } from './params'
import { badRequest, type InvalidParam } from './problem'
import { json, type Deps } from './router'

const CACHE_TTL_MS = 15_000
const CACHE_MAX = 16

const cache = new Map<string, { model: TraceModel; at: number }>()

async function loadTrace(rawId: string, deps: Deps): Promise<{ model: TraceModel; at: number }> {
  const traceId = rawId.toLowerCase()
  const hit = cache.get(traceId)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit
  const entry = { model: await deps.tempo.fetchTrace(traceId), at: Date.now() }
  cache.delete(traceId)
  cache.set(traceId, entry)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return entry
}

/**
 * `max-age=15` plus an honest Age header — without it, a response served
 * from a 14s-old cache entry would restart the browser's 15s freshness
 * window and stack total staleness to ~30s.
 */
function cacheHeaders(at: number): Record<string, string> {
  return {
    'cache-control': 'public, max-age=15',
    age: String(Math.max(0, Math.floor((Date.now() - at) / 1000))),
  }
}

/** Visible for tests: drop cached parses. */
export function clearTraceCache(): void {
  cache.clear()
}

/** Reject query params other than the listed ones (typos fail loudly). */
function rejectUnknownParams(url: URL, known: readonly string[]): void {
  const errors: InvalidParam[] = []
  for (const key of new Set(url.searchParams.keys())) {
    if (!known.includes(key)) {
      errors.push({ name: key, reason: `unknown parameter — known: ${known.join(', ') || '(none)'}` })
    }
  }
  if (errors.length > 0) throw badRequest('One or more query parameters are invalid.', errors)
}

// ------------------------------------------------------------------ trace --

export async function handleTrace(
  _req: Request,
  url: URL,
  params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  rejectUnknownParams(url, [])
  const { model, at } = await loadTrace(params.traceId, deps)
  return json(serializeTrace(model), 200, cacheHeaders(at))
}

// ---------------------------------------------------------------- summary --

export async function handleTraceSummary(
  _req: Request,
  url: URL,
  params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  rejectUnknownParams(url, [])
  const { model, at } = await loadTrace(params.traceId, deps)
  const wire = serializeTrace(model)
  const body: TraceOverview = {
    traceId: wire.traceId,
    startUnixMs: wire.startUnixMs,
    durationNs: wire.durationNs,
    spanCount: model.spans.size,
    eventCount: model.events.length,
    instances: wire.instances,
    warnings: wire.warnings,
  }
  return json(body, 200, cacheHeaders(at))
}

// ---------------------------------------------------------------- compare --

/** Synthetic trace id for an assembled comparison (it is not a real trace). */
const COMPARE_TRACE_ID = 'compare'

/** A comparison needs one span kind to correlate on; reject an empty target. */
function requireCorrelator(filter: FilterState): void {
  if (filter.name.trim() === '' && filter.rawQuery.trim() === '') {
    throw badRequest('A comparison needs a span to correlate on.', [
      {
        name: 'name',
        reason:
          'give an exact span name (add an `attr` to pin the operation, e.g. attr=span.view=1612) or a raw `q`',
        example: 'simplex.voter.view',
      },
    ])
  }
}

/**
 * Locate the span matching the search filter (a span name plus an attribute) in
 * each node's own trace and assemble every match's subtree into one synthetic
 * multi-instance trace: lanes share a time axis anchored at the earliest match,
 * span ids instance-prefixed. Per-trace fetch failures become warnings rather
 * than failing the request.
 */
async function assembleFromQuery(
  filter: FilterState,
  range: TimeRange,
  deps: Deps,
): Promise<TraceModel> {
  const targets = (await deps.tempo.searchTraces(filter, range)).filter(
    (s) => s.matchedSpanIds.length > 0,
  )
  const loaded = await Promise.all(
    targets.map((s) =>
      loadTrace(s.traceId, deps)
        .then(({ model }) => ({ s, model }))
        .catch((err) => ({ s, err: err instanceof Error ? err.message : String(err) })),
    ),
  )

  const matches: SpanMatch[] = []
  const warnings: string[] = []
  const usedIds = new Set<string>()
  for (const entry of loaded) {
    if ('err' in entry) {
      warnings.push(`trace ${entry.s.traceId}: ${entry.err}`)
      continue
    }
    const byInstance = new Map(entry.model.instances.map((i) => [i.id, i]))
    for (const spanId of entry.s.matchedSpanIds) {
      const root = entry.model.spans.get(spanId)
      if (root === undefined) continue
      const instance = byInstance.get(root.instanceId)
      if (instance === undefined) continue
      let id = instance.id
      if (usedIds.has(id)) id = `${instance.id}#${entry.s.traceId.slice(0, 6)}`
      if (usedIds.has(id)) id = `${instance.id}#${root.spanId.slice(0, 8)}`
      usedIds.add(id)
      matches.push({ instance: { ...instance, id }, root, startUnixMs: entry.model.startUnixMs })
    }
  }

  const model = assembleComparison(matches, COMPARE_TRACE_ID)
  model.warnings.push(...warnings)
  if (matches.length === 0) {
    const what = filter.name.trim() !== '' ? `name "${filter.name.trim()}"` : 'the query'
    model.warnings.push(`no spans matched ${what} with these filters in this range`)
  }
  return model
}

/**
 * Compare one span across nodes whose traces are SEPARATE. Returns the same
 * `WireTrace` shape as GET /traces/:id (one lane per node, aligned on the
 * earliest match's start), so the flame/stats/heatmap views render it directly.
 */
export async function handleCompare(
  _req: Request,
  url: URL,
  _params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  const { filter, range } = parseSearchQuery(url)
  requireCorrelator(filter)
  const model = await assembleFromQuery(filter, range, deps)
  return json(serializeTrace(model), 200)
}

/**
 * The merged aggregate of a comparison: the assembled multi-instance trace
 * grouped by name-path, with per-instance duration/error stats for every node
 * at each path. Compact cross-node code-path stats without downloading spans.
 */
export async function handleCompareAggregate(
  _req: Request,
  url: URL,
  _params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  const { filter, range } = parseSearchQuery(url, ['spanIds'])
  requireCorrelator(filter)
  const spanIdsRaw = url.searchParams.get('spanIds')
  if (spanIdsRaw !== null && spanIdsRaw !== 'true' && spanIdsRaw !== 'false') {
    throw badRequest('Invalid spanIds parameter.', [
      { name: 'spanIds', reason: `expected "true" or "false", got "${spanIdsRaw}"`, example: 'true' },
    ])
  }
  const model = await assembleFromQuery(filter, range, deps)
  const body: AggregateResponse = {
    traceId: model.traceId,
    instances: model.instances.map((i) => i.id),
    nodes: flattenAggregate(buildAggregateTree(model, new Set()), spanIdsRaw === 'true'),
  }
  return json(body, 200)
}
