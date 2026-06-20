/*
 * API schemas — the single source of truth for the REST API's wire contracts.
 *
 * Every schema is a JSON Schema object (`as const`) that is:
 *   1. served verbatim in `/api/v1/openapi.json` and the `/api/v1` index, and
 *   2. compile-time checked against the authoritative types in `model.ts` /
 *      `wire.ts` (the `_Check*` asserts at the bottom) — `bun run check`
 *      fails if a schema and its type ever drift.
 *
 * Envelope types (bodies that exist only at the API boundary) are DERIVED
 * from their schemas via `FromSchema`, so they cannot drift by construction.
 * `json-schema-to-ts` is a dev-only, type-only dependency — nothing here
 * survives to a runtime bundle beyond plain object literals.
 */

import type { FromSchema } from 'json-schema-to-ts'
import type {
  AttrFilter,
  Attributes,
  EventSummary,
  FilterState,
  Level,
  SpanEvent,
  TimeRange,
  TraceSummary,
} from './model'
import type {
  WireAggregateInstanceStats,
  WireAggregateNode,
  WireInstance,
  WireSpan,
  WireTrace,
} from './wire'

// ------------------------------------------------------------- primitives --

export const levelSchema = {
  description: 'Log level extracted from `level` / `log.level` / `severity` attributes.',
  enum: ['trace', 'debug', 'info', 'warn', 'error'],
} as const

const nullableLevel = {
  description: 'Log level, or null when the span/event carries none.',
  enum: ['trace', 'debug', 'info', 'warn', 'error', null],
} as const

const attributes = {
  description: 'Flattened OTLP attributes. Arrays/kvlists arrive JSON-encoded as strings.',
  type: 'object',
  additionalProperties: { type: ['string', 'number', 'boolean'] },
} as const

const matchedSpanSummarySchema = {
  description: 'One span matched by a trace search row.',
  type: 'object',
  additionalProperties: false,
  properties: {
    spanId: { type: 'string', description: 'Matched span id, lowercase hex.' },
    name: { type: 'string', description: 'Matched span name.' },
    attributes,
  },
  required: ['spanId', 'name', 'attributes'],
} as const

// ------------------------------------------------------------ trace shapes --

export const spanEventSchema = {
  description: 'One event recorded on a span.',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Event name.' },
    timeNs: {
      type: 'number',
      description: 'Nanoseconds relative to the trace start (`startUnixMs`).',
    },
    attributes,
    level: nullableLevel,
    spanId: { type: 'string', description: 'Owning span id (lowercase hex).' },
    instanceId: { type: 'string', description: 'Id of the instance that emitted the owning span.' },
  },
  required: ['name', 'timeNs', 'attributes', 'level', 'spanId', 'instanceId'],
} as const

export const wireSpanSchema = {
  description:
    'One span. Times are nanoseconds relative to the trace `startUnixMs`; tree shape is encoded by `parentSpanId` + `childSpanIds` (sibling order preserved).',
  type: 'object',
  additionalProperties: false,
  properties: {
    spanId: { type: 'string', description: 'Span id, lowercase hex.' },
    parentSpanId: {
      type: ['string', 'null'],
      description: 'Parent span id (lowercase hex), or null for roots.',
    },
    traceId: { type: 'string', description: 'Trace id, lowercase hex.' },
    name: { type: 'string', description: 'Span name.' },
    kind: {
      description: 'OTLP span kind.',
      enum: ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'],
    },
    startNs: {
      type: 'number',
      description: 'Start offset in nanoseconds relative to the trace `startUnixMs`.',
    },
    durationNs: { type: 'number', description: 'Span duration in nanoseconds.' },
    attributes,
    events: {
      type: 'array',
      description: "This span's events, sorted by `timeNs`.",
      items: spanEventSchema,
    },
    status: { description: 'OTLP span status.', enum: ['unset', 'ok', 'error'] },
    statusMessage: { type: 'string', description: 'Status message (often empty).' },
    level: nullableLevel,
    instanceId: {
      type: 'string',
      description: 'Id of the instance (emitting process / node) that produced this span.',
    },
    childSpanIds: {
      type: 'array',
      description: 'Ids of child spans, in start-time order.',
      items: { type: 'string' },
    },
    depth: { type: 'integer', description: '0 for roots, parent depth + 1 otherwise.' },
  },
  required: [
    'spanId',
    'parentSpanId',
    'traceId',
    'name',
    'kind',
    'startNs',
    'durationNs',
    'attributes',
    'events',
    'status',
    'statusMessage',
    'level',
    'instanceId',
    'childSpanIds',
    'depth',
  ],
} as const

export const wireInstanceSchema = {
  description:
    'One instance — an emitting process, typically one node of the distributed system. Identity is the resource attributes `service.name` plus `#service.instance.id` when present.',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Stable unique id, e.g. `node-2` or `node-2#a1b2`.' },
    serviceName: { type: 'string', description: 'Resource `service.name`.' },
    instanceTag: {
      type: ['string', 'null'],
      description: 'Resource `service.instance.id`, or null when absent.',
    },
    colorIndex: {
      type: 'integer',
      description: 'Hue (0-359) for the instance\'s generated color (display concern).',
    },
    spanCount: { type: 'integer', description: 'Number of spans emitted by this instance.' },
    maxDepth: { type: 'integer', description: 'Deepest span depth within this instance.' },
    rootSpanIds: {
      type: 'array',
      description: "Ids of this instance's root spans, in start-time order.",
      items: { type: 'string' },
    },
    errorCount: {
      type: 'integer',
      description: 'Number of spans in this instance with status `error`.',
    },
    earliestStartNs: {
      type: 'number',
      description: 'Earliest span start in this instance, ns relative to trace start.',
    },
    latestEndNs: {
      type: 'number',
      description: 'Latest span end in this instance, ns relative to trace start.',
    },
  },
  required: [
    'id',
    'serviceName',
    'instanceTag',
    'colorIndex',
    'spanCount',
    'maxDepth',
    'rootSpanIds',
    'errorCount',
    'earliestStartNs',
    'latestEndNs',
  ],
} as const

export const wireTraceSchema = {
  description:
    'A fully parsed trace: a flat span list with the tree encoded by parentSpanId/childSpanIds. From /traces/:id it is one node; from /compare it is the same span assembled across nodes (one instance per node) on a shared time axis anchored at the earliest node, so start skew is visible. Span times are nanoseconds relative to `startUnixMs`.',
  type: 'object',
  additionalProperties: false,
  properties: {
    traceId: { type: 'string', description: 'Trace id, lowercase hex.' },
    startUnixMs: {
      type: 'number',
      description: 'Epoch milliseconds of the earliest span start.',
    },
    durationNs: {
      type: 'number',
      description: 'Extent from earliest start to latest end, nanoseconds.',
    },
    instances: { type: 'array', items: wireInstanceSchema },
    spans: {
      type: 'array',
      description: 'Every span in the trace (flat; tree shape via `childSpanIds`).',
      items: wireSpanSchema,
    },
    warnings: {
      type: 'array',
      description: 'Non-fatal parse anomalies (orphan spans, missing times, ...).',
      items: { type: 'string' },
    },
  },
  required: ['traceId', 'startUnixMs', 'durationNs', 'instances', 'spans', 'warnings'],
} as const

// ----------------------------------------------------------- search shapes --

export const traceSummarySchema = {
  description: 'One trace search result row.',
  type: 'object',
  additionalProperties: false,
  properties: {
    traceId: { type: 'string', description: 'Trace id, lowercase hex.' },
    rootServiceName: { type: 'string', description: "Root span's service (may be empty)." },
    rootTraceName: { type: 'string', description: "Root span's name (may be empty)." },
    startUnixMs: { type: 'number', description: 'Trace start, epoch milliseconds.' },
    durationMs: { type: 'number', description: 'Trace duration in milliseconds.' },
    spanCount: { type: 'integer', description: 'Total spans in the trace (from Tempo serviceStats; falls back to the matched-span count when unavailable).' },
    services: {
      type: 'array',
      description: 'Distinct service names seen in the trace, when available.',
      items: { type: 'string' },
    },
    matchedSpanIds: {
      type: 'array',
      description: 'Ids of the spans the search query actually matched (may be empty).',
      items: { type: 'string' },
    },
    matchedSpanNames: {
      type: 'array',
      description: 'Name of each matched span, one entry per span (duplicates expected).',
      items: { type: 'string' },
    },
    matchedSpans: {
      type: 'array',
      description: 'Matched spans with attributes returned by Tempo for the span set.',
      items: matchedSpanSummarySchema,
    },
  },
  required: [
    'traceId',
    'rootServiceName',
    'rootTraceName',
    'startUnixMs',
    'durationMs',
    'spanCount',
    'services',
    'matchedSpanIds',
    'matchedSpanNames',
    'matchedSpans',
  ],
} as const

export const eventSummarySchema = {
  description:
    'One matched event from an event-targeted search. Timing is span-level: Tempo search does not expose event timestamps.',
  type: 'object',
  additionalProperties: false,
  properties: {
    traceId: { type: 'string', description: 'Trace id, lowercase hex.' },
    spanId: { type: 'string', description: 'Owning span id, lowercase hex.' },
    spanName: { type: 'string', description: 'Owning span name.' },
    eventName: { type: 'string', description: 'Matched event name.' },
    level: nullableLevel,
    serviceName: { type: 'string', description: "Owning span's service name." },
    spanStartUnixMs: { type: 'number', description: "Owning span's start, epoch milliseconds." },
    spanDurationNs: { type: 'number', description: "Owning span's duration in nanoseconds." },
    attributes,
  },
  required: [
    'traceId',
    'spanId',
    'spanName',
    'eventName',
    'level',
    'serviceName',
    'spanStartUnixMs',
    'spanDurationNs',
    'attributes',
  ],
} as const

// ---------------------------------------------------------------- filters --

const attrFilterProperties = {
  id: { type: 'string', description: 'Client-local id (any string; used for list keys).' },
  scope: { description: 'Attribute scope.', enum: ['span', 'resource', 'event'] },
  key: { type: 'string', description: 'Attribute key, e.g. `view` or `service.name`.' },
  op: { description: 'TraceQL comparison operator.', enum: ['=', '!=', '=~', '!~', '>', '<', '>=', '<='] },
  value: { type: 'string', description: 'Comparison value (numbers/bools as strings).' },
} as const

export const attrFilterSchema = {
  description: 'One attribute predicate.',
  type: 'object',
  additionalProperties: false,
  properties: attrFilterProperties,
  required: ['id', 'scope', 'key', 'op', 'value'],
} as const

/** Input variant: `id` is a client-local row key, optional on the way in
 * (the server fills a default) — matches the API's own corrected examples. */
export const attrFilterInputSchema = {
  description: 'One attribute predicate. `id` is optional on input.',
  type: 'object',
  additionalProperties: false,
  properties: attrFilterProperties,
  required: ['scope', 'key', 'op', 'value'],
} as const

const filterProperties = {
  services: {
    type: 'array',
    description: 'Selected providers (`resource.service.name`). Empty = all.',
    items: { type: 'string' },
  },
  name: {
    type: 'string',
    description:
      'Span-name match (event-name match for event searches). Substring regex when `nameIsRegex`.',
  },
  nameIsRegex: { type: 'boolean', description: 'Interpret `name` as a regex (default true).' },
  levels: { type: 'array', description: 'Selected levels. Empty = all.', items: levelSchema },
  attrs: { type: 'array', description: 'Attribute predicates, ANDed.', items: attrFilterSchema },
  minDuration: {
    type: 'string',
    description: 'Span duration lower bound as a human string ("150ms", "2s"). Empty = unset.',
  },
  maxDuration: {
    type: 'string',
    description: 'Span duration upper bound as a human string. Empty = unset.',
  },
  errorsOnly: { type: 'boolean', description: 'Only spans with status `error`.' },
  rawQuery: {
    type: 'string',
    description: 'Raw TraceQL escape hatch; when non-empty it overrides every other field.',
  },
  limit: { type: 'integer', description: 'Maximum number of result rows (1-1000).' },
} as const

export const filterStateSchema = {
  description: 'A complete search filter. Compiles to one TraceQL expression.',
  type: 'object',
  additionalProperties: false,
  properties: filterProperties,
  required: [
    'services',
    'name',
    'nameIsRegex',
    'levels',
    'attrs',
    'minDuration',
    'maxDuration',
    'errorsOnly',
    'rawQuery',
    'limit',
  ],
} as const

/** Same properties, but accepting the input form of attrs (optional id). */
const filterInputProperties = {
  ...filterProperties,
  attrs: {
    type: 'array',
    description: 'Attribute predicates, ANDed. `id` is optional on input.',
    items: attrFilterInputSchema,
  },
} as const

export const partialFilterSchema = {
  description: 'A search filter; omitted fields take their defaults.',
  type: 'object',
  additionalProperties: false,
  properties: filterInputProperties,
} as const

export const timeRangeSchema = {
  description: 'Resolved time range in unix SECONDS (not ms, not ns).',
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'number', description: 'Range start, unix seconds (inclusive).' },
    to: { type: 'number', description: 'Range end, unix seconds (inclusive).' },
  },
  required: ['from', 'to'],
} as const

export const searchRangeSchema = {
  description:
    'Time range for a search: either absolute `from`+`to` (unix seconds) or relative `lastSeconds` (resolved against the server clock). Omit entirely for the default (last 15 minutes).',
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'number', description: 'Range start, unix seconds. Requires `to`.' },
    to: { type: 'number', description: 'Range end, unix seconds. Requires `from`.' },
    lastSeconds: {
      type: 'number',
      description: 'Relative range: the last N seconds. Mutually exclusive with `from`/`to`.',
    },
  },
} as const

export const searchRequestSchema = {
  description: 'POST body for the search routes.',
  type: 'object',
  additionalProperties: false,
  properties: {
    filter: partialFilterSchema,
    range: searchRangeSchema,
  },
} as const

const queryEcho = {
  description: 'What was actually executed, for transparency and debugging.',
  type: 'object',
  additionalProperties: false,
  properties: {
    traceql: { type: 'string', description: 'The compiled TraceQL expression sent to Tempo.' },
    range: timeRangeSchema,
    limit: { type: 'integer', description: 'The applied row limit.' },
  },
  required: ['traceql', 'range', 'limit'],
} as const

export const searchTracesResponseSchema = {
  description:
    'Trace search results, deduplicated by trace id and sorted newest-first. The result set is a deterministic "latest N in range" — to see further back, narrow or shift the range.',
  type: 'object',
  additionalProperties: false,
  properties: {
    traces: { type: 'array', items: traceSummarySchema },
    query: queryEcho,
  },
  required: ['traces', 'query'],
} as const

export const searchEventsResponseSchema = {
  description:
    'Event search results, deduplicated by span id + event name and sorted newest-first by owning-span start.',
  type: 'object',
  additionalProperties: false,
  properties: {
    events: { type: 'array', items: eventSummarySchema },
    query: queryEcho,
  },
  required: ['events', 'query'],
} as const

// -------------------------------------------------------------- aggregate --

export const aggregateInstanceStatsSchema = {
  description: "Duration stats for one instance's spans under one aggregate path.",
  type: 'object',
  additionalProperties: false,
  properties: {
    count: { type: 'integer', description: 'Matching spans from this instance.' },
    minNs: { type: 'number', description: 'Minimum span duration, nanoseconds.' },
    maxNs: { type: 'number', description: 'Maximum span duration, nanoseconds.' },
    meanNs: { type: 'number', description: 'Mean span duration, nanoseconds.' },
    totalNs: { type: 'number', description: 'Total span duration, nanoseconds.' },
    errorCount: { type: 'integer', description: 'Spans with status `error`.' },
  },
  required: ['count', 'minNs', 'maxNs', 'meanNs', 'totalNs', 'errorCount'],
} as const

export const aggregateNodeSchema = {
  description:
    'One node of the merged flame tree. Nesting is encoded by `path` (span names root → node), so the node list is flat and pre-ordered.',
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      type: 'array',
      description: 'Span names from root to this node; `path.length === depth + 1`.',
      items: { type: 'string' },
    },
    name: { type: 'string', description: 'Span name at this path.' },
    depth: { type: 'integer', description: '0 for root-level paths.' },
    count: { type: 'integer', description: 'Matching spans across all included instances.' },
    minNs: { type: 'number', description: 'Minimum span duration, nanoseconds.' },
    maxNs: { type: 'number', description: 'Maximum span duration, nanoseconds.' },
    meanNs: { type: 'number', description: 'Mean span duration, nanoseconds.' },
    totalNs: { type: 'number', description: 'Total span duration, nanoseconds.' },
    perInstance: {
      type: 'object',
      description: 'instanceId → duration/error stats for that instance at this path.',
      additionalProperties: aggregateInstanceStatsSchema,
    },
    spanIds: {
      type: 'object',
      description: 'instanceId → matching span ids. Present only when `?spanIds=true`.',
      additionalProperties: { type: 'array', items: { type: 'string' } },
    },
  },
  required: ['path', 'name', 'depth', 'count', 'minNs', 'maxNs', 'meanNs', 'totalNs', 'perInstance'],
} as const

export const aggregateResponseSchema = {
  description:
    'The merged ("aggregate") flame tree: spans from the included instances grouped by name-path, with per-instance stats — compare the same code path across nodes without downloading spans.',
  type: 'object',
  additionalProperties: false,
  properties: {
    traceId: { type: 'string', description: 'Trace id, lowercase hex.' },
    instances: {
      type: 'array',
      description: 'Ids of the instances included in the aggregation.',
      items: { type: 'string' },
    },
    nodes: {
      type: 'array',
      description: 'Flame nodes in pre-order (parents before children).',
      items: aggregateNodeSchema,
    },
  },
  required: ['traceId', 'instances', 'nodes'],
} as const

// ---------------------------------------------------------------- overview --

export const traceOverviewSchema = {
  description:
    'A small pre-flight summary of one trace: per-instance rollups without any span payload. Fetch this before deciding whether to download the full trace.',
  type: 'object',
  additionalProperties: false,
  properties: {
    traceId: { type: 'string', description: 'Trace id, lowercase hex.' },
    startUnixMs: { type: 'number', description: 'Epoch milliseconds of the earliest span start.' },
    durationNs: { type: 'number', description: 'Trace extent, nanoseconds.' },
    spanCount: { type: 'integer', description: 'Total spans across all instances.' },
    eventCount: { type: 'integer', description: 'Total events across all spans.' },
    instances: { type: 'array', items: wireInstanceSchema },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'traceId',
    'startUnixMs',
    'durationNs',
    'spanCount',
    'eventCount',
    'instances',
    'warnings',
  ],
} as const

// -------------------------------------------------------------- tags/misc --

export const tagNamesResponseSchema = {
  description: 'Attribute-name suggestions for one scope.',
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { description: 'The queried scope.', enum: ['span', 'resource', 'event'] },
    names: { type: 'array', description: 'Sorted, deduplicated tag names.', items: { type: 'string' } },
  },
  required: ['scope', 'names'],
} as const

export const tagValuesResponseSchema = {
  description: 'Attribute-value suggestions for one tag.',
  type: 'object',
  additionalProperties: false,
  properties: {
    tag: { type: 'string', description: 'The queried tag name.' },
    scope: { description: 'The queried scope.', enum: ['span', 'resource', 'event'] },
    values: { type: 'array', description: 'Sorted, deduplicated values.', items: { type: 'string' } },
  },
  required: ['tag', 'scope', 'values'],
} as const

export const healthResponseSchema = {
  description:
    'Server + upstream health. HTTP 200 when Tempo is reachable, 503 otherwise (same body shape).',
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'True when the API server itself is up.' },
    tempo: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reachable: { type: 'boolean', description: 'Whether Tempo answered the last probe.' },
        apiVersion: {
          description: 'Detected Tempo search-API generation.',
          enum: ['v2', 'v1', 'unknown'],
        },
      },
      required: ['reachable', 'apiVersion'],
    },
  },
  required: ['ok', 'tempo'],
} as const

export const compileRequestSchema = {
  description: 'POST body for /traceql/compile.',
  type: 'object',
  additionalProperties: false,
  properties: {
    filter: partialFilterSchema,
    target: {
      description: 'What the query matches: spans (default) or events.',
      enum: ['spans', 'events'],
    },
  },
} as const

export const compileResponseSchema = {
  description: 'The TraceQL the filter compiles to — exactly what a search would execute.',
  type: 'object',
  additionalProperties: false,
  properties: {
    traceql: { type: 'string', description: 'Compiled TraceQL expression.' },
    target: { description: 'The compile target.', enum: ['spans', 'events'] },
  },
  required: ['traceql', 'target'],
} as const

export const problemSchema = {
  description:
    'RFC 9457 problem details — the single error shape for every non-2xx response (content-type `application/problem+json`).',
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', description: 'Problem type URI (or `about:blank`).' },
    title: { type: 'string', description: 'Short, human-readable summary.' },
    status: { type: 'integer', description: 'HTTP status code.' },
    detail: { type: 'string', description: 'What went wrong, specifically.' },
    hint: { type: 'string', description: 'How to fix the request. GET /api/v1 lists all routes.' },
    invalidParams: {
      type: 'array',
      description: 'Validation failures, one per offending parameter/field.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Parameter or body field name.' },
          reason: { type: 'string', description: 'Why it was rejected.' },
          example: { type: 'string', description: 'A corrected example value.' },
        },
        required: ['name', 'reason'],
      },
    },
  },
  required: ['type', 'title', 'status', 'detail'],
} as const

// ---------------------------------------------------------- derived types --

/** Time range for a search request (absolute or relative). */
export type SearchRange = FromSchema<typeof searchRangeSchema>
/** POST body for the search routes. */
export type SearchRequest = FromSchema<typeof searchRequestSchema>
export type SearchTracesResponse = FromSchema<typeof searchTracesResponseSchema>
export type SearchEventsResponse = FromSchema<typeof searchEventsResponseSchema>
export type AggregateResponse = FromSchema<typeof aggregateResponseSchema>
export type TraceOverview = FromSchema<typeof traceOverviewSchema>
export type TagNamesResponse = FromSchema<typeof tagNamesResponseSchema>
export type TagValuesResponse = FromSchema<typeof tagValuesResponseSchema>
export type HealthResponse = FromSchema<typeof healthResponseSchema>
export type CompileRequest = FromSchema<typeof compileRequestSchema>
export type CompileResponse = FromSchema<typeof compileResponseSchema>
export type ApiProblem = FromSchema<typeof problemSchema>

// ------------------------------------------------------------ drift guard --

/*
 * Mutual-assignability asserts between each model-mirroring schema and its
 * authoritative type. A schema or type change that breaks the contract turns
 * into a tsc error on the corresponding `_Check*` line below.
 */

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Expect<T extends true> = T

/** The input form of an attr predicate (optional client-local id). */
type AttrFilterInput = Omit<AttrFilter, 'id'> & { id?: string }
/** The input form of a filter: partial, with input-form attrs. */
type FilterInput = Partial<Omit<FilterState, 'attrs'> & { attrs: AttrFilterInput[] }>

/** Compile-time only; never instantiated. Each entry errors on drift. */
export type SchemaDriftChecks = [
  Expect<Eq<FromSchema<typeof levelSchema>, Level>>,
  Expect<Eq<FromSchema<typeof attributes>, Attributes>>,
  Expect<Eq<FromSchema<typeof spanEventSchema>, SpanEvent>>,
  Expect<Eq<FromSchema<typeof wireSpanSchema>, WireSpan>>,
  Expect<Eq<FromSchema<typeof wireInstanceSchema>, WireInstance>>,
  Expect<Eq<FromSchema<typeof wireTraceSchema>, WireTrace>>,
  Expect<Eq<FromSchema<typeof traceSummarySchema>, TraceSummary>>,
  Expect<Eq<FromSchema<typeof eventSummarySchema>, EventSummary>>,
  Expect<Eq<FromSchema<typeof attrFilterSchema>, AttrFilter>>,
  Expect<Eq<FromSchema<typeof attrFilterInputSchema>, AttrFilterInput>>,
  Expect<Eq<FromSchema<typeof filterStateSchema>, FilterState>>,
  Expect<Eq<FromSchema<typeof partialFilterSchema>, FilterInput>>,
  Expect<Eq<FromSchema<typeof timeRangeSchema>, TimeRange>>,
  Expect<Eq<FromSchema<typeof aggregateInstanceStatsSchema>, WireAggregateInstanceStats>>,
  Expect<Eq<FromSchema<typeof aggregateNodeSchema>, WireAggregateNode>>,
]
