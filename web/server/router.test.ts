import { describe, expect, test } from 'bun:test'
import { matchPattern, resolveRoute, type RouteDef } from './router'

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
