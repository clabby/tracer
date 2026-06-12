/*
 * The published schema registry — every schema the API exposes, keyed by the
 * names routes use in `responseSchema`/`requestSchema`. Served inside
 * /api/v1/openapi.json (components.schemas) and referenced by the discovery
 * index. Keys are typo-proof: RouteDef fields are typed `SchemaKey`.
 */

import {
  aggregateInstanceStatsSchema,
  aggregateNodeSchema,
  aggregateResponseSchema,
  attrFilterSchema,
  compileRequestSchema,
  compileResponseSchema,
  eventSummarySchema,
  filterStateSchema,
  healthResponseSchema,
  levelSchema,
  partialFilterSchema,
  problemSchema,
  searchRangeSchema,
  searchRequestSchema,
  searchEventsResponseSchema,
  searchTracesResponseSchema,
  spanEventSchema,
  tagNamesResponseSchema,
  tagValuesResponseSchema,
  timeRangeSchema,
  traceOverviewSchema,
  traceSummarySchema,
  wireInstanceSchema,
  wireSpanSchema,
  wireTraceSchema,
} from '../src/lib/apischema'

export const SCHEMA_REGISTRY = {
  // route bodies
  healthResponseSchema,
  searchRequestSchema,
  searchTracesResponseSchema,
  searchEventsResponseSchema,
  compileRequestSchema,
  compileResponseSchema,
  wireTraceSchema,
  traceOverviewSchema,
  aggregateResponseSchema,
  tagNamesResponseSchema,
  tagValuesResponseSchema,
  problemSchema,
  // building blocks (referenced by the bodies above)
  traceSummarySchema,
  eventSummarySchema,
  wireSpanSchema,
  wireInstanceSchema,
  spanEventSchema,
  aggregateNodeSchema,
  aggregateInstanceStatsSchema,
  filterStateSchema,
  partialFilterSchema,
  attrFilterSchema,
  searchRangeSchema,
  timeRangeSchema,
  levelSchema,
} as const

export type SchemaKey = keyof typeof SCHEMA_REGISTRY
