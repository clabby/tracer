import { describe, expect, test } from 'bun:test'
import { DEFAULT_FILTER, canCompareFilter, type FilterState } from './model'

const comparable: FilterState = {
  ...DEFAULT_FILTER,
  name: 'round',
  nameIsRegex: false,
  attrs: [{ id: 'a', scope: 'span', key: 'height', op: '=', value: '42' }],
}

describe('canCompareFilter', () => {
  test('only span searches can be compared', () => {
    expect(canCompareFilter('spans', comparable)).toBe(true)
    expect(canCompareFilter('events', comparable)).toBe(false)
  })

  test('needs an exact span name plus a pinning span attribute', () => {
    expect(canCompareFilter('spans', DEFAULT_FILTER)).toBe(false)
    expect(canCompareFilter('spans', { ...comparable, rawQuery: '{ name = "round" }' })).toBe(false)
    expect(canCompareFilter('spans', { ...comparable, attrs: [] })).toBe(false)
  })

  test('lets the UI compare a default regex-mode name as exact text', () => {
    expect(canCompareFilter('spans', { ...comparable, nameIsRegex: true })).toBe(true)
  })
})
