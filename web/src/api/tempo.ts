/*
 * TempoClient — HTTP client for the Grafana Tempo query API.
 *
 * Implements `ITempoClient` from lib/model. Handles both old and new Tempo
 * response shapes (v2 endpoints with v1 fallbacks), parses defensively, and
 * surfaces failures as descriptive `Error`s (HTTP status + body excerpt).
 */

import type {
  EventSummary,
  FilterState,
  ITempoClient,
  TagScope,
  TimeRange,
  TraceModel,
  TraceSummary,
} from '../lib/model'
import { eventSummaryKey, levelFromAttributes } from '../lib/model'
import { buildTraceQL } from '../lib/traceql'
import { parseTrace } from '../lib/trace'

const TIMEOUT_MS = 15_000
const BODY_EXCERPT_CHARS = 256

/** Pipeline suffix appended to event searches (exported so the API server's
 * query echo states exactly what was executed). */
export const EVENT_SELECT = ' | select(name, resource.service.name, event.level)'

export class TempoClient implements ITempoClient {
  readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(baseUrl: string, timeoutMs: number = TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
  }

  // ------------------------------------------------------------- transport --

  private async request(path: string, timeoutMs: number = this.timeoutMs): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    let res: Response
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`GET ${url} failed: ${detail}`)
    }
    if (!res.ok) {
      let body = ''
      try {
        body = (await res.text()).trim().slice(0, BODY_EXCERPT_CHARS)
      } catch {
        // body unreadable — status alone will have to do
      }
      throw new Error(`GET ${url} returned HTTP ${res.status}${body ? `: ${body}` : ''}`)
    }
    return res
  }

  private async getJson(path: string, timeoutMs: number = this.timeoutMs): Promise<unknown> {
    const res = await this.request(path, timeoutMs)
    try {
      return await res.json()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`GET ${this.baseUrl}${path} returned invalid JSON: ${detail}`)
    }
  }

  /**
   * Remaining budget for a v1 fallback attempt: the v2→v1 fallbacks must
   * share ONE deadline, not stack two full timeouts — callers above us (the
   * API server's 12s budget under the SPA's 15s) rely on the total. Returns
   * null when the budget is already spent (rethrow the original error).
   */
  private remainingBudget(deadline: number): number | null {
    const remaining = deadline - Date.now()
    return remaining > 50 ? remaining : null
  }

  // ---------------------------------------------------------------- search --

  /**
   * Tempo search has NO result ordering: it returns an arbitrary first-N over
   * the range ("even identical searches differ" — Tempo API docs). To make
   * "latest N traces" deterministic, the range is walked backward in
   * geometrically growing windows (newest 30s first), each queried in
   * parallel; results fill newest-first and dedupe by trace id.
   */
  async searchTraces(filter: FilterState, range: TimeRange): Promise<TraceSummary[]> {
    return this.windowedSearch(
      range,
      filter.limit,
      (w) =>
        this.searchWindow(buildTraceQL(filter), filter.limit, w, (t) => {
          const s = toSummary(t)
          return s === null ? [] : [s]
        }),
      (t) => t.traceId,
      (t) => t.startUnixMs,
    )
  }

  /**
   * Event-targeted search. Tempo search returns matched SPANS (the spans
   * containing matching events), so each row carries span-level timing plus
   * the matched event name; `select()` enriches rows with the span name,
   * service, and event level.
   */
  async searchEvents(filter: FilterState, range: TimeRange): Promise<EventSummary[]> {
    const q = `${buildTraceQL(filter, 'events')}${EVENT_SELECT}`
    return this.windowedSearch(
      range,
      filter.limit,
      (w) => this.searchWindow(q, filter.limit, w, toEventSummaries),
      eventSummaryKey,
      (e) => e.spanStartUnixMs,
    )
  }

  /**
   * Walk the range backward in geometrically growing windows (newest 30s
   * first), query them in parallel, fill newest-first, dedupe by `key`.
   */
  private async windowedSearch<T>(
    range: TimeRange,
    limit: number,
    fetchWindow: (w: TimeRange) => Promise<T[]>,
    key: (item: T) => string,
    startMs: (item: T) => number,
  ): Promise<T[]> {
    const windows: TimeRange[] = []
    let to = Math.ceil(range.to)
    const from = Math.floor(range.from)
    let width = 30
    while (to > from) {
      windows.push({ from: Math.max(from, to - width), to })
      to -= width
      width *= 3
    }

    const batches = await Promise.all(windows.map(fetchWindow))

    const out: T[] = []
    const seen = new Set<string>()
    for (const batch of batches) {
      batch.sort((a, b) => startMs(b) - startMs(a))
      for (const item of batch) {
        const k = key(item)
        if (seen.has(k)) continue
        seen.add(k)
        out.push(item)
      }
      if (out.length >= limit) break
    }
    // Items overlapping a window boundary may surface out of order across
    // batches — one final sort keeps the table strictly newest-first.
    out.sort((a, b) => startMs(b) - startMs(a))
    return out.slice(0, limit)
  }

  private async searchWindow<T>(
    q: string,
    limit: number,
    w: TimeRange,
    map: (trace: unknown) => T[],
  ): Promise<T[]> {
    const params = new URLSearchParams({
      q,
      start: String(w.from),
      end: String(w.to),
      limit: String(limit),
      spss: String(limit),
    })
    const data = await this.getJson(`/api/search?${params.toString()}`)
    const traces =
      typeof data === 'object' && data !== null && Array.isArray((data as { traces?: unknown }).traces)
        ? ((data as { traces: unknown[] }).traces)
        : []
    return traces.flatMap(map)
  }

  // ----------------------------------------------------------------- trace --

  async fetchTrace(traceId: string): Promise<TraceModel> {
    const id = encodeURIComponent(traceId)
    const deadline = Date.now() + this.timeoutMs
    let raw: unknown
    try {
      raw = await this.getJson(`/api/v2/traces/${id}`)
    } catch (err) {
      const remaining = this.remainingBudget(deadline)
      if (remaining === null) throw err
      raw = await this.getJson(`/api/traces/${id}`, remaining)
    }
    return parseTrace(raw, traceId)
  }

  // ------------------------------------------------------------------ tags --

  async tagNames(scope: TagScope, q?: string): Promise<string[]> {
    const data = await this.getJson(`/api/v2/search/tags?scope=${scope}`)
    const names: string[] = []
    const scopes =
      typeof data === 'object' && data !== null && Array.isArray((data as { scopes?: unknown }).scopes)
        ? ((data as { scopes: unknown[] }).scopes)
        : []
    for (const s of scopes) {
      if (typeof s !== 'object' || s === null) continue
      const tags = (s as { tags?: unknown }).tags
      if (!Array.isArray(tags)) continue
      for (const tag of tags) {
        if (typeof tag === 'string') names.push(tag)
      }
    }
    return dedupSortFilter(names, q)
  }

  async tagValues(tag: string, scope: TagScope, q?: string): Promise<string[]> {
    // v2 takes TraceQL-scoped names: intrinsics ('name', 'event:name') are
    // queried bare, attributes get a scope prefix.
    const fullTag =
      tag === 'name' ? (scope === 'event' ? 'event:name' : 'name') : `${scope}.${tag}`
    const deadline = Date.now() + this.timeoutMs
    let values: string[]
    try {
      values = valuesFromV2(await this.getJson(`/api/v2/search/tag/${encodeURIComponent(fullTag)}/values`))
    } catch (err) {
      // The v1 endpoint takes unscoped tag names (e.g. `service.name`, not
      // `resource.service.name`); the intrinsic 'name' is already unscoped.
      const remaining = this.remainingBudget(deadline)
      if (remaining === null) throw err
      values = valuesFromV1(
        await this.getJson(`/api/search/tag/${encodeURIComponent(tag)}/values`, remaining),
      )
    }
    return dedupSortFilter(values, q)
  }

  // ------------------------------------------------------------------ ping --

  async ping(): Promise<boolean> {
    try {
      await this.request('/api/echo')
      return true
    } catch {
      return false
    }
  }
}

// ----------------------------------------------------- response mapping --

/** Defensively map one entry of the /api/search response to a TraceSummary. */
function toSummary(raw: unknown): TraceSummary | null {
  if (typeof raw !== 'object' || raw === null) return null
  const t = raw as Record<string, unknown>

  const traceId =
    typeof t.traceID === 'string' ? t.traceID : typeof t.traceId === 'string' ? t.traceId : ''
  if (traceId === '') return null

  let startUnixMs = 0
  if (typeof t.startTimeUnixNano === 'string' && t.startTimeUnixNano !== '') {
    try {
      startUnixMs = Number(BigInt(t.startTimeUnixNano) / 1_000_000n)
    } catch {
      // malformed nano timestamp — leave at 0
    }
  } else if (typeof t.startTimeUnixNano === 'number') {
    startUnixMs = t.startTimeUnixNano / 1e6
  }

  const durationMs = typeof t.durationMs === 'number' ? t.durationMs : 0

  const spanSets: unknown[] = Array.isArray(t.spanSets)
    ? t.spanSets
    : typeof t.spanSet === 'object' && t.spanSet !== null
      ? [t.spanSet]
      : []

  let spanCount = 0
  const services = new Set<string>()
  const matchedSpanIds: string[] = []
  const matchedSpanNames: string[] = []
  for (const ss of spanSets) {
    if (typeof ss !== 'object' || ss === null) continue
    const set = ss as Record<string, unknown>
    const matched = set.matched
    if (typeof matched === 'number') spanCount += matched
    collectServiceNames(set.attributes, services)
    if (Array.isArray(set.spans)) {
      for (const span of set.spans) {
        if (typeof span !== 'object' || span === null) continue
        const s = span as Record<string, unknown>
        collectServiceNames(s.attributes, services)
        if (typeof s.spanID === 'string' && s.spanID !== '') {
          matchedSpanIds.push(s.spanID.toLowerCase())
        }
        if (typeof s.name === 'string' && s.name !== '') matchedSpanNames.push(s.name)
      }
    }
  }

  // serviceStats (Tempo 2.x) lists every service in the trace — better than
  // scraping matched-span attributes.
  if (typeof t.serviceStats === 'object' && t.serviceStats !== null) {
    for (const name of Object.keys(t.serviceStats)) services.add(name)
  }

  return {
    traceId,
    rootServiceName: typeof t.rootServiceName === 'string' ? t.rootServiceName : '',
    rootTraceName: typeof t.rootTraceName === 'string' ? t.rootTraceName : '',
    startUnixMs,
    durationMs,
    spanCount,
    services: [...services].sort(),
    matchedSpanIds: [...new Set(matchedSpanIds)],
    matchedSpanNames,
  }
}

/** Read one string-ish attribute value from a search-response attr list. */
function attrString(attrs: unknown, key: string): string | null {
  if (!Array.isArray(attrs)) return null
  for (const kv of attrs) {
    if (typeof kv !== 'object' || kv === null) continue
    const entry = kv as { key?: unknown; value?: unknown }
    if (entry.key !== key) continue
    if (typeof entry.value !== 'object' || entry.value === null) continue
    const v = entry.value as Record<string, unknown>
    if (typeof v.stringValue === 'string') return v.stringValue
    if (typeof v.intValue === 'string' || typeof v.intValue === 'number') return String(v.intValue)
    if (typeof v.doubleValue === 'number') return String(v.doubleValue)
    if (typeof v.boolValue === 'boolean') return String(v.boolValue)
  }
  return null
}

/** Map one /api/search trace entry to event rows (one per matched span). */
function toEventSummaries(raw: unknown): EventSummary[] {
  if (typeof raw !== 'object' || raw === null) return []
  const t = raw as Record<string, unknown>
  const traceId =
    typeof t.traceID === 'string' ? t.traceID : typeof t.traceId === 'string' ? t.traceId : ''
  if (traceId === '') return []

  const spanSets: unknown[] = Array.isArray(t.spanSets)
    ? t.spanSets
    : typeof t.spanSet === 'object' && t.spanSet !== null
      ? [t.spanSet]
      : []

  const out: EventSummary[] = []
  for (const ss of spanSets) {
    if (typeof ss !== 'object' || ss === null) continue
    const spans = (ss as { spans?: unknown }).spans
    if (!Array.isArray(spans)) continue
    for (const span of spans) {
      if (typeof span !== 'object' || span === null) continue
      const s = span as Record<string, unknown>
      const spanId = typeof s.spanID === 'string' ? s.spanID.toLowerCase() : ''
      const eventName = attrString(s.attributes, 'event:name')
      if (spanId === '' || eventName === null) continue

      let spanStartUnixMs = 0
      if (typeof s.startTimeUnixNano === 'string' && s.startTimeUnixNano !== '') {
        try {
          spanStartUnixMs = Number(BigInt(s.startTimeUnixNano) / 1_000_000n)
        } catch {
          // malformed timestamp — leave at 0
        }
      }
      const durRaw = s.durationNanos
      const spanDurationNs =
        typeof durRaw === 'string' ? Number(durRaw) : typeof durRaw === 'number' ? durRaw : 0

      const levelRaw = attrString(s.attributes, 'level')
      out.push({
        traceId,
        spanId,
        spanName: typeof s.name === 'string' ? s.name : '',
        eventName,
        level: levelRaw === null ? null : levelFromAttributes({ level: levelRaw }),
        serviceName: attrString(s.attributes, 'service.name') ?? '',
        spanStartUnixMs,
        spanDurationNs,
      })
    }
  }
  return out
}

/** Pull `service.name` string values out of a search-response attribute list. */
function collectServiceNames(attrs: unknown, out: Set<string>): void {
  if (!Array.isArray(attrs)) return
  for (const kv of attrs) {
    if (typeof kv !== 'object' || kv === null) continue
    const { key, value } = kv as { key?: unknown; value?: unknown }
    if (key !== 'service.name' && key !== 'resource.service.name') continue
    if (typeof value !== 'object' || value === null) continue
    const sv = (value as { stringValue?: unknown }).stringValue
    if (typeof sv === 'string') out.add(sv)
  }
}

/** v2 tag values: `{ tagValues: [{ type, value }] }`. */
function valuesFromV2(data: unknown): string[] {
  const out: string[] = []
  if (typeof data !== 'object' || data === null) return out
  const tagValues = (data as { tagValues?: unknown }).tagValues
  if (!Array.isArray(tagValues)) return out
  for (const tv of tagValues) {
    if (typeof tv === 'string') {
      out.push(tv)
    } else if (typeof tv === 'object' && tv !== null) {
      const value = (tv as { value?: unknown }).value
      if (typeof value === 'string') out.push(value)
    }
  }
  return out
}

/** v1 tag values: `{ tagValues: ["..."] }`. */
function valuesFromV1(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return []
  const tagValues = (data as { tagValues?: unknown }).tagValues
  if (!Array.isArray(tagValues)) return []
  return tagValues.filter((v): v is string => typeof v === 'string')
}

/** Dedup, sort, and optionally filter by case-insensitive substring. */
function dedupSortFilter(values: string[], q?: string): string[] {
  let out = [...new Set(values)].sort()
  if (q !== undefined && q.trim() !== '') {
    const needle = q.trim().toLowerCase()
    out = out.filter((v) => v.toLowerCase().includes(needle))
  }
  return out
}
