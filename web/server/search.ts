/*
 * Search handlers. The heavy lifting — TraceQL compilation, the windowed
 * newest-first search with dedup, defensive response mapping — is the shared
 * lib (`buildTraceQL`, `TempoClient`); these handlers only parse input and
 * shape the response envelope, echoing the executed TraceQL.
 */

import { EVENT_SELECT } from '../src/api/tempo'
import { buildTraceQL } from '../src/lib/traceql'
import type {
  CompileResponse,
  SearchEventsResponse,
  SearchTracesResponse,
} from '../src/lib/apischema'
import { badRequest } from './problem'
import { json, type Deps } from './router'
import {
  parseFilterObject,
  parseSearchBody,
  parseSearchQuery,
  readJsonBody,
  type ParsedSearch,
} from './params'
import type { InvalidParam } from './problem'

async function parsedFrom(req: Request, url: URL): Promise<ParsedSearch> {
  return req.method === 'POST' ? parseSearchBody(await readJsonBody(req)) : parseSearchQuery(url)
}

export async function handleSearchTraces(
  req: Request,
  url: URL,
  _params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  const { filter, range } = await parsedFrom(req, url)
  const traces = await deps.tempo.searchTraces(filter, range)
  const body: SearchTracesResponse = {
    traces,
    query: { traceql: buildTraceQL(filter), range, limit: filter.limit },
  }
  return json(body)
}

export async function handleSearchEvents(
  req: Request,
  url: URL,
  _params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  const { filter, range } = await parsedFrom(req, url)
  const events = await deps.tempo.searchEvents(filter, range)
  const body: SearchEventsResponse = {
    events,
    query: { traceql: `${buildTraceQL(filter, 'events')}${EVENT_SELECT}`, range, limit: filter.limit },
  }
  return json(body)
}

// --------------------------------------------------------- traceql/compile --

function parseTarget(raw: unknown, errors: InvalidParam[]): 'spans' | 'events' {
  if (raw === undefined || raw === null) return 'spans'
  if (raw === 'spans' || raw === 'events') return raw
  errors.push({ name: 'target', reason: 'must be "spans" or "events"', example: 'spans' })
  return 'spans'
}

/**
 * Compile a filter to TraceQL without executing it. Same module as the
 * search routes, so what this returns is exactly what a search would run.
 */
export async function handleCompile(
  req: Request,
  url: URL,
  _params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  void deps
  let filter
  let target: 'spans' | 'events'
  if (req.method === 'POST') {
    const raw = await readJsonBody(req)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw badRequest('Body must be a JSON object: { filter?, target? }.', [
        { name: '(body)', reason: 'not an object', example: '{"filter": {"errorsOnly": true}}' },
      ])
    }
    const o = raw as Record<string, unknown>
    const errors: InvalidParam[] = []
    for (const key of Object.keys(o)) {
      if (key !== 'filter' && key !== 'target') {
        errors.push({ name: key, reason: 'unknown body field — known: filter, target' })
      }
    }
    target = parseTarget(o.target, errors)
    filter = parseFilterObject(o.filter, errors)
    if (errors.length > 0) throw badRequest('The request body is invalid.', errors)
  } else {
    const errors: InvalidParam[] = []
    target = parseTarget(url.searchParams.get('target') ?? undefined, errors)
    if (errors.length > 0) throw badRequest('Invalid target parameter.', errors)
    // Range params are accepted (shared dialect) but irrelevant to compilation.
    filter = parseSearchQuery(url, ['target']).filter
  }
  const body: CompileResponse = { traceql: buildTraceQL(filter, target), target }
  return json(body)
}
