/*
 * OTLP trace parser + aggregate flame tree builder.
 *
 * `parseTrace` turns raw OTLP JSON (any of the Tempo envelope shapes) into the
 * shared `TraceModel`; `buildAggregateTree` merges spans across instances by
 * path for the merged flame mode. Pure functions, no side effects.
 */

import {
  colorIndexForService,
  levelFromAttributes,
  type AggregateNode,
  type AttrPrimitive,
  type Attributes,
  type Instance,
  type Level,
  type SpanEvent,
  type SpanKind,
  type SpanMatch,
  type SpanNode,
  type SpanStatus,
  type TraceModel,
} from './model'

// -------------------------------------------------------------------- ids --

const HEX_RE = /^[0-9a-fA-F]+$/
const ALL_ZERO_RE = /^0+$/

/**
 * Normalize an OTLP id to lowercase hex. Tempo emits hex strings; raw OTLP
 * JSON uses base64 — accept both. All-zero / missing ids return null.
 */
function idToHex(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (HEX_RE.test(raw)) {
    const hex = raw.toLowerCase()
    return ALL_ZERO_RE.test(hex) ? null : hex
  }
  try {
    const bin = atob(raw)
    let hex = ''
    for (let i = 0; i < bin.length; i++) {
      hex += bin.charCodeAt(i).toString(16).padStart(2, '0')
    }
    return hex.length === 0 || ALL_ZERO_RE.test(hex) ? null : hex
  } catch {
    return null
  }
}

// ------------------------------------------------------------- attributes --

/** Flatten one OTLP AnyValue object to an `AttrPrimitive` (or null). */
function flattenAttrValue(v: unknown): AttrPrimitive | null {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (v === null || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.stringValue === 'string') return o.stringValue
  if (o.intValue !== undefined && o.intValue !== null) {
    // intValue arrives as a string in OTLP JSON; keep the string form when the
    // value does not fit a double exactly.
    const n = Number(o.intValue)
    return Number.isSafeInteger(n) ? n : String(o.intValue)
  }
  if (o.doubleValue !== undefined && o.doubleValue !== null) {
    const n = Number(o.doubleValue)
    return Number.isFinite(n) ? n : String(o.doubleValue)
  }
  if (typeof o.boolValue === 'boolean') return o.boolValue
  if (o.arrayValue !== undefined && o.arrayValue !== null && typeof o.arrayValue === 'object') {
    const vals = (o.arrayValue as Record<string, unknown>).values
    const flat = Array.isArray(vals) ? vals.map((x) => flattenAttrValue(x)) : []
    return JSON.stringify(flat)
  }
  if (o.kvlistValue !== undefined && o.kvlistValue !== null) return JSON.stringify(o.kvlistValue)
  if (typeof o.bytesValue === 'string') return o.bytesValue
  return null
}

/** Parse an OTLP attribute list (`[{key, value}]`) into flat `Attributes`. */
export function parseAttributes(raw: unknown): Attributes {
  const out: Attributes = {}
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const { key, value } = entry as Record<string, unknown>
    if (typeof key !== 'string' || key.length === 0) continue
    const flat = flattenAttrValue(value)
    if (flat !== null) out[key] = flat
  }
  return out
}

// ------------------------------------------------------------------- time --

/** Parse an OTLP unixnano (string in JSON, sometimes number) to bigint. */
function toNanos(raw: unknown): bigint | null {
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw)
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return BigInt(Math.round(raw))
  if (typeof raw === 'bigint' && raw >= 0n) return raw
  return null
}

// ------------------------------------------------------------ kind/status --

const KIND_BY_NUM: readonly SpanKind[] = [
  'unspecified',
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
]

function parseKind(raw: unknown): SpanKind {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 5) {
    return KIND_BY_NUM[raw]
  }
  if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) return parseKind(Number(raw))
    const name = raw.toLowerCase().replace(/^span_kind_/, '')
    if ((KIND_BY_NUM as readonly string[]).includes(name)) return name as SpanKind
  }
  return 'unspecified'
}

function parseStatus(raw: unknown): { status: SpanStatus; message: string } {
  if (raw === null || typeof raw !== 'object') return { status: 'unset', message: '' }
  const o = raw as Record<string, unknown>
  const code = o.code
  let status: SpanStatus = 'unset'
  if (code === 2 || code === '2' || code === 'STATUS_CODE_ERROR') status = 'error'
  else if (code === 1 || code === '1' || code === 'STATUS_CODE_OK') status = 'ok'
  return { status, message: typeof o.message === 'string' ? o.message : '' }
}

// ----------------------------------------------------------- natural sort --

function isDigitCode(c: number): boolean {
  return c >= 48 && c <= 57
}

/** Natural string compare: node-2 < node-10. */
function naturalCompare(a: string, b: string): number {
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const ca = a.charCodeAt(i)
    const cb = b.charCodeAt(j)
    const da = isDigitCode(ca)
    const db = isDigitCode(cb)
    if (da && db) {
      let ia = i
      while (ia < a.length && isDigitCode(a.charCodeAt(ia))) ia++
      let jb = j
      while (jb < b.length && isDigitCode(b.charCodeAt(jb))) jb++
      const na = Number(a.slice(i, ia))
      const nb = Number(b.slice(j, jb))
      if (na !== nb) return na < nb ? -1 : 1
      i = ia
      j = jb
    } else if (da !== db) {
      return da ? -1 : 1
    } else {
      if (ca !== cb) return ca < cb ? -1 : 1
      i++
      j++
    }
  }
  return a.length - i - (b.length - j)
}

// --------------------------------------------------------------- envelope --

/** Accept `{trace:{resourceSpans}}`, `{resourceSpans}`, and `{batches}`. */
function extractResourceSpans(raw: unknown): unknown[] {
  if (raw === null || typeof raw !== 'object') return []
  const o = raw as Record<string, unknown>
  if (Array.isArray(o.resourceSpans)) return o.resourceSpans
  if (Array.isArray(o.batches)) return o.batches
  if (o.trace !== undefined) return extractResourceSpans(o.trace)
  return []
}

/** Spans live under `scopeSpans` (new) or `instrumentationLibrarySpans` (old). */
function extractScopeSpans(group: Record<string, unknown>): unknown[] {
  if (Array.isArray(group.scopeSpans)) return group.scopeSpans
  if (Array.isArray(group.instrumentationLibrarySpans)) return group.instrumentationLibrarySpans
  return []
}

// ----------------------------------------------------------------- parser --

interface RawSpanRec {
  spanId: string
  parentSpanId: string | null
  traceId: string
  name: string
  kind: SpanKind
  startBig: bigint | null
  endBig: bigint | null
  attributes: Attributes
  status: SpanStatus
  statusMessage: string
  level: Level | null
  instanceId: string
  rawEvents: unknown[]
}

interface InstanceMeta {
  id: string
  serviceName: string
  instanceTag: string | null
}

function deriveInstance(resource: unknown): InstanceMeta {
  const attrs =
    resource !== null && typeof resource === 'object'
      ? parseAttributes((resource as Record<string, unknown>).attributes)
      : {}
  const rawName = attrs['service.name']
  const serviceName = typeof rawName === 'string' && rawName.length > 0 ? rawName : 'unknown'
  const rawTag = attrs['service.instance.id']
  const instanceTag = typeof rawTag === 'string' && rawTag.length > 0 ? rawTag : null
  // The full tag is the identity — truncation is a display concern only;
  // shortening here would silently merge distinct instances (worker-001/-002).
  const id = instanceTag !== null ? `${serviceName}#${instanceTag}` : serviceName
  return { id, serviceName, instanceTag }
}

export function parseTrace(raw: unknown, traceId: string): TraceModel {
  const warnings: string[] = []
  const modelTraceId = idToHex(traceId) ?? traceId.toLowerCase()

  // ---- pass 1: flatten OTLP JSON into raw span records ----
  const recs: RawSpanRec[] = []
  const seenIds = new Set<string>()
  const instanceMeta = new Map<string, InstanceMeta>()

  for (const group of extractResourceSpans(raw)) {
    if (group === null || typeof group !== 'object') continue
    const g = group as Record<string, unknown>
    const meta = deriveInstance(g.resource)
    for (const scope of extractScopeSpans(g)) {
      if (scope === null || typeof scope !== 'object') continue
      const spans = (scope as Record<string, unknown>).spans
      if (!Array.isArray(spans)) continue
      for (const rawSpan of spans) {
        if (rawSpan === null || typeof rawSpan !== 'object') continue
        const s = rawSpan as Record<string, unknown>
        const spanId = idToHex(s.spanId)
        const name = typeof s.name === 'string' ? s.name : ''
        if (spanId === null) {
          warnings.push(`skipped span "${name}": missing or invalid span id`)
          continue
        }
        if (seenIds.has(spanId)) {
          warnings.push(`skipped duplicate span id ${spanId} ("${name}")`)
          continue
        }
        seenIds.add(spanId)
        if (!instanceMeta.has(meta.id)) instanceMeta.set(meta.id, meta)
        const attributes = parseAttributes(s.attributes)
        const { status, message } = parseStatus(s.status)
        recs.push({
          spanId,
          parentSpanId: idToHex(s.parentSpanId),
          traceId: idToHex(s.traceId) ?? modelTraceId,
          name,
          kind: parseKind(s.kind),
          startBig: toNanos(s.startTimeUnixNano),
          endBig: toNanos(s.endTimeUnixNano),
          attributes,
          status,
          statusMessage: message,
          level: levelFromAttributes(attributes),
          instanceId: meta.id,
          rawEvents: Array.isArray(s.events) ? s.events : [],
        })
      }
    }
  }

  if (recs.length === 0) {
    warnings.push('trace contains no spans')
    return {
      traceId: modelTraceId,
      startUnixMs: 0,
      durationNs: 0,
      instances: [],
      spans: new Map(),
      events: [],
      warnings,
    }
  }

  // ---- pass 2: time extent (BigInt; relative nanos fit in doubles) ----
  let earliest: bigint | null = null
  for (const r of recs) {
    if (r.startBig !== null && r.startBig !== 0n && (earliest === null || r.startBig < earliest)) {
      earliest = r.startBig
    }
  }
  if (earliest === null) {
    earliest = 0n
    warnings.push('no span has a valid start time; all offsets clamped to 0')
  }

  let latest = earliest
  for (const r of recs) {
    if (r.startBig === null || r.startBig === 0n) {
      warnings.push(`span ${r.spanId} ("${r.name}") missing start time; clamped to trace start`)
      r.startBig = earliest
    }
    if (r.endBig === null || r.endBig === 0n) {
      warnings.push(`span ${r.spanId} ("${r.name}") missing end time; duration clamped to 0`)
      r.endBig = r.startBig
    } else if (r.endBig < r.startBig) {
      warnings.push(`span ${r.spanId} ("${r.name}") ends before it starts; duration clamped to 0`)
      r.endBig = r.startBig
    }
    if (r.endBig > latest) latest = r.endBig
  }

  const startUnixMs = Number(earliest / 1_000_000n) + Number(earliest % 1_000_000n) / 1e6
  const durationNs = Number(latest - earliest)

  // ---- pass 3: build SpanNodes + events ----
  const spans = new Map<string, SpanNode>()
  const allEvents: SpanEvent[] = []

  for (const r of recs) {
    const startNs = Number((r.startBig as bigint) - earliest)
    const node: SpanNode = {
      spanId: r.spanId,
      parentSpanId: r.parentSpanId,
      traceId: r.traceId,
      name: r.name,
      kind: r.kind,
      startNs,
      durationNs: Number((r.endBig as bigint) - (r.startBig as bigint)),
      attributes: r.attributes,
      events: [],
      status: r.status,
      statusMessage: r.statusMessage,
      level: r.level,
      instanceId: r.instanceId,
      children: [],
      depth: 0,
    }
    for (const rawEvent of r.rawEvents) {
      if (rawEvent === null || typeof rawEvent !== 'object') continue
      const e = rawEvent as Record<string, unknown>
      const evName = typeof e.name === 'string' ? e.name : ''
      const tBig = toNanos(e.timeUnixNano)
      let timeNs: number
      if (tBig === null || tBig === 0n) {
        warnings.push(`event "${evName}" on span ${r.spanId} missing time; clamped to span start`)
        timeNs = startNs
      } else {
        timeNs = Number(tBig - earliest)
      }
      const evAttrs = parseAttributes(e.attributes)
      node.events.push({
        name: evName,
        timeNs,
        attributes: evAttrs,
        level: levelFromAttributes(evAttrs),
        spanId: r.spanId,
        instanceId: r.instanceId,
      })
    }
    node.events.sort((a, b) => a.timeNs - b.timeNs)
    allEvents.push(...node.events)
    spans.set(r.spanId, node)
  }
  allEvents.sort((a, b) => a.timeNs - b.timeNs)

  // ---- pass 4: link trees; orphans become roots ----
  const roots: SpanNode[] = []
  for (const node of spans.values()) {
    const pid = node.parentSpanId
    if (pid !== null && pid !== node.spanId && spans.has(pid)) {
      const parent = spans.get(pid)
      if (parent !== undefined) parent.children.push(node)
    } else {
      if (pid !== null) {
        warnings.push(
          `orphan span ${node.spanId} ("${node.name}"): parent ${pid} not found; treated as root`,
        )
      }
      roots.push(node)
    }
  }
  roots.sort((a, b) => a.startNs - b.startNs)

  // Depth assignment via iterative DFS. Parent cycles are not just skipped:
  // back-edges to already-visited spans are severed from `children` so the
  // SpanNode graph escaping the parser is a true forest — consumers walk
  // `children` without visited guards. First-visit edges are safe because a
  // span is only marked visited when popped, never when pushed.
  const visited = new Set<string>()
  const stack: SpanNode[] = []
  const dfsFrom = (root: SpanNode): void => {
    root.depth = 0
    stack.push(root)
    while (stack.length > 0) {
      const n = stack.pop()
      if (n === undefined || visited.has(n.spanId)) continue
      visited.add(n.spanId)
      n.children = n.children.filter((c) => !visited.has(c.spanId))
      n.children.sort((a, b) => a.startNs - b.startNs)
      for (const c of n.children) {
        c.depth = n.depth + 1
        stack.push(c)
      }
    }
  }
  for (const r of roots) dfsFrom(r)
  for (const node of spans.values()) {
    if (!visited.has(node.spanId)) {
      warnings.push(
        `span ${node.spanId} ("${node.name}") unreachable (parent cycle via ${node.parentSpanId}); treated as root`,
      )
      node.parentSpanId = null
      roots.push(node)
      dfsFrom(node)
    }
  }

  // ---- pass 5: assemble instances (natural sort; color from name) ----
  const metas = [...instanceMeta.values()].sort(
    (a, b) => naturalCompare(a.serviceName, b.serviceName) || naturalCompare(a.id, b.id),
  )
  const instances: Instance[] = metas.map((meta) => {
    let spanCount = 0
    let maxDepth = 0
    for (const node of spans.values()) {
      if (node.instanceId !== meta.id) continue
      spanCount++
      if (node.depth > maxDepth) maxDepth = node.depth
    }
    return {
      id: meta.id,
      serviceName: meta.serviceName,
      instanceTag: meta.instanceTag,
      colorIndex: colorIndexForService(meta.serviceName),
      spanCount,
      rootSpans: roots.filter((r) => r.instanceId === meta.id).sort((a, b) => a.startNs - b.startNs),
      maxDepth,
    }
  })

  return {
    traceId: modelTraceId,
    startUnixMs,
    durationNs,
    instances,
    spans,
    events: allEvents,
    warnings,
  }
}

// --------------------------------------------------------- aggregate tree --

function makeAggregateNode(pathKey: string, name: string, depth: number): AggregateNode {
  return {
    pathKey,
    name,
    depth,
    children: [],
    spans: new Map(),
    count: 0,
    minNs: 0,
    maxNs: 0,
    meanNs: 0,
    totalNs: 0,
  }
}

/**
 * Group `spans` (already filtered to visible instances, in instance order)
 * under `parent` by span name, in order of first appearance; recurse on the
 * children of every matched span.
 */
function aggregateInto(parent: AggregateNode, spans: SpanNode[], hidden: ReadonlySet<string>): void {
  const byName = new Map<string, { node: AggregateNode; matched: SpanNode[] }>()
  for (const span of spans) {
    if (hidden.has(span.instanceId)) continue
    let entry = byName.get(span.name)
    if (entry === undefined) {
      entry = {
        node: makeAggregateNode(parent.pathKey + span.name, span.name, parent.depth + 1),
        matched: [],
      }
      byName.set(span.name, entry)
      parent.children.push(entry.node)
    }
    entry.matched.push(span)
    const list = entry.node.spans.get(span.instanceId)
    if (list === undefined) entry.node.spans.set(span.instanceId, [span])
    else list.push(span)
  }

  for (const { node, matched } of byName.values()) {
    let min = Infinity
    let max = -Infinity
    let total = 0
    for (const span of matched) {
      const d = span.durationNs
      if (d < min) min = d
      if (d > max) max = d
      total += d
    }
    node.count = matched.length
    node.minNs = matched.length > 0 ? min : 0
    node.maxNs = matched.length > 0 ? max : 0
    node.totalNs = total
    node.meanNs = matched.length > 0 ? total / matched.length : 0

    const childSpans: SpanNode[] = []
    for (const span of matched) childSpans.push(...span.children)
    if (childSpans.length > 0) aggregateInto(node, childSpans, hidden)
  }
}

/**
 * Build the merged flame tree: spans from all visible instances grouped by
 * path (root → ... → name). The returned root is synthetic
 * (`pathKey: ''`, `name: ''`, `depth: -1`).
 */
export function buildAggregateTree(model: TraceModel, hidden: ReadonlySet<string>): AggregateNode {
  const root = makeAggregateNode('', '', -1)
  const rootSpans: SpanNode[] = []
  for (const inst of model.instances) {
    if (hidden.has(inst.id)) continue
    rootSpans.push(...inst.rootSpans)
  }
  if (rootSpans.length > 0) aggregateInto(root, rootSpans, hidden)
  return root
}

// --------------------------------------------------------- comparison --

/**
 * Assemble per-node span matches into one synthetic multi-instance trace for
 * side-by-side comparison. Matches are grouped BY PROVIDER (`instance.id`): each
 * provider gets exactly ONE lane holding every subtree it matched, so comparing
 * by a non-pinning attribute (e.g. role=leader across many rounds) yields one
 * lane per node — not one lane per matched trace.
 *
 * The shared time axis is anchored at the EARLIEST matched span across all
 * nodes; each subtree is then offset by its real skew, so a node that entered
 * late renders shifted right rather than left-aligned. Within a lane, the
 * non-overlapping subtrees pack onto the same rows (the flame packer handles
 * the layout). Span ids are prefixed per-match so ids drawn from separate
 * source traces never collide. The result is a normal `TraceModel` that the
 * flame, stats, and heatmap views render directly.
 *
 * Inter-lane offsets pass through the millisecond-domain `startUnixMs`, so skew
 * is accurate to well under a microsecond (within-lane offsets stay exact).
 */
export function assembleComparison(matches: SpanMatch[], traceId: string): TraceModel {
  const spans = new Map<string, SpanNode>()
  const events: SpanEvent[] = []
  let durationNs = 0

  // Absolute start of a match's root (epoch ms) and the shared origin.
  const absMs = (m: SpanMatch): number => m.startUnixMs + m.root.startNs / 1e6
  const originMs = matches.reduce((min, m) => Math.min(min, absMs(m)), Infinity)

  // One lane per provider; same-provider matches accumulate into its rootSpans.
  const lanes = new Map<
    string,
    { instance: Instance; rootSpans: SpanNode[]; spanCount: number; maxDepth: number }
  >()

  matches.forEach((match, idx) => {
    const { instance, root } = match
    // Index-prefixed so two matches from the same provider (or identical span
    // ids across separate traces) never collide in the shared span map.
    const prefix = (id: string): string => `${idx}::${id}`
    const baseDepth = root.depth
    const laneOffsetNs = Math.round((absMs(match) - originMs) * 1e6)
    // Map a source time (relative to the node's own trace) onto the shared axis.
    const reb = (t: number): number => laneOffsetNs + (t - root.startNs)

    // Collect the matched span and its descendants. The parser guarantees
    // `children` is a true forest, so this plain stack walk terminates.
    const subtree: SpanNode[] = []
    const stack: SpanNode[] = [root]
    while (stack.length > 0) {
      const n = stack.pop()
      if (n === undefined) continue
      subtree.push(n)
      for (const c of n.children) stack.push(c)
    }

    const cloned = new Map<string, SpanNode>()
    let maxDepth = 0
    for (const n of subtree) {
      const isRoot = n.spanId === root.spanId
      const startNs = reb(n.startNs)
      const depth = n.depth - baseDepth
      if (depth > maxDepth) maxDepth = depth
      if (startNs + n.durationNs > durationNs) durationNs = startNs + n.durationNs
      const node: SpanNode = {
        ...n,
        spanId: prefix(n.spanId),
        parentSpanId: isRoot || n.parentSpanId === null ? null : prefix(n.parentSpanId),
        startNs,
        instanceId: instance.id,
        depth,
        events: n.events.map((e) => ({
          ...e,
          spanId: prefix(e.spanId),
          instanceId: instance.id,
          timeNs: reb(e.timeNs),
        })),
        children: [],
      }
      cloned.set(node.spanId, node)
      spans.set(node.spanId, node)
      events.push(...node.events)
    }

    // Re-link children within the cloned subtree (parser sibling order).
    for (const node of cloned.values()) {
      if (node.parentSpanId === null) continue
      cloned.get(node.parentSpanId)?.children.push(node)
    }
    for (const node of cloned.values()) node.children.sort((a, b) => a.startNs - b.startNs)

    const clonedRoot = cloned.get(prefix(root.spanId))
    if (clonedRoot === undefined) return
    const lane = lanes.get(instance.id)
    if (lane === undefined) {
      lanes.set(instance.id, {
        instance,
        rootSpans: [clonedRoot],
        spanCount: subtree.length,
        maxDepth,
      })
    } else {
      lane.rootSpans.push(clonedRoot)
      lane.spanCount += subtree.length
      lane.maxDepth = Math.max(lane.maxDepth, maxDepth)
    }
  })

  const instances: Instance[] = [...lanes.values()].map((lane) => ({
    id: lane.instance.id,
    serviceName: lane.instance.serviceName,
    instanceTag: lane.instance.instanceTag,
    colorIndex: lane.instance.colorIndex,
    spanCount: lane.spanCount,
    rootSpans: lane.rootSpans.sort((a, b) => a.startNs - b.startNs),
    maxDepth: lane.maxDepth,
  }))

  events.sort((a, b) => a.timeNs - b.timeNs)
  instances.sort(
    (a, b) => naturalCompare(a.serviceName, b.serviceName) || naturalCompare(a.id, b.id),
  )

  const startUnixMs = Number.isFinite(originMs) ? originMs : 0
  return { traceId, startUnixMs, durationNs, instances, spans, events, warnings: [] }
}
