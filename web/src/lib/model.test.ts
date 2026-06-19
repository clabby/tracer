import { describe, expect, test } from 'bun:test'
import { DEFAULT_FILTER, canCompareFilter, type FilterState } from './model'

const named: FilterState = { ...DEFAULT_FILTER, name: 'round' }

describe('canCompareFilter', () => {
  test('only span searches can be compared', () => {
    expect(canCompareFilter('spans', named)).toBe(true)
    expect(canCompareFilter('events', named)).toBe(false)
  })

  test('needs a span name or raw query', () => {
    expect(canCompareFilter('spans', DEFAULT_FILTER)).toBe(false)
  })
})
