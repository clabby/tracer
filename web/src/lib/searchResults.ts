import {
  type AttrFilter,
  type AttrPrimitive,
  type Attributes,
  type EventSummary,
  type FilterState,
  type SearchTarget,
  type TraceSummary,
} from './model'

export interface CompareRow<T> {
  row: T
  filter: FilterState
  target: SearchTarget
}

export interface GroupedRows<T> {
  rows: T[]
  compares: CompareRow<T>[]
}

function valueFor(attrs: Attributes, attr: AttrFilter): AttrPrimitive | null {
  const key = attr.key.trim()
  if (key === '') return null
  const scoped = attr.scope === 'event' ? `event.${key}` : `${attr.scope}.${key}`
  const eventIntrinsic = attr.scope === 'event' ? `event:${key}` : ''
  return attrs[key] ?? attrs[scoped] ?? (eventIntrinsic === '' ? undefined : attrs[eventIntrinsic]) ?? null
}

function groupAttrs(filter: FilterState): AttrFilter[] {
  if (filter.rawQuery.trim() !== '') return []
  return filter.attrs.filter((attr) => attr.key.trim() !== '')
}

function attrKey(attr: AttrFilter, value: AttrPrimitive): string {
  return `${attr.scope}.${attr.key.trim()}=${String(value)}`
}

function groupKey(name: string, attrs: readonly AttrFilter[], values: readonly AttrPrimitive[]): string {
  return `${name}\u001f${attrs.map((attr, i) => attrKey(attr, values[i])).join('\u001f')}`
}

function compareFilter(base: FilterState, name: string, attrs: readonly AttrFilter[], values: readonly AttrPrimitive[]): FilterState {
  return {
    ...base,
    name,
    nameIsRegex: false,
    rawQuery: '',
    attrs: attrs.map((attr, i) => ({
      ...attr,
      op: '=',
      value: String(values[i]),
    })),
  }
}

function traceRow(id: string, traces: readonly TraceSummary[], name: string): TraceSummary {
  const services = new Set<string>()
  const spanIds = new Set<string>()
  const matchedSpans: TraceSummary['matchedSpans'] = []
  let startUnixMs = Infinity
  let endUnixMs = 0
  let spanCount = 0

  for (const trace of traces) {
    startUnixMs = Math.min(startUnixMs, trace.startUnixMs)
    endUnixMs = Math.max(endUnixMs, trace.startUnixMs + trace.durationMs)
    spanCount += trace.spanCount
    for (const service of trace.services) services.add(service)
    for (const spanId of trace.matchedSpanIds) spanIds.add(spanId)
    matchedSpans.push(...trace.matchedSpans)
  }

  return {
    traceId: id,
    rootServiceName: '',
    rootTraceName: `${name} x${traces.length}`,
    startUnixMs,
    durationMs: Math.max(0, endUnixMs - startUnixMs),
    spanCount,
    services: [...services].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    matchedSpanIds: [...spanIds],
    matchedSpanNames: [],
    matchedSpans,
  }
}

function eventRow(id: string, events: readonly EventSummary[], name: string): EventSummary {
  const first = events[0]
  const spanStartUnixMs = Math.min(...events.map((event) => event.spanStartUnixMs))
  let latestEndMs = spanStartUnixMs
  for (const event of events) {
    latestEndMs = Math.max(latestEndMs, event.spanStartUnixMs + event.spanDurationNs / 1e6)
  }
  return {
    ...first,
    traceId: id,
    spanId: id,
    spanName: `${first.spanName} x${events.length}`,
    eventName: `${name} x${events.length}`,
    serviceName: `${new Set(events.map((event) => event.serviceName)).size} services`,
    spanStartUnixMs,
    spanDurationNs: Math.max(0, Math.round((latestEndMs - spanStartUnixMs) * 1e6)),
  }
}

/**
 * Group rows that are equivalent under the current filter — same name plus the
 * same value for every grouping attribute — collapsing each group of ≥2 into
 * one synthetic "compare" row (the others pass through untouched). A row whose
 * grouping attributes can't all be read (`getAttrs` null, or a missing value)
 * is left alone. Each collapsed group also yields a `CompareRow` carrying the
 * exact filter that reproduces it via `/compare`.
 */
function groupRows<T>(
  items: readonly T[],
  filter: FilterState,
  attrs: AttrFilter[],
  target: SearchTarget,
  getAttrs: (item: T) => Attributes | null,
  getName: (item: T) => string,
  startMs: (item: T) => number,
  makeRow: (id: string, group: T[], name: string) => T,
): GroupedRows<T> {
  const groups = new Map<string, { items: T[]; name: string; values: AttrPrimitive[] }>()
  const rest: T[] = []
  for (const item of items) {
    const itemAttrs = getAttrs(item)
    const values = itemAttrs === null ? null : attrs.map((attr) => valueFor(itemAttrs, attr))
    if (values === null || values.some((value) => value === null)) {
      rest.push(item)
      continue
    }
    const vals = values as AttrPrimitive[]
    const name = getName(item)
    const key = groupKey(name, attrs, vals)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { items: [item], name, values: vals })
    else group.items.push(item)
  }

  const rows = [...rest]
  const compares: CompareRow<T>[] = []
  for (const [key, group] of groups) {
    if (group.items.length < 2) {
      rows.push(...group.items)
      continue
    }
    const row = makeRow(`compare:${key}`, group.items, group.name)
    rows.push(row)
    compares.push({ row, filter: compareFilter(filter, group.name, attrs, group.values), target })
  }
  rows.sort((a, b) => startMs(b) - startMs(a))
  return { rows, compares }
}

export function groupTraceSummaries(traces: readonly TraceSummary[], filter: FilterState): GroupedRows<TraceSummary> {
  // Span rows correlate on span/resource attributes; a span attribute is what
  // pins the operation, so without one there is nothing to compare on.
  const attrs = groupAttrs(filter).filter((attr) => attr.scope !== 'event')
  if (!attrs.some((attr) => attr.scope === 'span')) return { rows: [...traces], compares: [] }
  return groupRows(
    traces,
    filter,
    attrs,
    'spans',
    // Only single-match rows correlate cleanly to one operation per node.
    (trace) => (trace.matchedSpans.length === 1 ? trace.matchedSpans[0].attributes : null),
    (trace) => trace.matchedSpans[0]?.name ?? trace.rootTraceName,
    (trace) => trace.startUnixMs,
    traceRow,
  )
}

export function groupEventSummaries(events: readonly EventSummary[], filter: FilterState): GroupedRows<EventSummary> {
  const attrs = groupAttrs(filter)
  if (!attrs.some((attr) => attr.scope === 'span' || attr.scope === 'event')) {
    return { rows: [...events], compares: [] }
  }
  return groupRows(
    events,
    filter,
    attrs,
    'events',
    (event) => event.attributes,
    (event) => event.eventName,
    (event) => event.spanStartUnixMs,
    eventRow,
  )
}
