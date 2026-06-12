/*
 * The API surface, in one table. Adding a route here is the ONLY way to
 * expose one — the dispatcher, the /api/v1 discovery index, and
 * /api/v1/openapi.json all render from this list.
 */

import type { RouteDef } from './router'
import { handleHealth } from './misc'

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
]
