/*
 * The API surface, in one table. Adding a route here is the ONLY way to
 * expose one — the dispatcher, the /api/v1 discovery index, and
 * /api/v1/openapi.json all render from this list.
 */

import type { RouteDef, RouteParamDoc } from './router'
import { handleHealth } from './misc'
import { handleCompile, handleSearchEvents, handleSearchTraces } from './search'

/** The flat GET search dialect, shared by both search routes. */
const SEARCH_QUERY_PARAMS: RouteParamDoc[] = [
  {
    name: 'service',
    in: 'query',
    description: 'Provider (`resource.service.name`). Repeatable; omit for all.',
    example: 'node-1',
  },
  {
    name: 'name',
    in: 'query',
    description:
      'Span-name match (event-name match on the events route). Substring regex unless nameRegex=false.',
    example: 'verify',
  },
  {
    name: 'nameRegex',
    in: 'query',
    description: 'Interpret `name` as a regex (default true) or an exact string (false).',
    example: 'true',
  },
  {
    name: 'level',
    in: 'query',
    description: 'Level filter: trace, debug, info, warn, error. Repeatable; omit for all.',
    example: 'error',
  },
  {
    name: 'errorsOnly',
    in: 'query',
    description: 'Only spans with status `error`.',
    example: 'true',
  },
  {
    name: 'minDuration',
    in: 'query',
    description: 'Span duration lower bound, human form.',
    example: '150ms',
  },
  {
    name: 'maxDuration',
    in: 'query',
    description: 'Span duration upper bound, human form.',
    example: '2s',
  },
  {
    name: 'attr',
    in: 'query',
    description:
      'Attribute predicate `<scope>.<key><op><value>`; scope in {span, resource, event}, op in {=, !=, =~, !~, >, <, >=, <=}. Repeatable (ANDed).',
    example: 'span.view=notarization',
  },
  {
    name: 'q',
    in: 'query',
    description: 'Raw TraceQL escape hatch; overrides every other filter parameter.',
    example: '{ status = error }',
  },
  {
    name: 'limit',
    in: 'query',
    description: 'Maximum rows, 1-1000 (default 50).',
    example: '50',
  },
  {
    name: 'since',
    in: 'query',
    description:
      'Relative range, e.g. 15m, 1h, 24h (default 15m). Mutually exclusive with from/to.',
    example: '1h',
  },
  {
    name: 'from',
    in: 'query',
    description: 'Absolute range start, unix SECONDS. Requires `to`.',
    example: '1765400000',
  },
  {
    name: 'to',
    in: 'query',
    description: 'Absolute range end, unix SECONDS. Requires `from`.',
    example: '1765403600',
  },
]

export const ROUTES: RouteDef[] = [
  {
    method: 'GET',
    pattern: '/api/v1/health',
    operationId: 'getHealth',
    summary:
      'Server + Tempo health. 200 when Tempo is reachable, 503 otherwise (same body shape, including the detected Tempo API generation).',
    responseSchema: 'healthResponseSchema',
    example: 'curl -s http://localhost:8080/api/v1/health',
    handler: handleHealth,
  },
  {
    method: 'GET',
    pattern: '/api/v1/search/traces',
    operationId: 'searchTraces',
    summary:
      'Search traces. Returns the latest N matching traces in the range, deduplicated and sorted newest-first (deterministic — to see further back, narrow or shift the range). The response echoes the executed TraceQL.',
    params: SEARCH_QUERY_PARAMS,
    responseSchema: 'searchTracesResponseSchema',
    example:
      "curl -s 'http://localhost:8080/api/v1/search/traces?errorsOnly=true&since=1h&limit=10'",
    handler: handleSearchTraces,
  },
  {
    method: 'POST',
    pattern: '/api/v1/search/traces',
    operationId: 'searchTracesPost',
    summary:
      'Search traces with a structured body: { filter?, range? } where filter is a (partial) FilterState and range is {from,to} unix seconds or {lastSeconds}. Same semantics as the GET form.',
    requestSchema: 'searchRequestSchema',
    responseSchema: 'searchTracesResponseSchema',
    example:
      'curl -s -X POST http://localhost:8080/api/v1/search/traces -H \'content-type: application/json\' -d \'{"filter":{"errorsOnly":true},"range":{"lastSeconds":3600}}\'',
    handler: handleSearchTraces,
  },
  {
    method: 'GET',
    pattern: '/api/v1/search/events',
    operationId: 'searchEvents',
    summary:
      'Search span events. `name`/`level` apply to the EVENT (event:name, event.level); rows carry owning-span timing because Tempo search does not expose event timestamps. Deduplicated by span+event name, newest-first.',
    params: SEARCH_QUERY_PARAMS,
    responseSchema: 'searchEventsResponseSchema',
    example: "curl -s 'http://localhost:8080/api/v1/search/events?level=error&since=1h'",
    handler: handleSearchEvents,
  },
  {
    method: 'POST',
    pattern: '/api/v1/search/events',
    operationId: 'searchEventsPost',
    summary: 'Search span events with a structured { filter?, range? } body.',
    requestSchema: 'searchRequestSchema',
    responseSchema: 'searchEventsResponseSchema',
    example:
      'curl -s -X POST http://localhost:8080/api/v1/search/events -H \'content-type: application/json\' -d \'{"filter":{"levels":["error"]}}\'',
    handler: handleSearchEvents,
  },
  {
    method: 'GET',
    pattern: '/api/v1/traceql/compile',
    operationId: 'compileTraceql',
    summary:
      'Compile the GET search dialect to TraceQL WITHOUT executing it — inspect or iterate on a filter cheaply before spending a search. Same compiler module the search routes use.',
    params: [
      ...SEARCH_QUERY_PARAMS,
      {
        name: 'target',
        in: 'query',
        description: 'Compile for spans (default) or events.',
        example: 'spans',
      },
    ],
    responseSchema: 'compileResponseSchema',
    example: "curl -s 'http://localhost:8080/api/v1/traceql/compile?service=node-1&minDuration=100ms'",
    handler: handleCompile,
  },
  {
    method: 'POST',
    pattern: '/api/v1/traceql/compile',
    operationId: 'compileTraceqlPost',
    summary: 'Compile a structured { filter?, target? } body to TraceQL without executing it.',
    requestSchema: 'compileRequestSchema',
    responseSchema: 'compileResponseSchema',
    example:
      'curl -s -X POST http://localhost:8080/api/v1/traceql/compile -H \'content-type: application/json\' -d \'{"filter":{"services":["node-1"],"minDuration":"100ms"}}\'',
    handler: handleCompile,
  },
]
