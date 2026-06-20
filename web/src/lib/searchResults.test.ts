import { describe, expect, test } from 'bun:test'
import { DEFAULT_FILTER, type EventSummary, type TraceSummary } from './model'
import { groupEventSummaries, groupTraceSummaries } from './searchResults'

const filter = {
  ...DEFAULT_FILTER,
  attrs: [{ id: 'h', scope: 'span', key: 'height', op: '<=', value: '1000' }],
} satisfies typeof DEFAULT_FILTER

const trace = (traceId: string, service: string, height: number, durationMs: number): TraceSummary => ({
  traceId,
  rootServiceName: service,
  rootTraceName: 'round',
  startUnixMs: 1_719_000_000_000 + height,
  durationMs,
  spanCount: 1,
  services: [service],
  matchedSpanIds: [`span-${traceId}`],
  matchedSpanNames: ['round'],
  matchedSpans: [
    {
      spanId: `span-${traceId}`,
      name: 'round',
      attributes: { height },
    },
  ],
})

const event = (traceId: string, serviceName: string, height: number): EventSummary => ({
  traceId,
  spanId: `span-${traceId}`,
  spanName: 'round',
  eventName: 'commit.done',
  level: 'info',
  serviceName,
  spanStartUnixMs: 1_719_000_000_000 + height,
  spanDurationNs: 10_000_000,
  attributes: { height },
})

describe('groupTraceSummaries', () => {
  test('groups span rows by matched name and filtered attribute value', () => {
    const grouped = groupTraceSummaries([
      trace('a', 'node-0', 10, 71),
      trace('b', 'node-1', 10, 76),
      trace('c', 'node-0', 11, 80),
      trace('d', 'node-1', 11, 59),
    ], filter)

    expect(grouped.rows.map((row) => row.rootTraceName)).toEqual(['round ×2', 'round ×2'])
    expect(grouped.compares).toHaveLength(2)
    expect(grouped.compares.map((group) => group.filter.attrs[0].value).sort()).toEqual(['10', '11'])
  })

  test('leaves rows alone without an attribute filter', () => {
    const grouped = groupTraceSummaries([trace('a', 'node-0', 10, 71)], DEFAULT_FILTER)
    expect(grouped.rows).toHaveLength(1)
    expect(grouped.compares).toEqual([])
  })
})

describe('groupEventSummaries', () => {
  test('groups event rows by event name and filtered attribute value', () => {
    const grouped = groupEventSummaries([
      event('a', 'node-0', 10),
      event('b', 'node-1', 10),
      event('c', 'node-0', 11),
    ], filter)

    expect(grouped.rows.map((row) => row.eventName).sort()).toEqual(['commit.done', 'commit.done ×2'])
    expect(grouped.compares).toHaveLength(1)
    expect(grouped.compares[0].target).toBe('events')
    expect(grouped.compares[0].filter.attrs[0]).toMatchObject({ key: 'height', op: '=', value: '10' })
  })
})
