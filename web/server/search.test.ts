import { afterEach, describe, expect, test } from 'bun:test'
import { TempoClient } from '../src/api/tempo'
import { buildTraceQL } from '../src/lib/traceql'
import type { SearchTracesResponse, CompileResponse } from '../src/lib/apischema'
import type { Deps } from './router'
import { handleCompile, handleSearchTraces } from './search'

/*
 * Handler tests against a fetch-mocked Tempo: the real TempoClient runs (its
 * windowed fan-out, dedup, and defensive mapping included) — only the HTTP
 * layer is stubbed.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const deps = (): Deps => ({
  tempo: new TempoClient('http://tempo.test', 12_000),
  config: { port: 8080, tempoUrl: 'http://tempo.test', staticDir: null },
})

function mockTempoSearch(traces: unknown[]): { queries: string[] } {
  const seen = { queries: [] as string[] }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    expect(url.pathname).toBe('/api/search')
    seen.queries.push(url.searchParams.get('q') ?? '')
    return new Response(JSON.stringify({ traces }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return seen
}

const rawTrace = (id: string, startMs: number) => ({
  traceID: id,
  rootServiceName: 'node-1',
  rootTraceName: 'round',
  startTimeUnixNano: String(BigInt(startMs) * 1_000_000n),
  durationMs: 12,
  spanSets: [{ matched: 3 }],
  serviceStats: { 'node-1': {}, 'node-2': {} },
})

describe('handleSearchTraces', () => {
  test('GET: maps, dedupes across windows, echoes the compiled TraceQL', async () => {
    // Every window query returns the same two traces — dedup must collapse them.
    const seen = mockTempoSearch([rawTrace('aa11', 2_000), rawTrace('bb22', 1_000)])
    const url = new URL('http://x/api/v1/search/traces?errorsOnly=true&since=15m&limit=10')
    const res = await handleSearchTraces(new Request(url, { method: 'GET' }), url, {}, deps())
    expect(res.status).toBe(200)
    const body = (await res.json()) as SearchTracesResponse

    expect(body.traces.map((t) => t.traceId)).toEqual(['aa11', 'bb22']) // newest-first, deduped
    expect(body.traces[0].services).toEqual(['node-1', 'node-2'])
    expect(body.traces[0].spanCount).toBe(3)
    expect(body.query.traceql).toBe('{ status = error }')
    expect(body.query.limit).toBe(10)
    expect(seen.queries.length).toBeGreaterThan(1) // windowed fan-out happened
    for (const q of seen.queries) expect(q).toBe('{ status = error }')
  })

  test('POST: structured body produces the same query', async () => {
    mockTempoSearch([])
    const url = new URL('http://x/api/v1/search/traces')
    const req = new Request(url, {
      method: 'POST',
      body: JSON.stringify({ filter: { errorsOnly: true }, range: { lastSeconds: 900 } }),
    })
    const body = (await (await handleSearchTraces(req, url, {}, deps())).json()) as SearchTracesResponse
    expect(body.traces).toEqual([])
    expect(body.query.traceql).toBe('{ status = error }')
    expect(body.query.range.to - body.query.range.from).toBe(900)
  })

  test('invalid params throw a 400 problem before any Tempo call', async () => {
    globalThis.fetch = (async () => {
      throw new Error('must not be called')
    }) as unknown as typeof fetch
    const url = new URL('http://x/api/v1/search/traces?limit=banana')
    try {
      await handleSearchTraces(new Request(url), url, {}, deps())
      throw new Error('expected a thrown problem Response')
    } catch (err) {
      expect(err).toBeInstanceOf(Response)
      expect((err as Response).status).toBe(400)
    }
  })
})

describe('handleCompile', () => {
  test('GET compiles the same TraceQL a search would execute', async () => {
    const url = new URL(
      'http://x/api/v1/traceql/compile?service=node-1&minDuration=100ms&attr=span.view%3D5',
    )
    const res = await handleCompile(new Request(url), url, {}, deps())
    const body = (await res.json()) as CompileResponse
    expect(body.target).toBe('spans')
    expect(body.traceql).toBe(
      '{ resource.service.name = "node-1" && duration > 100000000ns && (span.view = 5 || span.view = "5") }',
    )
  })

  test('POST events target matches buildTraceQL', async () => {
    const url = new URL('http://x/api/v1/traceql/compile')
    const req = new Request(url, {
      method: 'POST',
      body: JSON.stringify({ filter: { levels: ['error'] }, target: 'events' }),
    })
    const body = (await (await handleCompile(req, url, {}, deps())).json()) as CompileResponse
    expect(body.target).toBe('events')
    expect(body.traceql).toBe(
      buildTraceQL(
        {
          services: [],
          name: '',
          nameIsRegex: true,
          levels: ['error'],
          attrs: [],
          minDuration: '',
          maxDuration: '',
          errorsOnly: false,
          rawQuery: '',
          limit: 50,
        },
        'events',
      ),
    )
  })
})
