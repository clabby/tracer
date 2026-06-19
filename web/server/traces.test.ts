import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { TempoClient } from '../src/api/tempo'
import { parseTrace } from '../src/lib/trace'
import { hydrateTrace, type WireTrace } from '../src/lib/wire'
import type { AggregateResponse, TraceOverview, ApiProblem } from '../src/lib/apischema'
import type { Deps } from './router'
import {
  clearTraceCache,
  handleCompare,
  handleCompareAggregate,
  handleTrace,
  handleTraceSummary,
} from './traces'
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

  test('rejects unknown query params (e.g. instance)', async () => {
    const url = new URL(`http://x/api/v1/traces/${TRACE_HEX}?instance=node-1`)
    try {
      await handleTrace(new Request(url), url, { traceId: TRACE_HEX }, deps())
      throw new Error('expected a problem Response')
    } catch (err) {
      expect(err).toBeInstanceOf(Response)
      expect((err as Response).status).toBe(400)
      const p = (await (err as Response).json()) as ApiProblem
      expect(p.invalidParams?.[0].name).toBe('instance')
    }
  })

  test('the TTL cache absorbs repeat loads (one Tempo fetch) and reports Age', async () => {
    await get<WireTrace>(handleTrace, `/api/v1/traces/${TRACE_HEX}`, { traceId: TRACE_HEX })
    const { headers } = await get<TraceOverview>(
      handleTraceSummary,
      `/api/v1/traces/${TRACE_HEX}/summary`,
      { traceId: TRACE_HEX },
    )
    await get<WireTrace>(handleTrace, `/api/v1/traces/${TRACE_HEX}`, { traceId: TRACE_HEX })
    expect(fetchCount).toBe(1)
    // Age must be present so max-age=15 doesn't restart downstream.
    expect(Number.isInteger(Number(headers.get('age')))).toBe(true)
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

// Two SEPARATE node traces, each with a `round` span (height=42)
// at a DIFFERENT absolute offset — exercises rebasing and id-prefixing.
const COMPARE_SEARCH = {
  traces: [
    {
      traceID: 'aa01',
      startTimeUnixNano: at(1000),
      spanSets: [
        { matched: 1, spans: [{ spanID: 'cccccccccccc0001', name: 'round', attributes: [] }] },
      ],
    },
    {
      traceID: 'bb02',
      startTimeUnixNano: at(2000),
      spanSets: [
        { matched: 1, spans: [{ spanID: 'cccccccccccc0002', name: 'round', attributes: [] }] },
      ],
    },
  ],
}

const nodeOtlp = (
  service: string,
  traceId: string,
  rootId: string,
  viewId: string,
  voteId: string,
  viewOff: number,
  viewDur: number,
) => ({
  resourceSpans: [
    {
      resource: { attributes: [sattr('service.name', service)] },
      scopeSpans: [
        {
          spans: [
            { traceId, spanId: rootId, name: 'process', startTimeUnixNano: at(0), endTimeUnixNano: at(9_000_000) },
            {
              traceId,
              spanId: viewId,
              parentSpanId: rootId,
              name: 'round',
              startTimeUnixNano: at(viewOff),
              endTimeUnixNano: at(viewOff + viewDur),
              attributes: [sattr('height', '42')],
            },
            {
              traceId,
              spanId: voteId,
              parentSpanId: viewId,
              name: 'vote',
              startTimeUnixNano: at(viewOff + 5),
              endTimeUnixNano: at(viewOff + 5 + Math.floor(viewDur / 2)),
            },
          ],
        },
      ],
    },
  ],
})

// view offsets are whole ms so the cross-trace alignment math is exact; both
// traces share t0 (process @ 0), so node-2 enters the view 2ms after node-1.
const NODE1_OTLP = nodeOtlp('node-1', 'aa01', 'aaaa0000aaaa0001', 'cccccccccccc0001', 'dddd0000dddd0001', 1_000_000, 400_000)
const NODE2_OTLP = nodeOtlp('node-2', 'bb02', 'aaaa0000aaaa0002', 'cccccccccccc0002', 'dddd0000dddd0002', 3_000_000, 600_000)
const SHARED_TRACE_OTLP = {
  resourceSpans: [
    ...NODE1_OTLP.resourceSpans,
    ...nodeOtlp('node-2', 'aa01', 'aaaa0000aaaa0002', 'cccccccccccc0002', 'dddd0000dddd0002', 3_000_000, 600_000).resourceSpans,
  ],
}

describe('handleCompare', () => {
  let lastSearchUrl: URL | null = null

  beforeEach(() => {
    lastSearchUrl = null
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/search') {
        lastSearchUrl = url
        return Response.json(COMPARE_SEARCH)
      }
      if (url.pathname === '/api/v2/traces/aa01') return Response.json(NODE1_OTLP)
      if (url.pathname === '/api/v2/traces/bb02') return Response.json(NODE2_OTLP)
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
  })

  const compare = (query: string) =>
    get<WireTrace>(handleCompare, `/api/v1/compare?${query}`, {})

  test('assembles each node onto a shared axis anchored at the earliest start', async () => {
    const { status, body } = await compare(
      'name=round&nameRegex=false&attr=span.height%3D42&from=1749571100&to=1749571300',
    )
    expect(status).toBe(200)
    expect(body.traceId).toBe('compare')
    // origin = earliest matched start (node-1's view, 1ms into its trace)
    expect(body.startUnixMs).toBe(Number(T0 / 1_000_000n) + 1)
    expect(body.instances.map((i) => i.id)).toEqual(['node-1', 'node-2'])

    const rootOf = (id: string) =>
      body.spans.find((s) => s.spanId === body.instances.find((i) => i.id === id)!.rootSpanIds[0])!
    for (const id of ['node-1', 'node-2']) {
      const root = rootOf(id)
      expect(root.name).toBe('round')
      expect(root.parentSpanId).toBeNull()
      expect(root.instanceId).toBe(id)
    }
    // node-1 anchors the axis; node-2 entered 2ms later and is shifted right
    expect(rootOf('node-1').startNs).toBe(0)
    expect(rootOf('node-2').startNs).toBe(2_000_000)

    // Ids are prefixed per-match so the two source traces' identical ids never collide.
    expect(rootOf('node-1').spanId).not.toBe(rootOf('node-2').spanId)
    expect(new Set(body.spans.map((s) => s.spanId)).size).toBe(body.spans.length)
    // process roots are dropped; only each view subtree (view + vote) survives.
    expect(body.spans.map((s) => s.name).sort()).toEqual([
      'round',
      'round',
      'vote',
      'vote',
    ])
    // extent = origin to node-2's late (2ms) 0.6ms view end
    expect(body.durationNs).toBe(2_600_000)

    // The wire trace hydrates back into a usable model.
    const model = hydrateTrace(body)
    expect(model.instances).toHaveLength(2)
  })

  test('compare searches broadly even when the UI result limit is small', async () => {
    const { body } = await compare(
      'name=round&nameRegex=false&attr=span.height%3D42&from=1749571100&to=1749571300&limit=1',
    )
    expect(body.instances.map((i) => i.id)).toEqual(['node-1', 'node-2'])
    expect(lastSearchUrl?.searchParams.get('limit')).toBe('1000')
    expect(lastSearchUrl?.searchParams.get('spss')).toBe('100')
  })

  test('compare does not assemble multiple node matches from one trace id', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/search') {
        return Response.json({
          traces: [
            {
              traceID: 'aa01',
              startTimeUnixNano: at(1000),
              spanSets: [
                {
                  matched: 2,
                  spans: [
                    { spanID: 'cccccccccccc0001', name: 'round', attributes: [] },
                    { spanID: 'cccccccccccc0002', name: 'round', attributes: [] },
                  ],
                },
              ],
            },
          ],
        })
      }
      if (url.pathname === '/api/v2/traces/aa01') return Response.json(SHARED_TRACE_OTLP)
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const { body } = await compare(
      'name=round&nameRegex=false&attr=span.height%3D42&from=1749571100&to=1749571300',
    )
    expect(body.instances).toEqual([])
    expect(body.warnings.some((w) => w.includes('correlates one matching span per node trace'))).toBe(true)
  })

  test('compare/aggregate gives per-node code-path stats over the assembly', async () => {
    const { status, body } = await get<AggregateResponse>(
      handleCompareAggregate,
      '/api/v1/compare/aggregate?name=round&nameRegex=false&attr=span.height%3D42&from=1749571100&to=1749571300&spanIds=true',
      {},
    )
    expect(status).toBe(200)
    expect(body.instances).toEqual(['node-1', 'node-2'])
    const view = body.nodes.find((n) => n.name === 'round')!
    expect(view.depth).toBe(0)
    expect(view.count).toBe(2)
    expect(view.perInstance['node-1'].maxNs).toBe(400_000)
    expect(view.perInstance['node-2'].maxNs).toBe(600_000)
    // spanIds=true surfaces the prefixed matched ids (one per node, prefix per match)
    expect(view.spanIds!['node-1']).toHaveLength(1)
    expect(view.spanIds!['node-1'][0].endsWith('cccccccccccc0001')).toBe(true)
    // vote rides under the view in the merged tree
    const vote = body.nodes.find((n) => n.name === 'vote')!
    expect(vote.path).toEqual(['round', 'vote'])
    expect(vote.depth).toBe(1)
  })

  test('event compare assembles the owning spans', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/search') {
        return Response.json({
          traces: [
            {
              traceID: 'aa01',
              startTimeUnixNano: at(1000),
              spanSets: [{
                matched: 1,
                spans: [{
                  spanID: 'cccccccccccc0001',
                  name: 'round',
                  startTimeUnixNano: at(1_000_000),
                  durationNanos: '400000',
                  attributes: [sattr('event:name', 'commit.done'), sattr('service.name', 'node-1')],
                }],
              }],
            },
            {
              traceID: 'bb02',
              startTimeUnixNano: at(2000),
              spanSets: [{
                matched: 1,
                spans: [{
                  spanID: 'cccccccccccc0002',
                  name: 'round',
                  startTimeUnixNano: at(3_000_000),
                  durationNanos: '600000',
                  attributes: [sattr('event:name', 'commit.done'), sattr('service.name', 'node-2')],
                }],
              }],
            },
          ],
        })
      }
      if (url.pathname === '/api/v2/traces/aa01') return Response.json(NODE1_OTLP)
      if (url.pathname === '/api/v2/traces/bb02') return Response.json(NODE2_OTLP)
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const { body } = await compare(
      'target=events&name=commit.done&nameRegex=false&attr=span.height%3D42&from=1749571100&to=1749571300',
    )
    expect(body.instances.map((i) => i.id)).toEqual(['node-1', 'node-2'])
    expect(body.spans.filter((s) => s.name === 'round')).toHaveLength(2)
  })

  test('no spans matched: empty model carries a warning, not an error', async () => {
    globalThis.fetch = (async () => Response.json({ traces: [] })) as unknown as typeof fetch
    const { status, body } = await compare(
      'name=nope&nameRegex=false&attr=span.height%3D42&from=1749571100&to=1749571300',
    )
    expect(status).toBe(200)
    expect(body.instances).toEqual([])
    expect(body.warnings.some((w) => w.includes('no spans matched'))).toBe(true)
  })

  test('a span to correlate on is required (400 otherwise)', async () => {
    const url = new URL('http://x/api/v1/compare?from=1749571100&to=1749571300')
    try {
      await handleCompare(new Request(url), url, {}, deps())
      throw new Error('expected a problem Response')
    } catch (err) {
      expect(err).toBeInstanceOf(Response)
      expect((err as Response).status).toBe(400)
      const p = (await (err as Response).json()) as ApiProblem
      expect(p.invalidParams?.[0].name).toBe('name')
    }
  })

  test('an exact name and pinning span attribute are required', async () => {
    const cases = [
      ['name=round&attr=span.height%3D42&from=1749571100&to=1749571300', 'nameRegex'],
      ['name=round&nameRegex=false&from=1749571100&to=1749571300', 'attr'],
      ['q=%7Bname%3D%22round%22%7D&from=1749571100&to=1749571300', 'q'],
    ]
    for (const [query, field] of cases) {
      const url = new URL(`http://x/api/v1/compare?${query}`)
      try {
        await handleCompare(new Request(url), url, {}, deps())
        throw new Error('expected a problem Response')
      } catch (err) {
        expect(err).toBeInstanceOf(Response)
        expect((err as Response).status).toBe(400)
        const p = (await (err as Response).json()) as ApiProblem
        expect(p.invalidParams?.some((ip) => ip.name === field)).toBe(true)
      }
    }
  })
})

describe('tag handlers', () => {
  test('names + values delegate to the shared client (v2 shapes)', async () => {
    let tagNamesUrl = new URL('http://tempo.test/unseen')
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v2/search/tags') {
        tagNamesUrl = url
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
    expect(tagNamesUrl.searchParams.get('q')).toBe(null)

    url = new URL('http://x/api/v1/tags/span?name=round&nameRegex=false&q=he')
    res = await handleTagNames(new Request(url), url, { scope: 'span' }, deps())
    expect(await res.json()).toEqual({ scope: 'span', names: ['height'] })
    expect(tagNamesUrl.searchParams.get('q')).toBe('{ name = "round" }')

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
