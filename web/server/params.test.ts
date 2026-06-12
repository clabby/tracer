import { describe, expect, test } from 'bun:test'
import type { ApiProblem } from '../src/lib/apischema'
import { parseSearchBody, parseSearchQuery } from './params'

const u = (qs: string) => new URL(`http://x/api/v1/search/traces?${qs}`)

/** Run a parse that should throw a problem Response; return its body. */
async function expectProblem(fn: () => unknown): Promise<ApiProblem> {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(Response)
    const res = err as Response
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    return (await res.json()) as ApiProblem
  }
  throw new Error('expected a problem Response to be thrown')
}

describe('parseSearchQuery: filter fields', () => {
  test('defaults: empty filter, last 15 minutes, limit 50', () => {
    const { filter, range } = parseSearchQuery(u(''))
    expect(filter.services).toEqual([])
    expect(filter.name).toBe('')
    expect(filter.nameIsRegex).toBe(true)
    expect(filter.limit).toBe(50)
    expect(range.to - range.from).toBe(15 * 60)
  })

  test('repeatable service/level, scalars, raw q', () => {
    const { filter } = parseSearchQuery(
      u('service=node-1&service=node-2&level=error&level=warn&name=verify&nameRegex=false&errorsOnly=true&minDuration=150ms&maxDuration=2s&q=%7B%7D&limit=10'),
    )
    expect(filter.services).toEqual(['node-1', 'node-2'])
    expect(filter.levels).toEqual(['error', 'warn'])
    expect(filter.name).toBe('verify')
    expect(filter.nameIsRegex).toBe(false)
    expect(filter.errorsOnly).toBe(true)
    expect(filter.minDuration).toBe('150ms')
    expect(filter.maxDuration).toBe('2s')
    expect(filter.rawQuery).toBe('{}')
    expect(filter.limit).toBe(10)
  })

  test('attr expressions: every operator, value with =', () => {
    const { filter } = parseSearchQuery(
      u('attr=span.view%3Dnotarization&attr=resource.service.name!~node-.*&attr=span.height>%3D42&attr=event.msg%3Da%3Db'),
    )
    expect(filter.attrs.map((a) => [a.scope, a.key, a.op, a.value])).toEqual([
      ['span', 'view', '=', 'notarization'],
      ['resource', 'service.name', '!~', 'node-.*'],
      ['span', 'height', '>=', '42'],
      ['event', 'msg', '=', 'a=b'],
    ])
  })

  test('unknown parameter is named in the problem', async () => {
    const p = await expectProblem(() => parseSearchQuery(u('servce=node-1')))
    expect(p.invalidParams?.map((i) => i.name)).toEqual(['servce'])
    expect(p.invalidParams?.[0].reason).toContain('known:')
  })

  test('bad level / bad attr / bad limit each reported with examples', async () => {
    const p = await expectProblem(() =>
      parseSearchQuery(u('level=fatal&attr=bogus&limit=99999')),
    )
    const names = p.invalidParams?.map((i) => i.name)
    expect(names).toEqual(['level', 'attr', 'limit'])
    for (const ip of p.invalidParams ?? []) expect(ip.example).toBeTruthy()
  })
})

describe('parseSearchQuery: range', () => {
  test('since resolves relative to now', () => {
    const before = Math.floor(Date.now() / 1000)
    const { range } = parseSearchQuery(u('since=1h'))
    expect(range.to - range.from).toBe(3600)
    expect(range.to).toBeGreaterThanOrEqual(before)
  })

  test('absolute from/to pass through (unix seconds)', () => {
    const { range } = parseSearchQuery(u('from=1765400000&to=1765403600'))
    expect(range).toEqual({ from: 1765400000, to: 1765403600 })
  })

  test('degenerate from == to is accepted (empty window, not a 400)', () => {
    const { range } = parseSearchQuery(u('from=1765400000&to=1765400000'))
    expect(range).toEqual({ from: 1765400000, to: 1765400000 })
    const { range: r2 } = parseSearchBody({ range: { from: 1765400000, to: 1765400000 } })
    expect(r2).toEqual({ from: 1765400000, to: 1765400000 })
  })

  test('since + from is rejected', async () => {
    const p = await expectProblem(() => parseSearchQuery(u('since=15m&from=1765400000&to=1765403600')))
    expect(p.invalidParams?.[0].name).toBe('since')
  })

  test('from without to / inverted bounds rejected', async () => {
    await expectProblem(() => parseSearchQuery(u('from=1765400000')))
    const p = await expectProblem(() => parseSearchQuery(u('from=5&to=2')))
    expect(p.invalidParams?.[0].name).toBe('from')
  })
})

describe('parseSearchBody', () => {
  test("the SPA's full FilterState round-trips", () => {
    const { filter, range } = parseSearchBody({
      filter: {
        services: ['node-1'],
        name: 'verify',
        nameIsRegex: true,
        levels: ['error'],
        attrs: [{ id: 'x1', scope: 'span', key: 'view', op: '=', value: '5' }],
        minDuration: '100ms',
        maxDuration: '',
        errorsOnly: false,
        rawQuery: '',
        limit: 25,
      },
      range: { from: 100, to: 200 },
    })
    expect(filter.services).toEqual(['node-1'])
    expect(filter.attrs).toEqual([{ id: 'x1', scope: 'span', key: 'view', op: '=', value: '5' }])
    expect(filter.limit).toBe(25)
    expect(range).toEqual({ from: 100, to: 200 })
  })

  test('partial filter fills defaults; missing attr id is tolerated', () => {
    const { filter } = parseSearchBody({
      filter: { errorsOnly: true, attrs: [{ scope: 'span', key: 'view', op: '=', value: '5' }] },
    })
    expect(filter.errorsOnly).toBe(true)
    expect(filter.limit).toBe(50)
    expect(filter.attrs[0].id).toBeTruthy()
  })

  test('lastSeconds range resolves against the server clock', () => {
    const before = Math.floor(Date.now() / 1000)
    const { range } = parseSearchBody({ range: { lastSeconds: 900 } })
    expect(range.to - range.from).toBe(900)
    expect(range.to).toBeGreaterThanOrEqual(before)
  })

  test('unknown body/filter/range fields are each named', async () => {
    const p = await expectProblem(() =>
      parseSearchBody({ bogus: 1, filter: { nope: true }, range: { last: 900 } }),
    )
    expect(p.invalidParams?.map((i) => i.name).sort()).toEqual(['bogus', 'filter.nope', 'range.last'])
  })

  test('unknown attr-object keys are rejected (additionalProperties: false)', async () => {
    const p = await expectProblem(() =>
      parseSearchBody({
        filter: { attrs: [{ scope: 'span', key: 'view', op: '=', value: '5', bogus: 1 }] },
      }),
    )
    expect(p.invalidParams?.[0].name).toBe('filter.attrs[0].bogus')
  })

  test('lastSeconds + from/to rejected; bad attrs rejected per index', async () => {
    let p = await expectProblem(() => parseSearchBody({ range: { lastSeconds: 900, from: 1, to: 2 } }))
    expect(p.invalidParams?.[0].name).toBe('range.lastSeconds')
    p = await expectProblem(() =>
      parseSearchBody({ filter: { attrs: [{ scope: 'nope', key: 'k', op: '=', value: 'v' }] } }),
    )
    expect(p.invalidParams?.[0].name).toBe('filter.attrs[0].scope')
  })

  test('non-object body rejected', async () => {
    await expectProblem(() => parseSearchBody([1, 2]))
    await expectProblem(() => parseSearchBody('nope'))
  })
})
