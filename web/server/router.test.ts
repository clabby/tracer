import { describe, expect, test } from 'bun:test'
import { json, matchPattern, resolveRoute, withCompression, type RouteDef } from './router'

const stub = (method: 'GET' | 'POST', pattern: string): RouteDef => ({
  method,
  pattern,
  operationId: pattern,
  summary: '',
  responseSchema: 'healthResponseSchema',
  example: '',
  handler: async () => new Response(),
})

describe('matchPattern', () => {
  test('literal segments', () => {
    expect(matchPattern('/api/v1/health', '/api/v1/health')).toEqual({})
    expect(matchPattern('/api/v1/health', '/api/v1/nope')).toBeNull()
    expect(matchPattern('/api/v1/health', '/api/v1/health/extra')).toBeNull()
  })

  test(':params capture and decode', () => {
    expect(matchPattern('/api/v1/traces/:traceId', '/api/v1/traces/abc123')).toEqual({
      traceId: 'abc123',
    })
    expect(
      matchPattern('/api/v1/tags/:scope/:tag/values', '/api/v1/tags/resource/service.name/values'),
    ).toEqual({ scope: 'resource', tag: 'service.name' })
    expect(matchPattern('/api/v1/tags/:scope/:tag/values', '/api/v1/tags/span/my%20key/values')).toEqual(
      { scope: 'span', tag: 'my key' },
    )
  })

  test('empty segments never match a :param', () => {
    expect(matchPattern('/api/v1/traces/:traceId', '/api/v1/traces/')).toBeNull()
  })
})

describe('resolveRoute', () => {
  const routes = [stub('GET', '/api/v1/search/traces'), stub('POST', '/api/v1/search/traces')]

  test('matches on method + path', () => {
    expect(resolveRoute(routes, 'GET', '/api/v1/search/traces').route).toBe(routes[0])
    expect(resolveRoute(routes, 'POST', '/api/v1/search/traces').route).toBe(routes[1])
  })

  test('reports allowed methods when only the method mismatches', () => {
    const r = resolveRoute(routes, 'PUT', '/api/v1/search/traces')
    expect(r.route).toBeNull()
    expect(r.allowed.sort()).toEqual(['GET', 'POST'])
  })

  test('no match at all → empty allowed', () => {
    const r = resolveRoute(routes, 'GET', '/api/v1/nope')
    expect(r.route).toBeNull()
    expect(r.allowed).toEqual([])
  })
})

describe('withCompression', () => {
  const big = { data: 'x'.repeat(4096) }
  const gzipReq = (accept = 'gzip, deflate, br') =>
    new Request('http://x/api/v1', { headers: { 'accept-encoding': accept } })

  test('gzips large JSON when the client accepts gzip', async () => {
    const res = await withCompression(gzipReq(), json(big))
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('vary')).toBe('accept-encoding')
    const raw = new Uint8Array(await res.arrayBuffer())
    expect(raw.byteLength).toBeLessThan(1024)
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(raw)))).toEqual(big)
  })

  test('passes through without accept-encoding gzip', async () => {
    const res = await withCompression(gzipReq('br'), json(big))
    expect(res.headers.get('content-encoding')).toBeNull()
    expect((await res.json()) as unknown).toEqual(big)
  })

  test('small bodies skip compression but gain Vary', async () => {
    const res = await withCompression(gzipReq(), json({ ok: true }))
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('vary')).toBe('accept-encoding')
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true })
  })

  test('non-text content types are untouched', async () => {
    const res = await withCompression(
      gzipReq(),
      new Response(new Uint8Array(4096), { headers: { 'content-type': 'application/octet-stream' } }),
    )
    expect(res.headers.get('content-encoding')).toBeNull()
  })
})
