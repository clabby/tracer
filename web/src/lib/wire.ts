/*
 * Wire format — the JSON-safe encoding of `TraceModel` served by the REST
 * API. `serializeTrace` flattens the parsed model (object references become
 * id lists, the spans Map becomes an array); `hydrateTrace` rebuilds an
 * identical `TraceModel` on the client. Pure functions, no side effects.
 *
 * Invariants the encoding preserves exactly:
 * - span iteration order (the parser's encounter order),
 * - sibling order (`childSpanIds` is the parser's startNs-sorted order),
 * - root order per instance, and the globally time-sorted events list.
 */

import type { Instance, SpanNode, TraceModel } from './model'

/** A span without object references: children become an id list. */
export type WireSpan = Omit<SpanNode, 'children'> & {
  /** Ids of child spans, in the parser's sibling order (startNs ascending). */
  childSpanIds: string[]
}

/** An instance with `rootSpans` flattened to ids, plus summary rollups. */
export type WireInstance = Omit<Instance, 'rootSpans'> & {
  /** Ids of this instance's root spans, in display (startNs) order. */
  rootSpanIds: string[]
  /** Number of spans in this instance with status `error`. */
  errorCount: number
  /** Earliest span start in this instance, ns relative to trace start. */
  earliestStartNs: number
  /** Latest span end in this instance, ns relative to trace start. */
  latestEndNs: number
}

/** JSON-safe `TraceModel`: see `serializeTrace` / `hydrateTrace`. */
export interface WireTrace {
  traceId: string
  /** Epoch milliseconds of the earliest span start. */
  startUnixMs: number
  /** Extent from earliest start to latest end, nanoseconds. */
  durationNs: number
  instances: WireInstance[]
  /** Every span, in parser encounter order. Events ride on their span. */
  spans: WireSpan[]
  /** Non-fatal parse anomalies (orphan spans, missing times, ...). */
  warnings: string[]
}

/** Flatten a parsed `TraceModel` into its wire form. */
export function serializeTrace(model: TraceModel): WireTrace {
  const spans: WireSpan[] = []
  for (const node of model.spans.values()) {
    const { children, ...rest } = node
    spans.push({ ...rest, childSpanIds: children.map((c) => c.spanId) })
  }

  // Per-instance rollups in one pass over all spans.
  const rollups = new Map<
    string,
    { errorCount: number; earliestStartNs: number; latestEndNs: number }
  >()
  for (const node of model.spans.values()) {
    let r = rollups.get(node.instanceId)
    if (r === undefined) {
      r = { errorCount: 0, earliestStartNs: Infinity, latestEndNs: -Infinity }
      rollups.set(node.instanceId, r)
    }
    if (node.status === 'error') r.errorCount++
    if (node.startNs < r.earliestStartNs) r.earliestStartNs = node.startNs
    const endNs = node.startNs + node.durationNs
    if (endNs > r.latestEndNs) r.latestEndNs = endNs
  }

  const instances: WireInstance[] = model.instances.map((inst) => {
    const { rootSpans, ...rest } = inst
    const r = rollups.get(inst.id) ?? { errorCount: 0, earliestStartNs: 0, latestEndNs: 0 }
    return {
      ...rest,
      rootSpanIds: rootSpans.map((s) => s.spanId),
      errorCount: r.errorCount,
      earliestStartNs: Number.isFinite(r.earliestStartNs) ? r.earliestStartNs : 0,
      latestEndNs: Number.isFinite(r.latestEndNs) ? r.latestEndNs : 0,
    }
  })

  return {
    traceId: model.traceId,
    startUnixMs: model.startUnixMs,
    durationNs: model.durationNs,
    instances,
    spans,
    warnings: [...model.warnings],
  }
}

/** Rebuild a `TraceModel` from its wire form. Inverse of `serializeTrace`. */
export function hydrateTrace(wire: WireTrace): TraceModel {
  const spans = new Map<string, SpanNode>()
  for (const w of wire.spans) {
    const { childSpanIds: _omit, ...rest } = w
    spans.set(w.spanId, { ...rest, children: [] })
  }

  // Link children in wire order, which is the parser's sibling order.
  for (const w of wire.spans) {
    const node = spans.get(w.spanId)
    if (node === undefined) continue
    for (const id of w.childSpanIds) {
      const child = spans.get(id)
      if (child !== undefined) node.children.push(child)
    }
  }

  const instances: Instance[] = wire.instances.map((wi) => {
    const { rootSpanIds, errorCount: _e, earliestStartNs: _s, latestEndNs: _l, ...rest } = wi
    return {
      ...rest,
      rootSpans: rootSpanIds
        .map((id) => spans.get(id))
        .filter((s): s is SpanNode => s !== undefined),
    }
  })

  // Rebuild the global events list: concatenation in span (encounter) order
  // followed by a stable sort reproduces the parser's output exactly.
  const events = [...spans.values()].flatMap((s) => s.events)
  events.sort((a, b) => a.timeNs - b.timeNs)

  return {
    traceId: wire.traceId,
    startUnixMs: wire.startUnixMs,
    durationNs: wire.durationNs,
    instances,
    spans,
    events,
    warnings: [...wire.warnings],
  }
}
