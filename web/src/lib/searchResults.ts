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

export function groupTraceSummaries(traces: readonly TraceSummary[], filter: FilterState): GroupedRows<TraceSummary> {
  const attrs = groupAttrs(filter).filter((attr) => attr.scope !== 'event')
  if (attrs.length === 0 || !attrs.some((attr) => attr.scope === 'span')) {
    return { rows: [...traces], compares: [] }
  }

  const groups = new Map<string, { traces: TraceSummary[]; name: string; values: AttrPrimitive[] }>()
  const rest: TraceSummary[] = []
  for (const trace of traces) {
    if (trace.matchedSpans.length !== 1) {
      rest.push(trace)
      continue
    }
    const span = trace.matchedSpans[0]
    const values = attrs.map((attr) => valueFor(span.attributes, attr))
    if (values.some((value) => value === null)) {
      rest.push(trace)
      continue
    }
    const key = groupKey(span.name, attrs, values as AttrPrimitive[])
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { traces: [trace], name: span.name, values: values as AttrPrimitive[] })
    else group.traces.push(trace)
  }

  const rows = [...rest]
  const compares: CompareRow<TraceSummary>[] = []
  for (const [key, group] of groups) {
    if (group.traces.length < 2) {
      rows.push(...group.traces)
      continue
    }
    const row = traceRow(`compare:${key}`, group.traces, group.name)
    rows.push(row)
    compares.push({ row, filter: compareFilter(filter, group.name, attrs, group.values), target: 'spans' })
  }
  rows.sort((a, b) => b.startUnixMs - a.startUnixMs)
  return { rows, compares }
}

export function groupEventSummaries(events: readonly EventSummary[], filter: FilterState): GroupedRows<EventSummary> {
  const attrs = groupAttrs(filter)
  if (attrs.length === 0 || !attrs.some((attr) => attr.scope === 'span' || attr.scope === 'event')) {
    return { rows: [...events], compares: [] }
  }

  const groups = new Map<string, { events: EventSummary[]; name: string; values: AttrPrimitive[] }>()
  const rest: EventSummary[] = []
  for (const event of events) {
    const values = attrs.map((attr) => valueFor(event.attributes, attr))
    if (values.some((value) => value === null)) {
      rest.push(event)
      continue
    }
    const key = groupKey(event.eventName, attrs, values as AttrPrimitive[])
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { events: [event], name: event.eventName, values: values as AttrPrimitive[] })
    else group.events.push(event)
  }

  const rows = [...rest]
  const compares: CompareRow<EventSummary>[] = []
  for (const [key, group] of groups) {
    if (group.events.length < 2) {
      rows.push(...group.events)
      continue
    }
    const row = eventRow(`compare:${key}`, group.events, group.name)
    rows.push(row)
    compares.push({ row, filter: compareFilter(filter, group.name, attrs, group.values), target: 'events' })
  }
  rows.sort((a, b) => b.spanStartUnixMs - a.spanStartUnixMs)
  return { rows, compares }
}
