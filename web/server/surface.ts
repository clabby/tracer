/*
 * The composed API surface: discovery routes (which list the whole table,
 * themselves included) followed by the data routes. This is what the
 * dispatcher serves and what the discovery/OpenAPI/docs renderers describe.
 */

import { makeDiscoveryRoutes } from './discovery'
import type { RouteDef } from './router'
import { ROUTES } from './routes'

export const ALL_ROUTES: RouteDef[] = []
ALL_ROUTES.push(...makeDiscoveryRoutes(() => ALL_ROUTES), ...ROUTES)
