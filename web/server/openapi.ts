/*
 * OpenAPI 3.1 document, assembled from ROUTES + SCHEMA_REGISTRY — the same
 * objects the dispatcher and validators use, so the spec cannot describe a
 * surface that doesn't exist.
 */

import { SCHEMA_REGISTRY } from './registry'
import type { RouteDef } from './router'

const PROBLEM_CONTENT = {
  'application/problem+json': { schema: { $ref: '#/components/schemas/problemSchema' } },
}

function operation(route: RouteDef): Record<string, unknown> {
  const parameters = (route.params ?? []).map((p) => ({
    name: p.name,
    in: p.in,
    required: p.in === 'path',
    description: p.description,
    schema: { type: 'string' },
    ...(p.example !== undefined ? { example: p.example } : {}),
  }))

  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(route.requestSchema !== undefined
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${route.requestSchema}` },
              },
            },
          },
        }
      : {}),
    responses: {
      '200': {
        description: 'OK',
        content: {
          'application/json':
            route.responseSchema !== undefined
              ? { schema: { $ref: `#/components/schemas/${route.responseSchema}` } }
              : { schema: { type: 'object', description: 'Self-describing meta response.' } },
        },
      },
      default: {
        description: 'Error (RFC 9457 problem details).',
        content: PROBLEM_CONTENT,
      },
    },
  }
}

export function buildOpenApi(routes: readonly RouteDef[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of routes) {
    // :param → {param}
    const path = route.pattern.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    paths[path] = paths[path] ?? {}
    paths[path][route.method.toLowerCase()] = operation(route)
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'tracer API',
      version: 'v1',
      description:
        'REST middle layer over Grafana Tempo for distributed-system traces: fetch one trace, or correlate matching spans by name + attribute via /compare. GET /api/v1 is the discovery index; GET /api/v1/docs is an agent-oriented guide.',
    },
    servers: [{ url: '/' }],
    paths,
    components: { schemas: SCHEMA_REGISTRY },
  }
}
