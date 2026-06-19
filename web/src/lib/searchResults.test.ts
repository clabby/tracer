import { describe, expect, test } from 'bun:test'
import type { TraceSummary } from './model'
import { groupTraceSummaries } from './searchResults'

const row = (traceId: string, service: string, durationMs: number): TraceSummary => ({
  traceId,
  rootServiceName: service,
  rootTraceName: 'round',
  startUnixMs: 1_719_000_000_000,
  durationMs,
  spanCount: 1,
  services: [service],
  matchedSpanIds: [`span-${traceId}`],
  matchedSpanNames: ['round'],
})

describe('groupTraceSummaries', () => {
  test('aggregates per-node span search rows into one comparison summary', () => {
    const group = groupTraceSummaries([
      row('a', 'node-0', 71),
      row('b', 'node-1', 76),
      row('c', 'node-2', 80),
      row('d', 'node-3', 59),
    ])

    expect(group?.traceId).toBe('compare')
    expect(group?.rootTraceName).toBe('round ×4')
    expect(group?.durationMs).toBe(80)
    expect(group?.spanCount).toBe(4)
    expect(group?.services).toEqual(['node-0', 'node-1', 'node-2', 'node-3'])
  })

  test('empty input stays empty', () => {
    expect(groupTraceSummaries([])).toBeNull()
  })
})
