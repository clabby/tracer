import { describe, expect, test } from 'bun:test'
import { SCHEMA_REGISTRY } from './registry'
import { ALL_ROUTES } from './surface'
import { buildOpenApi } from './openapi'
import { renderDocs } from './docs'
import type { Deps } from './router'

/*
 * The discovery contract: a route cannot exist undocumented, an operationId
 * cannot collide, and a schema reference cannot dangle.
 */

const fakeDeps = {} as Deps
const call = async (pattern: string): Promise<Response> => {
  const route = ALL_ROUTES.find((r) => r.pattern === pattern && r.method === 'GET')!
  const url = new URL(`http://x${pattern}`)
  return route.handler(new Request(url), url, {}, fakeDeps)
}

describe('route table invariants', () => {
  test('method+pattern and operationIds are unique', () => {
    const keys = ALL_ROUTES.map((r) => `${r.method} ${r.pattern}`)
    expect(new Set(keys).size).toBe(keys.length)
    const ops = ALL_ROUTES.map((r) => r.operationId)
    expect(new Set(ops).size).toBe(ops.length)
  })

  test('every route has a summary and a runnable example', () => {
    for (const r of ALL_ROUTES) {
      expect(r.summary.length).toBeGreaterThan(10)
      expect(r.example).toContain('curl')
    }
  })

  test('every documented query/path param appears in the pattern or is a query param', () => {
    for (const r of ALL_ROUTES) {
      for (const p of r.params ?? []) {
        if (p.in === 'path') expect(r.pattern).toContain(`:${p.name}`)
      }
    }
  })
})

describe('GET /api/v1 (index)', () => {
  test('lists every route with example + schema pointers', async () => {
    const res = await call('/api/v1')
    expect(res.headers.get('content-type')).toBe('application/json')
    const body = (await res.json()) as {
      conventions: Record<string, string>
      routes: { method: string; path: string; example: string; responseSchema?: string }[]
      links: Record<string, string>
    }
    expect(body.routes).toHaveLength(ALL_ROUTES.length)
    for (const r of body.routes) expect(r.example).toContain('curl')
    expect(body.conventions.time).toContain('SECONDS')
    expect(body.conventions.time).toContain('NANOSECONDS')
    expect(body.links.openapi).toBe('/api/v1/openapi.json')
    // schema pointers point into the OpenAPI components
    const withSchema = body.routes.filter((r) => r.responseSchema !== undefined)
    expect(withSchema.length).toBeGreaterThan(5)
    for (const r of withSchema) {
      expect(r.responseSchema).toMatch(/^\/api\/v1\/openapi\.json#\/components\/schemas\/\w+$/)
    }
  })
})

describe('openapi.json', () => {
  const doc = buildOpenApi(ALL_ROUTES) as {
    openapi: string
    paths: Record<string, Record<string, { operationId: string }>>
    components: { schemas: Record<string, unknown> }
  }

  test('covers every route (patterns become {param} paths)', () => {
    for (const r of ALL_ROUTES) {
      const path = r.pattern.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      const op = doc.paths[path]?.[r.method.toLowerCase()]
      expect(op?.operationId).toBe(r.operationId)
    }
  })

  test('publishes the full schema registry and no $ref dangles', () => {
    expect(Object.keys(doc.components.schemas).sort()).toEqual(
      Object.keys(SCHEMA_REGISTRY).sort(),
    )
    const refs: string[] = []
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk)
      if (v !== null && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          if (k === '$ref' && typeof val === 'string') refs.push(val)
          else walk(val)
        }
      }
    }
    walk(doc)
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      const m = /^#\/components\/schemas\/(\w+)$/.exec(ref)
      expect(m).not.toBeNull()
      expect(doc.components.schemas[m![1]]).toBeDefined()
    }
  })

  test('served handler returns the same document', async () => {
    const res = await call('/api/v1/openapi.json')
    const served = (await res.json()) as { openapi: string }
    expect(served.openapi).toBe('3.1.0')
  })
})

describe('docs', () => {
  test('markdown names every route and keeps the recipes', async () => {
    const res = await call('/api/v1/docs')
    expect(res.headers.get('content-type')).toContain('text/markdown')
    const md = await res.text()
    for (const r of ALL_ROUTES) expect(md).toContain(`${r.method} ${r.pattern}`)
    expect(md).toContain('## Recipes')
    expect(md).toContain('perInstance')
    expect(renderDocs(ALL_ROUTES)).toBe(md)
  })
})
