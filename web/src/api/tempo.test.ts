import { afterEach, describe, expect, test } from 'bun:test'
import { TempoClient } from './tempo'

/*
 * The v2→v1 fallback shares ONE deadline: a stalling Tempo must cost at most
 * ~one timeout budget in total, never two stacked timeouts — the API
 * server's 12s upstream budget under the SPA's 15s depends on it.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** A Tempo that never answers; rejects only when the signal aborts. */
function stallingFetch(calls: string[]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    calls.push(new URL(String(input)).pathname)
    return new Promise((_, reject) => {
      const signal = init?.signal
      if (signal == null) return
      const onAbort = () => reject(signal.reason ?? new Error('aborted'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }) as unknown as typeof fetch
}

describe('TempoClient fallback deadline', () => {
  test('fetchTrace: total stall cost stays within ~one budget, v1 skipped when spent', async () => {
    const calls: string[] = []
    globalThis.fetch = stallingFetch(calls)
    const client = new TempoClient('http://tempo.test', 300)
    const t0 = Date.now()
    await expect(client.fetchTrace('abc123')).rejects.toThrow(/failed/)
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(550) // one 300ms budget + slack, NOT 600ms
    expect(calls).toEqual(['/api/v2/traces/abc123']) // budget spent → no v1 attempt
  })

  test('fetchTrace: fast v2 failure leaves budget for the v1 fallback', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      calls.push(path)
      if (path.startsWith('/api/v2/')) return new Response('nope', { status: 500 })
      return Response.json({ batches: [] })
    }) as unknown as typeof fetch
    const client = new TempoClient('http://tempo.test', 300)
    const model = await client.fetchTrace('abc123')
    expect(calls).toEqual(['/api/v2/traces/abc123', '/api/traces/abc123'])
    expect(model.spans.size).toBe(0)
  })

  test('tagValues: same shared-deadline contract', async () => {
    const calls: string[] = []
    globalThis.fetch = stallingFetch(calls)
    const client = new TempoClient('http://tempo.test', 300)
    const t0 = Date.now()
    await expect(client.tagValues('service.name', 'resource')).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(550)
    expect(calls).toHaveLength(1)
  })
})

describe('TempoClient tag names', () => {
  test('filters tag names by span name context through Tempo TraceQL q', async () => {
    let seen = new URL('http://tempo.test/unseen')
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen = new URL(String(input))
      return Response.json({ scopes: [{ name: 'span', tags: ['role', 'height'] }] })
    }) as unknown as typeof fetch

    const client = new TempoClient('http://tempo.test')
    const names = await client.tagNames('span', 'he', {
      target: 'spans',
      name: 'round',
      nameIsRegex: false,
    })

    expect(seen.pathname).toBe('/api/v2/search/tags')
    expect(seen.searchParams.get('scope')).toBe('span')
    expect(seen.searchParams.get('q')).toBe('{ name = "round" }')
    expect(names).toEqual(['height'])
  })

  test('filters tag names by event name context when searching events', async () => {
    let seen = new URL('http://tempo.test/unseen')
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen = new URL(String(input))
      return Response.json({ scopes: [{ name: 'event', tags: ['from.node'] }] })
    }) as unknown as typeof fetch

    const client = new TempoClient('http://tempo.test')
    await client.tagNames('event', undefined, {
      target: 'events',
      name: 'commit',
      nameIsRegex: true,
    })

    expect(seen.searchParams.get('q')).toBe('{ event:name =~ ".*(commit).*" }')
  })
})
