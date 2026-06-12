/*
 * ApiClient — the SPA's client for the tracer API server (`/api/v1`).
 * Implements `ITempoClient`, so components keep the same seam they had
 * against Tempo directly; the heavy lifting (TraceQL compilation, the
 * windowed newest-first search with dedup, OTLP parsing, instance
 * splitting) now happens server-side. Failures surface as descriptive
 * `Error`s (method, URL, HTTP status, problem detail) — same contract as
 * TempoClient, so error states render unchanged.
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
import { parseDurationInput } from '../lib/format'
import { hydrateTrace, type WireTrace } from '../lib/wire'
import type {
  ApiProblem,
  SearchEventsResponse,
  SearchTracesResponse,
  TagNamesResponse,
  TagValuesResponse,
} from '../lib/apischema'

const TIMEOUT_MS = 15_000
const BODY_EXCERPT_CHARS = 256

/**
 * Drop draft-state noise before POSTing, mirroring `buildTraceQL`'s
 * tolerance: it skips attrs with blank keys and unparseable durations, so
 * searches that ran under the old in-browser compiler (e.g. an un-filled
 * "+ attribute" row, or "150" typed before its unit) must keep running —
 * the server's strict validation is for API callers, not UI drafts.
 */
export function sanitizeFilter(filter: FilterState): FilterState {
  return {
    ...filter,
    attrs: filter.attrs.filter((a) => a.key.trim() !== ''),
    minDuration: parseDurationInput(filter.minDuration) !== null ? filter.minDuration : '',
    maxDuration: parseDurationInput(filter.maxDuration) !== null ? filter.maxDuration : '',
  }
}

export class ApiClient implements ITempoClient {
  readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  // ------------------------------------------------------------- transport --

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`
    let res: Response
    try {
      res = await fetch(url, {
        method,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(body !== undefined
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`${method} ${url} failed: ${detail}`)
    }
    if (!res.ok) {
      // Non-2xx is problem+json — surface its detail; fall back to raw text.
      let detail = ''
      try {
        const text = await res.text()
        try {
          const p = JSON.parse(text) as ApiProblem
          detail = p.detail ?? ''
          // Per-field validation failures are the actionable part of a 400.
          if (p.invalidParams !== undefined && p.invalidParams.length > 0) {
            detail += ` (${p.invalidParams.map((ip) => `${ip.name}: ${ip.reason}`).join('; ')})`
          }
        } catch {
          detail = text.trim().slice(0, BODY_EXCERPT_CHARS)
        }
      } catch {
        // body unreadable — status alone will have to do
      }
      throw new Error(`${method} ${url} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    try {
      return await res.json()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`${method} ${url} returned invalid JSON: ${detail}`)
    }
  }

  // ---------------------------------------------------------------- search --

  async searchTraces(filter: FilterState, range: TimeRange): Promise<TraceSummary[]> {
    const data = (await this.request('POST', '/search/traces', {
      filter: sanitizeFilter(filter),
      range: { from: range.from, to: range.to },
    })) as SearchTracesResponse
    return data.traces
  }

  async searchEvents(filter: FilterState, range: TimeRange): Promise<EventSummary[]> {
    const data = (await this.request('POST', '/search/events', {
      filter: sanitizeFilter(filter),
      range: { from: range.from, to: range.to },
    })) as SearchEventsResponse
    return data.events
  }

  // ----------------------------------------------------------------- trace --

  async fetchTrace(traceId: string): Promise<TraceModel> {
    const wire = (await this.request(
      'GET',
      `/traces/${encodeURIComponent(traceId)}`,
    )) as WireTrace
    return hydrateTrace(wire)
  }

  // ------------------------------------------------------------------ tags --

  async tagNames(scope: TagScope, q?: string): Promise<string[]> {
    const qs = q !== undefined && q.trim() !== '' ? `?q=${encodeURIComponent(q)}` : ''
    const data = (await this.request('GET', `/tags/${scope}${qs}`)) as TagNamesResponse
    return data.names
  }

  async tagValues(tag: string, scope: TagScope, q?: string): Promise<string[]> {
    const qs = q !== undefined && q.trim() !== '' ? `?q=${encodeURIComponent(q)}` : ''
    const data = (await this.request(
      'GET',
      `/tags/${scope}/${encodeURIComponent(tag)}/values${qs}`,
    )) as TagValuesResponse
    return data.values
  }

  // ------------------------------------------------------------------ ping --

  /** True only when the API server AND its Tempo upstream are healthy. */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      return res.ok
    } catch {
      return false
    }
  }
}
