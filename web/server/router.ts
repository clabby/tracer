/*
 * Route table machinery. ROUTES (server/routes.ts) is the single description
 * of the API surface: the dispatcher matches against it, and the discovery
 * index + OpenAPI document render from it — routes cannot exist undocumented.
 */

import type { TempoClient } from '../src/api/tempo'
import type { ServerConfig } from './config'
import type { SchemaKey } from './registry'

export interface Deps {
  tempo: TempoClient
  config: ServerConfig
}

export interface RouteParamDoc {
  name: string
  in: 'path' | 'query'
  description: string
  example?: string
}

export interface RouteDef {
  method: 'GET' | 'POST'
  /** Path pattern with `:param` segments, e.g. `/api/v1/traces/:traceId`. */
  pattern: string
  /** Stable OpenAPI operationId, e.g. `searchTraces`. */
  operationId: string
  summary: string
  params?: RouteParamDoc[]
  /** Registry key of the request-body schema (POST only). */
  requestSchema?: SchemaKey
  /** Registry key of the response schema; omitted for self-describing meta routes. */
  responseSchema?: SchemaKey
  /** A runnable curl example, shown in the discovery index. */
  example: string
  handler: (
    req: Request,
    url: URL,
    params: Record<string, string>,
    deps: Deps,
  ) => Promise<Response>
}

/** Match one pattern against a pathname; returns captured params or null. */
export function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const ps = pattern.split('/')
  const xs = pathname.split('/')
  if (ps.length !== xs.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < ps.length; i++) {
    const seg = ps[i]
    if (seg.startsWith(':')) {
      if (xs[i] === '') return null
      try {
        params[seg.slice(1)] = decodeURIComponent(xs[i])
      } catch {
        return null
      }
    } else if (seg !== xs[i]) {
      return null
    }
  }
  return params
}

export interface Resolution {
  route: RouteDef | null
  params: Record<string, string>
  /** Methods that DO match the path, when the method itself did not (405). */
  allowed: string[]
}

export function resolveRoute(routes: readonly RouteDef[], method: string, pathname: string): Resolution {
  const allowed = new Set<string>()
  for (const r of routes) {
    const params = matchPattern(r.pattern, pathname)
    if (params === null) continue
    if (r.method === method) return { route: r, params, allowed: [] }
    allowed.add(r.method)
  }
  return { route: null, params: {}, allowed: [...allowed] }
}

/** A JSON response (API success bodies; errors use problem.ts instead). */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const COMPRESS_MIN_BYTES = 1024

/**
 * Gzip a JSON/text response when the client accepts it (Caddy used to do
 * this for the whole deployment). Small bodies pass through untouched;
 * compressible responses always gain `Vary: accept-encoding`.
 */
export async function withCompression(req: Request, res: Response): Promise<Response> {
  if (res.body === null || res.headers.has('content-encoding')) return res
  const ct = res.headers.get('content-type') ?? ''
  if (!(ct.includes('json') || ct.startsWith('text/'))) return res
  const accept = req.headers.get('accept-encoding') ?? ''
  if (!/(^|[,\s])gzip($|[;,\s])/i.test(accept)) return res
  const buf = new Uint8Array(await res.arrayBuffer())
  const headers = new Headers(res.headers)
  headers.set('vary', 'accept-encoding')
  if (buf.byteLength < COMPRESS_MIN_BYTES) {
    return new Response(buf, { status: res.status, headers })
  }
  headers.set('content-encoding', 'gzip')
  headers.delete('content-length')
  return new Response(Bun.gzipSync(buf), { status: res.status, headers })
}
