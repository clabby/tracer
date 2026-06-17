/*
 * Discovery routes: the /api/v1 index (the API's front door for agents),
 * the OpenAPI document, and the markdown docs. Built as a factory over the
 * composed route table (see surface.ts) so the index can list every route —
 * including these — without a circular import.
 */

import type { RouteDef } from './router'
import { buildOpenApi } from './openapi'
import { CONVENTIONS, renderDocs } from './docs'

function routeEntry(r: RouteDef): Record<string, unknown> {
  return {
    method: r.method,
    path: r.pattern,
    summary: r.summary,
    ...(r.params !== undefined && r.params.length > 0 ? { params: r.params } : {}),
    ...(r.requestSchema !== undefined
      ? { requestSchema: `/api/v1/openapi.json#/components/schemas/${r.requestSchema}` }
      : {}),
    ...(r.responseSchema !== undefined
      ? { responseSchema: `/api/v1/openapi.json#/components/schemas/${r.responseSchema}` }
      : {}),
    example: r.example,
  }
}

export function makeDiscoveryRoutes(getAll: () => readonly RouteDef[]): RouteDef[] {
  // Rendered once on first request — the table is static after composition.
  let indexBody: string | null = null
  let openApiBody: string | null = null
  let docsBody: string | null = null

  return [
    {
      method: 'GET',
      pattern: '/api/v1',
      operationId: 'getIndex',
      summary:
        'This index: every route with parameters, schemas, and runnable examples, plus the unit/id/dedup conventions. The place to start.',
      example: 'curl -s http://localhost:8080/api/v1',
      handler: async () => {
        indexBody ??= JSON.stringify(
          {
            name: 'tracer API',
            version: 'v1',
            description:
              'REST middle layer over Grafana Tempo for distributed systems where each node emits its own trace. Fetch one node\'s trace, or correlate the same span across nodes by span name + attribute via /compare (and /compare/aggregate for per-node code-path stats).',
            conventions: CONVENTIONS,
            routes: getAll().map(routeEntry),
            links: {
              openapi: '/api/v1/openapi.json',
              docs: '/api/v1/docs',
              llmsTxt: '/.well-known/llms.txt',
              health: '/api/v1/health',
            },
          },
          null,
          2,
        )
        return new Response(indexBody, { headers: { 'content-type': 'application/json' } })
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/openapi.json',
      operationId: 'getOpenApi',
      summary: 'OpenAPI 3.1 document; components.schemas holds every published schema.',
      example: 'curl -s http://localhost:8080/api/v1/openapi.json',
      handler: async () => {
        openApiBody ??= JSON.stringify(buildOpenApi(getAll()), null, 2)
        return new Response(openApiBody, { headers: { 'content-type': 'application/json' } })
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/docs',
      operationId: 'getDocs',
      summary:
        'Agent guide (markdown / llms.txt style): conventions, route one-liners, and multi-step recipes. Also served at /.well-known/llms.txt.',
      example: 'curl -s http://localhost:8080/api/v1/docs',
      handler: async () => {
        docsBody ??= renderDocs(getAll())
        return new Response(docsBody, {
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        })
      },
    },
  ]
}
