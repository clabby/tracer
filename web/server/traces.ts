/*
 * Trace handlers: the full wire trace, the pre-flight overview, and the
 * merged-aggregate view. Parsing is the shared lib (`parseTrace` via
 * TempoClient, `buildAggregateTree`); a small TTL cache absorbs the agent
 * pattern overview → aggregate → trace with a single Tempo fetch + parse,
 * inside the same 15s freshness window the Cache-Control header advertises.
 */

import type { TraceModel } from '../src/lib/model'
import { buildAggregateTree } from '../src/lib/trace'
import { flattenAggregate, serializeTrace, type WireTrace } from '../src/lib/wire'
import type { AggregateResponse, TraceOverview } from '../src/lib/apischema'
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

/**
 * Validate repeated `?instance=` params against the trace's instances.
 * Returns the selected ids (empty = all); throws a self-repairing 400 when
 * an id does not exist in this trace.
 */
function selectedInstances(url: URL, model: TraceModel): string[] {
  const requested = url.searchParams.getAll('instance').filter((s) => s !== '')
  if (requested.length === 0) return []
  const valid = new Set(model.instances.map((i) => i.id))
  const errors: InvalidParam[] = []
  for (const id of requested) {
    if (!valid.has(id)) {
      errors.push({
        name: 'instance',
        reason: `"${id}" is not an instance of this trace — valid: ${[...valid].join(', ')}`,
        example: model.instances[0]?.id,
      })
    }
  }
  if (errors.length > 0) throw badRequest('Unknown instance id(s).', errors)
  return requested
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

/**
 * Scope a wire trace to a subset of instances. Cross-instance links are
 * truly severed in BOTH directions: child links to excluded spans are
 * dropped, and kept spans whose parent left with another instance are
 * promoted to instance roots (parentSpanId nulled, depths recomputed) —
 * the same orphan handling the parser applies — so the tree encoding stays
 * a complete forest over the returned spans.
 */
export function scopeWireTrace(wire: WireTrace, instanceIds: string[]): WireTrace {
  if (instanceIds.length === 0) return wire
  const keepInstances = new Set(instanceIds)
  const keptSpanIds = new Set(
    wire.spans.filter((s) => keepInstances.has(s.instanceId)).map((s) => s.spanId),
  )

  const spans = wire.spans
    .filter((s) => keepInstances.has(s.instanceId))
    .map((s) => ({
      ...s,
      parentSpanId: s.parentSpanId !== null && keptSpanIds.has(s.parentSpanId) ? s.parentSpanId : null,
      childSpanIds: s.childSpanIds.filter((id) => keptSpanIds.has(id)),
    }))

  // Recompute depths from the (possibly promoted) roots.
  const byId = new Map(spans.map((s) => [s.spanId, s]))
  const queue = spans.filter((s) => s.parentSpanId === null)
  for (const r of queue) r.depth = 0
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]
    for (const id of n.childSpanIds) {
      const child = byId.get(id)
      if (child === undefined) continue
      child.depth = n.depth + 1
      queue.push(child)
    }
  }

  const instances = wire.instances
    .filter((i) => keepInstances.has(i.id))
    .map((i) => {
      const mine = spans.filter((s) => s.instanceId === i.id)
      const roots = mine.filter((s) => s.parentSpanId === null)
      // Parser contract: instance roots in start-time order.
      roots.sort((a, b) => a.startNs - b.startNs)
      return {
        ...i,
        rootSpanIds: roots.map((s) => s.spanId),
        maxDepth: mine.reduce((d, s) => Math.max(d, s.depth), 0),
      }
    })

  return { ...wire, instances, spans }
}

export async function handleTrace(
  _req: Request,
  url: URL,
  params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  rejectUnknownParams(url, ['instance'])
  const { model, at } = await loadTrace(params.traceId, deps)
  const selected = selectedInstances(url, model)
  const body: WireTrace = scopeWireTrace(serializeTrace(model), selected)
  return json(body, 200, cacheHeaders(at))
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

// -------------------------------------------------------------- aggregate --

export async function handleTraceAggregate(
  _req: Request,
  url: URL,
  params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  rejectUnknownParams(url, ['instance', 'spanIds'])
  const { model, at } = await loadTrace(params.traceId, deps)
  const selected = selectedInstances(url, model)

  const spanIdsRaw = url.searchParams.get('spanIds')
  if (spanIdsRaw !== null && spanIdsRaw !== 'true' && spanIdsRaw !== 'false') {
    throw badRequest('Invalid spanIds parameter.', [
      { name: 'spanIds', reason: `expected "true" or "false", got "${spanIdsRaw}"`, example: 'true' },
    ])
  }

  const included =
    selected.length === 0 ? model.instances.map((i) => i.id) : selected
  const keep = new Set(included)
  const hidden = new Set(model.instances.map((i) => i.id).filter((id) => !keep.has(id)))

  const body: AggregateResponse = {
    traceId: model.traceId,
    instances: included,
    nodes: flattenAggregate(buildAggregateTree(model, hidden), spanIdsRaw === 'true'),
  }
  return json(body, 200, cacheHeaders(at))
}
