/*
 * The API surface, in one table. Adding a route here is the ONLY way to
 * expose one — the dispatcher, the /api/v1 discovery index, and
 * /api/v1/openapi.json all render from this list.
 */

import type { RouteDef, RouteParamDoc } from './router'
import { handleHealth } from './misc'
import { handleCompile, handleSearchEvents, handleSearchTraces } from './search'
import { handleCompare, handleCompareAggregate, handleTrace, handleTraceSummary } from './traces'
import { handleTagNames, handleTagValues } from './tags'

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
    example: 'span.height=42',
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

const COMPARE_QUERY_PARAMS: RouteParamDoc[] = [
  ...SEARCH_QUERY_PARAMS,
  {
    name: 'target',
    in: 'query',
    description: 'Compare matched spans (default) or matched events by assembling their owning spans.',
    example: 'spans',
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
    pattern: '/api/v1/compare',
    operationId: 'compareBySpan',
    summary:
      'Compare ONE span across nodes by correlating it in each node\'s own trace. Runs the search dialect to locate the matching span (give an exact `name` plus an `attr` that pins the operation, e.g. name=round&nameRegex=false&attr=span.height=42), then assembles each match\'s subtree into one multi-instance trace whose lanes share a time axis anchored at the EARLIEST matched span, so each node\'s start skew is visible. With target=events, the event search locates matching events and assembles their owning spans. Expects one matching span per node trace. The response is the same shape as GET /traces/:id, so the flame/stats/heatmap views render it directly.',
    params: COMPARE_QUERY_PARAMS,
    responseSchema: 'wireTraceSchema',
    example:
      "curl -s 'http://localhost:8080/api/v1/compare?name=round&nameRegex=false&attr=span.height%3D42&since=1h'",
    handler: handleCompare,
  },
  {
    method: 'GET',
    pattern: '/api/v1/compare/aggregate',
    operationId: 'compareAggregate',
    summary:
      'The merged ("aggregate") flame tree of a comparison: the same span correlated across nodes (search dialect, e.g. name=round&nameRegex=false&attr=span.height=42), assembled and grouped by name-path with per-instance duration/error stats. The cross-node code-path view — compare the same path across every node without downloading spans.',
    params: [
      ...SEARCH_QUERY_PARAMS,
      {
        name: 'spanIds',
        in: 'query',
        description: 'Include per-instance matching span ids on every node (default false).',
        example: 'true',
      },
    ],
    responseSchema: 'aggregateResponseSchema',
    example:
      "curl -s 'http://localhost:8080/api/v1/compare/aggregate?name=round&nameRegex=false&attr=span.height%3D42&since=1h'",
    handler: handleCompareAggregate,
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
  {
    method: 'GET',
    pattern: '/api/v1/traces/:traceId/summary',
    operationId: 'getTraceSummary',
    summary:
      'Pre-flight overview of one trace (one node): duration, span/event counts, and rollups (spanCount, errorCount, start/end extents) WITHOUT any span payload. Fetch this before deciding to download the full trace; use /compare/aggregate to compare a span across nodes.',
    params: [
      { name: 'traceId', in: 'path', description: 'Trace id (hex; base64 also accepted).' },
    ],
    responseSchema: 'traceOverviewSchema',
    example: 'curl -s http://localhost:8080/api/v1/traces/0af7651916cd43dd8448eb211c80319c/summary',
    handler: handleTraceSummary,
  },
  {
    method: 'GET',
    pattern: '/api/v1/traces/:traceId',
    operationId: 'getTrace',
    summary:
      'One fully parsed trace: span-deduplicated, with the tree encoded as parentSpanId/childSpanIds over a flat span list (times in ns relative to startUnixMs). A trace is one node\'s work — prefer /summary for rollups, and /compare to view a span across nodes.',
    params: [
      { name: 'traceId', in: 'path', description: 'Trace id (hex; base64 also accepted).' },
    ],
    responseSchema: 'wireTraceSchema',
    example: 'curl -s http://localhost:8080/api/v1/traces/0af7651916cd43dd8448eb211c80319c',
    handler: handleTrace,
  },
  {
    method: 'GET',
    pattern: '/api/v1/tags/:scope',
    operationId: 'getTagNames',
    summary:
      'Attribute-name suggestions for a scope (span, resource, or event). With `name`, suggestions are limited to attributes seen on matching spans or events.',
    params: [
      { name: 'scope', in: 'path', description: 'span, resource, or event.', example: 'resource' },
      { name: 'q', in: 'query', description: 'Case-insensitive substring filter.', example: 'service' },
      {
        name: 'target',
        in: 'query',
        description: 'Name context target: spans (default) or events.',
        example: 'spans',
      },
      {
        name: 'name',
        in: 'query',
        description: 'Optional span name, or event name when target=events, used to scope suggestions.',
        example: 'round',
      },
      {
        name: 'nameRegex',
        in: 'query',
        description: 'Interpret `name` as a regex (default true) or exact string (false).',
        example: 'false',
      },
    ],
    responseSchema: 'tagNamesResponseSchema',
    example: 'curl -s http://localhost:8080/api/v1/tags/span',
    handler: handleTagNames,
  },
  {
    method: 'GET',
    pattern: '/api/v1/tags/:scope/:tag/values',
    operationId: 'getTagValues',
    summary: 'Known values for one attribute, e.g. every service.name in the resource scope.',
    params: [
      { name: 'scope', in: 'path', description: 'span, resource, or event.', example: 'resource' },
      { name: 'tag', in: 'path', description: 'Attribute name (no scope prefix).', example: 'service.name' },
      { name: 'q', in: 'query', description: 'Case-insensitive substring filter.', example: 'node' },
    ],
    responseSchema: 'tagValuesResponseSchema',
    example: "curl -s 'http://localhost:8080/api/v1/tags/resource/service.name/values'",
    handler: handleTagValues,
  },
]
