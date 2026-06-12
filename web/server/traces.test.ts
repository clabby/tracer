import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { TempoClient } from '../src/api/tempo'
import { parseTrace } from '../src/lib/trace'
import { hydrateTrace, type WireTrace } from '../src/lib/wire'
import type { AggregateResponse, TraceOverview, ApiProblem } from '../src/lib/apischema'
import type { Deps } from './router'
import { clearTraceCache, handleTrace, handleTraceAggregate, handleTraceSummary } from './traces'
import { handleTagNames, handleTagValues } from './tags'

const TRACE_HEX = '0af7651916cd43dd8448eb211c80319c'
const T0 = 1749571200000000000n
const at = (offsetNs: number): string => (T0 + BigInt(offsetNs)).toString()
const sattr = (key: string, stringValue: string) => ({ key, value: { stringValue } })

/*
 * Two-node fixture: node-2's "verify" span is a child of node-1's root (a
 * cross-instance parent link), and node-2's root errors — exercises instance
 * scoping, link severing, and error rollups.
 */
const OTLP = {
  trace: {
    resourceSpans: [
      {
        resource: { attributes: [sattr('service.name', 'node-1')] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE_HEX,
                spanId: 'aaaaaaaaaaaa0001',
                name: 'round',
                startTimeUnixNano: at(0),
                endTimeUnixNano: at(1000),
              },
            ],
          },
        ],
      },
      {
        resource: { attributes: [sattr('service.name', 'node-2')] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE_HEX,
                spanId: 'aaaaaaaaaaaa0002',
                name: 'round',
                startTimeUnixNano: at(100),
                endTimeUnixNano: at(2100),
                status: { code: 2, message: 'boom' },
              },
              {
                traceId: TRACE_HEX,
                spanId: 'bbbbbbbbbbbb0002',
                parentSpanId: 'aaaaaaaaaaaa0001', // cross-instance parent
                name: 'verify',
                startTimeUnixNano: at(150),
                endTimeUnixNano: at(650),
              },
            ],
          },
        ],
      },
    ],
  },
}

const realFetch = globalThis.fetch
let fetchCount = 0

beforeEach(() => {
  clearTraceCache()
  fetchCount = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCount++
    const url = new URL(String(input))
    if (url.pathname.startsWith('/api/v2/traces/')) {
      return new Response(JSON.stringify(OTLP), { headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const deps = (): Deps => ({
  tempo: new TempoClient('http://tempo.test', 12_000),
  config: { port: 8080, tempoUrl: 'http://tempo.test', staticDir: null },
})

const get = async <T>(
  handler: typeof handleTrace,
  path: string,
  params: Record<string, string>,
): Promise<{ status: number; body: T; headers: Headers }> => {
  const url = new URL(`http://x${path}`)
  const res = await handler(new Request(url), url, params, deps())
  return { status: res.status, body: (await res.json()) as T, headers: res.headers }
}

describe('handleTrace', () => {
  test('serves a wire trace that hydrates back to the exact parse', async () => {
    const { status, body, headers } = await get<WireTrace>(
      handleTrace,
      `/api/v1/traces/${TRACE_HEX}`,
      { traceId: TRACE_HEX.toUpperCase() }, // mixed case input normalizes
    )
    expect(status).toBe(200)
    expect(headers.get('cache-control')).toBe('public, max-age=15')
    expect(hydrateTrace(body)).toEqual(parseTrace(OTLP, TRACE_HEX))
    expect(body.instances.map((i) => i.id)).toEqual(['node-1', 'node-2'])
    expect(body.instances[1].errorCount).toBe(1)
  })

  test('?instance= scopes spans and severs cross-instance child links', async () => {
    const { body } = await get<WireTrace>(
      handleTrace,
      `/api/v1/traces/${TRACE_HEX}?instance=node-1`,
      { traceId: TRACE_HEX },
    )
    expect(body.instances.map((i) => i.id)).toEqual(['node-1'])
    expect(body.spans.map((s) => s.spanId)).toEqual(['aaaaaaaaaaaa0001'])
    // node-1's root had node-2's verify as a child — severed, not dangling.
    expect(body.spans[0].childSpanIds).toEqual([])
  })

  test('unknown ?instance= 400s naming the valid ids', async () => {
    const url = new URL(`http://x/api/v1/traces/${TRACE_HEX}?instance=node-9`)
    try {
      await handleTrace(new Request(url), url, { traceId: TRACE_HEX }, deps())
      throw new Error('expected a problem Response')
    } catch (err) {
      expect(err).toBeInstanceOf(Response)
      const p = (await (err as Response).json()) as ApiProblem
      expect((err as Response).status).toBe(400)
      expect(p.invalidParams?.[0].reason).toContain('node-1')
      expect(p.invalidParams?.[0].reason).toContain('node-2')
    }
  })

  test('the TTL cache absorbs repeat loads (one Tempo fetch)', async () => {
    await get<WireTrace>(handleTrace, `/api/v1/traces/${TRACE_HEX}`, { traceId: TRACE_HEX })
    await get<TraceOverview>(handleTraceSummary, `/api/v1/traces/${TRACE_HEX}/summary`, {
      traceId: TRACE_HEX,
    })
    await get<AggregateResponse>(handleTraceAggregate, `/api/v1/traces/${TRACE_HEX}/aggregate`, {
      traceId: TRACE_HEX,
    })
    expect(fetchCount).toBe(1)
  })
})

describe('handleTraceSummary', () => {
  test('per-instance rollups without span payload', async () => {
    const { body } = await get<TraceOverview>(
      handleTraceSummary,
      `/api/v1/traces/${TRACE_HEX}/summary`,
      { traceId: TRACE_HEX },
    )
    expect(body.spanCount).toBe(3)
    expect(body.eventCount).toBe(0)
    expect(body.durationNs).toBe(2100)
    const node2 = body.instances.find((i) => i.id === 'node-2')!
    expect(node2.errorCount).toBe(1)
    expect(node2.earliestStartNs).toBe(100)
    expect(node2.latestEndNs).toBe(2100)
    expect('spans' in body).toBe(false)
  })
})

describe('handleTraceAggregate', () => {
  test('per-instance stats per path; pre-order; no spanIds by default', async () => {
    const { body } = await get<AggregateResponse>(
      handleTraceAggregate,
      `/api/v1/traces/${TRACE_HEX}/aggregate`,
      { traceId: TRACE_HEX },
    )
    expect(body.instances).toEqual(['node-1', 'node-2'])
    const round = body.nodes.find((n) => n.path.length === 1 && n.name === 'round')!
    expect(round.count).toBe(2)
    expect(round.perInstance['node-1']).toEqual({
      count: 1, minNs: 1000, maxNs: 1000, meanNs: 1000, totalNs: 1000, errorCount: 0,
    })
    expect(round.perInstance['node-2']).toEqual({
      count: 1, minNs: 2000, maxNs: 2000, meanNs: 2000, totalNs: 2000, errorCount: 1,
    })
    expect(round.spanIds).toBeUndefined()
    // verify rides under node-1's root in the merged tree (cross-instance child)
    const verify = body.nodes.find((n) => n.name === 'verify')!
    expect(verify.path).toEqual(['round', 'verify'])
    expect(verify.depth).toBe(1)
    // pre-order: parent before child
    expect(body.nodes.indexOf(round)).toBeLessThan(body.nodes.indexOf(verify))
  })

  test('?instance= scoping and ?spanIds=true', async () => {
    const { body } = await get<AggregateResponse>(
      handleTraceAggregate,
      `/api/v1/traces/${TRACE_HEX}/aggregate?instance=node-2&spanIds=true`,
      { traceId: TRACE_HEX },
    )
    expect(body.instances).toEqual(['node-2'])
    const round = body.nodes.find((n) => n.name === 'round')!
    expect(round.perInstance['node-1']).toBeUndefined()
    expect(round.spanIds).toEqual({ 'node-2': ['aaaaaaaaaaaa0002'] })
  })
})

describe('tag handlers', () => {
  test('names + values delegate to the shared client (v2 shapes)', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v2/search/tags') {
        return Response.json({ scopes: [{ name: 'span', tags: ['view', 'height', 'view'] }] })
      }
      if (url.pathname.startsWith('/api/v2/search/tag/')) {
        return Response.json({ tagValues: [{ type: 'string', value: 'node-2' }, { type: 'string', value: 'node-1' }] })
      }
      return new Response('nope', { status: 404 })
    }) as unknown as typeof fetch

    let url = new URL('http://x/api/v1/tags/span')
    let res = await handleTagNames(new Request(url), url, { scope: 'span' }, deps())
    expect(await res.json()).toEqual({ scope: 'span', names: ['height', 'view'] })

    url = new URL('http://x/api/v1/tags/resource/service.name/values')
    res = await handleTagValues(new Request(url), url, { scope: 'resource', tag: 'service.name' }, deps())
    expect(await res.json()).toEqual({ tag: 'service.name', scope: 'resource', values: ['node-1', 'node-2'] })
  })

  test('bad scope 400s with the valid scopes', async () => {
    const url = new URL('http://x/api/v1/tags/bogus')
    try {
      await handleTagNames(new Request(url), url, { scope: 'bogus' }, deps())
      throw new Error('expected a problem Response')
    } catch (err) {
      expect(err).toBeInstanceOf(Response)
      expect((err as Response).status).toBe(400)
    }
  })
})
