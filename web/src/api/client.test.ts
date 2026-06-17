import { describe, expect, test } from 'bun:test'
import type { FilterState } from '../lib/model'
import { buildCompareQuery, sanitizeFilter } from './client'

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

describe('buildCompareQuery', () => {
  test('serializes name + attr + range into the compare GET dialect', () => {
    const q = buildCompareQuery(
      {
        ...base,
        name: 'simplex.voter.view',
        nameIsRegex: false,
        attrs: [{ id: 'a', scope: 'span', key: 'view', op: '=', value: '1612' }],
        limit: 30,
      },
      { from: 1749571100.4, to: 1749571300.6 },
    )
    const p = new URLSearchParams(q)
    expect(p.get('name')).toBe('simplex.voter.view')
    expect(p.get('nameRegex')).toBe('false')
    expect(p.get('attr')).toBe('span.view=1612')
    expect(p.get('limit')).toBe('30')
    // range is floored/ceiled to whole unix seconds
    expect(p.get('from')).toBe('1749571100')
    expect(p.get('to')).toBe('1749571301')
  })

  test('drops draft noise so a UI search compares cleanly', () => {
    const q = buildCompareQuery(
      {
        ...base,
        name: 'x',
        attrs: [{ id: 'a', scope: 'span', key: '', op: '=', value: 'ignored' }],
        minDuration: '150',
      },
      { from: 1, to: 2 },
    )
    const p = new URLSearchParams(q)
    expect(p.getAll('attr')).toEqual([])
    expect(p.has('minDuration')).toBe(false)
  })
})
