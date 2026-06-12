import { describe, expect, test } from 'bun:test'
import type { FilterState } from '../lib/model'
import { sanitizeFilter } from './client'

const base: FilterState = {
  services: [],
  name: '',
  nameIsRegex: true,
  levels: [],
  attrs: [],
  minDuration: '',
  maxDuration: '',
  errorsOnly: false,
  rawQuery: '',
  limit: 50,
}

describe('sanitizeFilter', () => {
  test("drops draft attr rows with blank keys (the UI's fresh '+ attribute' row)", () => {
    const out = sanitizeFilter({
      ...base,
      attrs: [
        { id: 'a', scope: 'span', key: '', op: '=', value: '' },
        { id: 'b', scope: 'span', key: '  ', op: '=', value: 'x' },
        { id: 'c', scope: 'span', key: 'view', op: '=', value: '5' },
      ],
    })
    expect(out.attrs.map((a) => a.id)).toEqual(['c'])
  })

  test('clears unparseable durations (e.g. "150" typed before its unit)', () => {
    const out = sanitizeFilter({ ...base, minDuration: '150', maxDuration: '2s' })
    expect(out.minDuration).toBe('')
    expect(out.maxDuration).toBe('2s')
  })

  test('valid filters pass through untouched', () => {
    const f: FilterState = {
      ...base,
      attrs: [{ id: 'a', scope: 'span', key: 'view', op: '=', value: '5' }],
      minDuration: '100ms',
    }
    expect(sanitizeFilter(f)).toEqual(f)
  })
})
