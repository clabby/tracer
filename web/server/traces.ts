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
const CACHE_CONTROL = { 'cache-control': 'public, max-age=15' }

const cache = new Map<string, { model: TraceModel; at: number }>()

async function loadTrace(rawId: string, deps: Deps): Promise<TraceModel> {
  const traceId = rawId.toLowerCase()
  const hit = cache.get(traceId)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.model
  const model = await deps.tempo.fetchTrace(traceId)
  cache.delete(traceId)
  cache.set(traceId, { model, at: Date.now() })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return model
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

/** Scope a wire trace to a subset of instances, severing cross-links. */
export function scopeWireTrace(wire: WireTrace, instanceIds: string[]): WireTrace {
  if (instanceIds.length === 0) return wire
  const keepInstances = new Set(instanceIds)
  const instances = wire.instances.filter((i) => keepInstances.has(i.id))
  const spans = wire.spans.filter((s) => keepInstances.has(s.instanceId))
  const keptSpanIds = new Set(spans.map((s) => s.spanId))
  return {
    ...wire,
    instances,
    spans: spans.map((s) => ({
      ...s,
      childSpanIds: s.childSpanIds.filter((id) => keptSpanIds.has(id)),
    })),
  }
}

export async function handleTrace(
  _req: Request,
  url: URL,
  params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  rejectUnknownParams(url, ['instance'])
  const model = await loadTrace(params.traceId, deps)
  const selected = selectedInstances(url, model)
  const body: WireTrace = scopeWireTrace(serializeTrace(model), selected)
  return json(body, 200, CACHE_CONTROL)
}

// ---------------------------------------------------------------- summary --

export async function handleTraceSummary(
  _req: Request,
  url: URL,
  params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  rejectUnknownParams(url, [])
  const model = await loadTrace(params.traceId, deps)
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
  return json(body, 200, CACHE_CONTROL)
}

// -------------------------------------------------------------- aggregate --

export async function handleTraceAggregate(
  _req: Request,
  url: URL,
  params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  rejectUnknownParams(url, ['instance', 'spanIds'])
  const model = await loadTrace(params.traceId, deps)
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
  return json(body, 200, CACHE_CONTROL)
}
