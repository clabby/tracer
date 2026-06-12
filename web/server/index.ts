/*
 * tracer API server — the middle layer between Grafana Tempo and clients
 * (the SPA and agents). One Bun process serves:
 *   /api/v1/*   the REST API (see server/routes.ts),
 *   /tempo/*    a GET-only passthrough to the raw Tempo API (escape hatch),
 *   /*          the built SPA, with index.html fallback for client routing.
 *
 * The Tempo endpoint comes from TEMPO_URL (required; host:port or full URL).
 * The upstream budget is 12s — strictly under the SPA's 15s fetch timeout —
 * so Tempo stalls surface as structured 504s, never opaque client aborts.
 */

import { TempoClient } from '../src/api/tempo'
import { loadConfig, redactTempoUrl } from './config'
import { badRequest, gatewayTimeout, badGateway, internal, methodNotAllowed, notFound } from './problem'
import { resolveRoute, type Deps } from './router'
import { ALL_ROUTES } from './surface'

const UPSTREAM_TIMEOUT_MS = 12_000
const ASSET_CACHE = 'public, max-age=31536000, immutable'

const config = (() => {
  try {
    return loadConfig()
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
})()

const deps: Deps = { tempo: new TempoClient(config.tempoUrl, UPSTREAM_TIMEOUT_MS), config }

const hasStatic =
  config.staticDir !== null && (await Bun.file(`${config.staticDir}/index.html`).exists())

// ---------------------------------------------------------- error mapping --

/** Map a thrown upstream error to problem+json (504 stall / 404 / 502). */
function upstreamProblem(err: unknown, tempoUrl: string): Response {
  const msg = redactTempoUrl(err instanceof Error ? err.message : String(err), tempoUrl)
  if (/timed?\s?out|TimeoutError/i.test(msg)) {
    return gatewayTimeout(`Tempo did not answer within ${UPSTREAM_TIMEOUT_MS / 1000}s: ${msg}`)
  }
  const status = /returned HTTP (\d+)/.exec(msg)
  if (status !== null && status[1] === '404') {
    return notFound(msg, 'The trace id may be wrong, expired from retention, or not yet ingested.')
  }
  return badGateway(msg)
}

// -------------------------------------------------------------------- api --

function withCors(res: Response): Response {
  res.headers.set('access-control-allow-origin', '*')
  return res
}

function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  })
}

function routeHint(): string {
  return `Routes: ${ALL_ROUTES.map((r) => `${r.method} ${r.pattern}`).join(' · ')}`
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight()
  // Bare /api lands on the discovery index.
  const pathname = url.pathname === '/api' || url.pathname === '/api/' ? '/api/v1' : url.pathname
  const { route, params, allowed } = resolveRoute(ALL_ROUTES, req.method, pathname)
  if (route === null) {
    if (allowed.length > 0) {
      return withCors(methodNotAllowed(req.method, url.pathname, allowed))
    }
    return withCors(notFound(`${req.method} ${url.pathname} is not an API route.`, routeHint()))
  }
  try {
    return withCors(await route.handler(req, url, params, deps))
  } catch (err) {
    if (err instanceof Response) return withCors(err) // handlers may throw problems
    return withCors(upstreamProblem(err, config.tempoUrl))
  }
}

// ------------------------------------------------------- tempo passthrough --

async function passthroughTempo(req: Request, url: URL): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed(req.method, url.pathname, ['GET'])
  const upstream = `${config.tempoUrl}${url.pathname.slice('/tempo'.length)}${url.search}`
  let res: Response
  try {
    res = await fetch(upstream, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  } catch (err) {
    return upstreamProblem(err, config.tempoUrl)
  }
  const headers = new Headers()
  const ct = res.headers.get('content-type')
  if (ct !== null) headers.set('content-type', ct)
  return new Response(res.body, { status: res.status, headers })
}

// ----------------------------------------------------------------- static --

async function serveStatic(pathname: string): Promise<Response> {
  if (!hasStatic) {
    return notFound(
      'No UI bundle is present; this deployment serves /api/v1 and /tempo only.',
      'GET /api/v1 describes the API.',
    )
  }
  const dir = config.staticDir as string
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return badRequest('Malformed percent-encoding in path.')
  }
  const fallback = () =>
    new Response(Bun.file(`${dir}/index.html`), { headers: { 'cache-control': 'no-cache' } })
  if (rel === '/' || rel.endsWith('/') || rel.split('/').includes('..')) return fallback()
  const file = Bun.file(`${dir}${rel}`)
  if (!(await file.exists())) return fallback()
  const headers: Record<string, string> = {}
  // Vite emits content-hashed filenames under /assets — cache forever.
  if (rel.startsWith('/assets/')) headers['cache-control'] = ASSET_CACHE
  return new Response(file, { headers })
}

// ------------------------------------------------------------------ serve --

const server = Bun.serve({
  port: config.port,
  // Above the 12s upstream worst case — Bun's 10s default would reset the
  // client mid-stall, hiding the structured 504 the budget exists for.
  idleTimeout: 30,
  // Search/compile bodies are tiny; Bun's 128MB default invites memory DoS
  // on the open POST routes.
  maxRequestBodySize: 1_000_000,
  fetch(req: Request): Promise<Response> | Response {
    const url = new URL(req.url)
    const p = url.pathname
    if (p === '/api' || p.startsWith('/api/')) return handleApi(req, url)
    if (p === '/.well-known/llms.txt') {
      return handleApi(new Request(new URL('/api/v1/docs', url), req), new URL('/api/v1/docs', url))
    }
    if (p === '/tempo' || p.startsWith('/tempo/')) return passthroughTempo(req, url)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return methodNotAllowed(req.method, p, ['GET', 'HEAD'])
    }
    return serveStatic(p)
  },
  error(err: Error): Response {
    return internal(redactTempoUrl(err.message, config.tempoUrl))
  },
})

console.log(
  `tracer api listening on http://localhost:${server.port} ` +
    `(tempo: ${config.tempoUrl}, ui: ${hasStatic ? config.staticDir : 'none'})`,
)
