/*
 * Structured trace export — a compact, agent-friendly JSON representation of
 * the spans and events currently displayed, namespaced by service instance.
 * Times are milliseconds relative to the trace start (µs precision); empty
 * and unset fields are omitted to keep the payload small.
 */

import type {
  Attributes,
  Level,
  SpanEvent,
  SpanNode,
  TraceModel,
} from './model'

export interface ExportedEvent {
  name: string
  /** Offset from the trace start, milliseconds. */
  offsetMs: number
  level?: Level
  attributes?: Attributes
}

export interface ExportedSpan {
  name: string
  spanId: string
  /** Offset from the trace start, milliseconds. */
  startOffsetMs: number
  durationMs: number
  level?: Level
  status?: 'ok' | 'error'
  statusMessage?: string
  attributes?: Attributes
  events?: ExportedEvent[]
  children?: ExportedSpan[]
}

export interface ExportedTrace {
  traceId: string
  /** ISO-8601 wall clock of the trace start. */
  startTime: string
  durationMs: number
  /** Instance id (service.name[#tag]) → its span trees. */
  services: Record<string, { spans: ExportedSpan[] }>
}

/** Nanoseconds → milliseconds with microsecond precision. */
function ms(ns: number): number {
  return Math.round(ns / 1e3) / 1e3
}

function exportEvent(ev: SpanEvent): ExportedEvent {
  const out: ExportedEvent = { name: ev.name, offsetMs: ms(ev.timeNs) }
  if (ev.level !== null) out.level = ev.level
  if (Object.keys(ev.attributes).length > 0) out.attributes = ev.attributes
  return out
}

function exportSpan(span: SpanNode): ExportedSpan {
  const out: ExportedSpan = {
    name: span.name,
    spanId: span.spanId,
    startOffsetMs: ms(span.startNs),
    durationMs: ms(span.durationNs),
  }
  if (span.level !== null) out.level = span.level
  if (span.status !== 'unset') out.status = span.status
  if (span.statusMessage !== '') out.statusMessage = span.statusMessage
  if (Object.keys(span.attributes).length > 0) out.attributes = span.attributes
  if (span.events.length > 0) out.events = span.events.map(exportEvent)
  if (span.children.length > 0) out.children = span.children.map(exportSpan)
  return out
}

/**
 * Export the displayed portion of a trace: instances in `hidden` are
 * excluded, exactly like the flamegraph.
 */
export function exportTrace(
  model: TraceModel,
  hidden: ReadonlySet<string>,
): ExportedTrace {
  const services: Record<string, { spans: ExportedSpan[] }> = {}
  for (const inst of model.instances) {
    if (hidden.has(inst.id)) continue
    services[inst.id] = { spans: inst.rootSpans.map(exportSpan) }
  }
  return {
    traceId: model.traceId,
    startTime: new Date(model.startUnixMs).toISOString(),
    durationMs: ms(model.durationNs),
    services,
  }
}
