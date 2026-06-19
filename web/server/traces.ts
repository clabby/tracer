/*
 * Trace handlers: one node's full trace and its pre-flight overview, plus the
 * cross-node comparison (and its merged aggregate) assembled from separate
 * per-node traces by `assembleComparison`. Parsing is the shared lib
 * (`parseTrace` via TempoClient); a small TTL cache absorbs repeat fetches
 * (overview -> trace, and the per-node fetches a comparison makes) with a
 * single Tempo fetch + parse inside the 15s window the Cache-Control advertises.
 */

import {
  hasComparePinningAttr,
  type FilterState,
  type SearchTarget,
  type SpanMatch,
  type TimeRange,
  type TraceModel,
} from '../src/lib/model'
import { assembleComparison, buildAggregateTree } from '../src/lib/trace'
import { flattenAggregate, serializeTrace } from '../src/lib/wire'
import type { AggregateResponse, TraceOverview } from '../src/lib/apischema'
import { MAX_LIMIT, parseSearchQuery } from './params'
import { badRequest, type InvalidParam } from './problem'
import { json, type Deps } from './router'

const CACHE_TTL_MS = 15_000
const CACHE_MAX = 16
/** Max per-node trace fetches a comparison runs at once (keeps Tempo healthy). */
const CONCURRENT_TRACE_FETCHES = 16

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

function hasEventComparePinningAttr(filter: FilterState): boolean {
  return filter.attrs.some((a) => {
    if (a.scope === 'resource') return false
    if (a.op !== '=') return false
    if (a.key.trim() === '') return false
    return a.value.trim() !== ''
  })
}

function parseCompareTarget(url: URL): SearchTarget {
  return url.searchParams.get('target') === 'events' ? 'events' : 'spans'
}

/** A comparison needs one operation to correlate on; reject an empty target. */
function requireCorrelator(filter: FilterState, target: SearchTarget): void {
  const errors: InvalidParam[] = []
  if (filter.rawQuery.trim() !== '') {
    errors.push({
      name: 'q',
      reason: 'raw TraceQL cannot prove one operation; use exact name plus an exact span attr',
      example: 'name=round&nameRegex=false&attr=span.height=42',
    })
  }
  if (filter.name.trim() === '') {
    errors.push({
      name: 'name',
      reason: 'required; compare needs the exact span name to correlate',
      example: 'round',
    })
  } else if (filter.nameIsRegex) {
    errors.push({
      name: 'nameRegex',
      reason: 'must be false; regex names can match multiple operations',
      example: 'false',
    })
  }
  const hasPinningAttr =
    target === 'events' ? hasEventComparePinningAttr(filter) : hasComparePinningAttr(filter)
  if (!hasPinningAttr) {
    errors.push({
      name: 'attr',
      reason: target === 'events'
        ? 'add one exact span or event attribute that pins the operation'
        : 'add one exact span attribute that pins the operation',
      example: 'span.height=42',
    })
  }
  if (errors.length > 0) {
    throw badRequest('A comparison needs an exact span name plus a pinning span attribute.', errors)
  }
}

/** One node's contribution: its trace id and the matched span id(s) within it. */
interface CompareTarget {
  traceId: string
  spanIds: string[]
}

/**
 * Bounded-concurrency fetch+parse of each node's own trace. A large comparison
 * can match hundreds of traces; firing every fetch at once would stampede Tempo
 * and time fetches out (dropping nodes), so at most `CONCURRENT_TRACE_FETCHES`
 * run in flight. Per-trace failures become warnings, never a failed request.
 */
async function loadTargets(
  targets: CompareTarget[],
  deps: Deps,
): Promise<Array<{ t: CompareTarget; model: TraceModel } | { t: CompareTarget; err: string }>> {
  const out = new Array<{ t: CompareTarget; model: TraceModel } | { t: CompareTarget; err: string }>(
    targets.length,
  )
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < targets.length; i = next++) {
      const t = targets[i]
      out[i] = await loadTrace(t.traceId, deps)
        .then(({ model }) => ({ t, model }))
        .catch((err) => ({ t, err: err instanceof Error ? err.message : String(err) }))
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENT_TRACE_FETCHES, targets.length) }, worker),
  )
  return out
}

/**
 * Locate the matched span in each node's own trace and assemble every match's
 * subtree into one synthetic multi-instance trace: lanes share a time axis
 * anchored at the earliest match, span ids instance-prefixed. `noun`/`name`
 * shape the "nothing matched" warning.
 */
async function assembleTargets(
  targets: CompareTarget[],
  noun: string,
  name: string,
  deps: Deps,
): Promise<TraceModel> {
  const loaded = await loadTargets(targets, deps)
  const matches: SpanMatch[] = []
  const warnings: string[] = []
  for (const entry of loaded) {
    if ('err' in entry) {
      warnings.push(`trace ${entry.t.traceId}: ${entry.err}`)
      continue
    }
    const roots = [...new Set(entry.t.spanIds)].flatMap((spanId) => {
      const root = entry.model.spans.get(spanId)
      return root === undefined ? [] : [root]
    })
    if (roots.length > 1) {
      warnings.push(
        `trace ${entry.t.traceId}: ${roots.length} spans matched; compare correlates one matching span per node trace, so this trace was skipped.`,
      )
      continue
    }
    const root = roots[0]
    if (root === undefined) continue
    // Keep the real provider id; assembleComparison groups same-provider matches
    // into one lane (a node leading many rounds → a single node lane).
    const instance = entry.model.instances.find((i) => i.id === root.instanceId)
    if (instance === undefined) continue
    matches.push({ instance, root, startUnixMs: entry.model.startUnixMs })
  }

  const model = assembleComparison(matches, COMPARE_TRACE_ID)
  model.warnings.push(...warnings)
  if (model.instances.length === 0) {
    model.warnings.push(`no ${noun} matched name "${name}" with these filters in this range`)
  }
  return model
}

/**
 * The search caps at MAX_LIMIT rows; hitting it means there are more matches in
 * the range than one comparison can hold. Surface that as a warning so the
 * comparison never *silently* drops nodes — the caller narrows the range to see
 * the rest.
 */
function warnIfTruncated(model: TraceModel, matched: number, noun: string): void {
  if (matched >= MAX_LIMIT) {
    model.warnings.push(
      `more than ${MAX_LIMIT} ${noun} matched; comparison shows the newest ${MAX_LIMIT} — narrow the time range to include the rest`,
    )
  }
}

/** Compare a span across nodes: locate it per node trace, then assemble. */
async function assembleFromQuery(filter: FilterState, range: TimeRange, deps: Deps): Promise<TraceModel> {
  const rows = await deps.tempo.searchTraces({ ...filter, limit: MAX_LIMIT }, range)
  const model = await assembleTargets(
    rows
      .filter((s) => s.matchedSpanIds.length > 0)
      .map((s) => ({ traceId: s.traceId, spanIds: s.matchedSpanIds })),
    'spans',
    filter.name.trim(),
    deps,
  )
  warnIfTruncated(model, rows.length, 'traces')
  return model
}

/** Compare an event across nodes by assembling the spans that own each match. */
async function assembleFromEvents(filter: FilterState, range: TimeRange, deps: Deps): Promise<TraceModel> {
  const events = await deps.tempo.searchEvents({ ...filter, limit: MAX_LIMIT }, range)
  const model = await assembleTargets(
    events.map((e) => ({ traceId: e.traceId, spanIds: [e.spanId] })),
    'events',
    filter.name.trim(),
    deps,
  )
  warnIfTruncated(model, events.length, 'events')
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
  const target = parseCompareTarget(url)
  const { filter, range } = parseSearchQuery(url, ['target'])
  requireCorrelator(filter, target)
  const model = target === 'events'
    ? await assembleFromEvents(filter, range, deps)
    : await assembleFromQuery(filter, range, deps)
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
  requireCorrelator(filter, 'spans')
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
