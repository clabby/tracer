import { describe, expect, test } from 'bun:test'
import { spanSubsystem, subsystemPalette } from './subsystem'
import { parseTrace } from './trace'
import { hydrateTrace, serializeTrace } from './wire'

describe('subsystem ownership', () => {
  test('explicit ownership wins over target and operation name', () => {
    expect(spanSubsystem({ name: 'other::operation', attributes: {
      subsystem: ' vendor/runtime/io ', target: 'different::module',
    } })).toBe('vendor::runtime::io')
    expect(spanSubsystem({ name: 'execute', attributes: {
      target: 'engine::execution::worker',
    } })).toBe('engine::execution::worker')
    expect(spanSubsystem({ name: 'execute', attributes: {
      'code.namespace': 'library.storage.journal',
    } })).toBe('library::storage::journal')
  })

  test('qualified names work, bare names and unrelated attributes stay unknown', () => {
    expect(spanSubsystem({ name: 'library::consensus::vote', attributes: {} })).toBe('library::consensus::vote')
    expect(spanSubsystem({ name: 'execute', attributes: { 'service.name': 'worker-2', subsystem: 42 } })).toBeNull()
    expect(spanSubsystem({ name: 'commit', attributes: { target: '  ' } })).toBeNull()
    expect(spanSubsystem({ name: 'commit', attributes: { target: ':: / .' } })).toBeNull()
    expect(spanSubsystem({ name: 'commit', attributes: { subsystem: '/', target: 'vendor' } })).toBe('vendor')
  })

  test('package prefixes group generically without splitting module identifiers', () => {
    for (const target of ['acme_storage::read_block', 'acme-storage/read_block', 'acme.storage.read_block']) {
      expect(spanSubsystem({ name: 'read', attributes: { target } })).toBe('acme::storage::read_block')
    }
    expect(spanSubsystem({ name: 'write', attributes: { target: 'acme_runtime::disk::write_at' } }))
      .toBe('acme::runtime::disk::write_at')
    expect(spanSubsystem({ name: 'read', attributes: { target: 'engine::tree' } })).toBe('engine::tree')
  })

  test('OTLP span targets survive parsing and wire hydration, independent of event targets', () => {
    const model = parseTrace({ resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'worker' } }] },
      scopeSpans: [{ scope: { name: 'application-wide' }, spans: [{
        traceId: 'a'.repeat(32), spanId: '1'.repeat(16), name: 'read',
        startTimeUnixNano: '1000000000', endTimeUnixNano: '1000000100',
        attributes: [{ key: 'target', value: { stringValue: 'acme_storage::disk::read_block' } }],
        events: [{ name: 'message', timeUnixNano: '1000000050', attributes: [
          { key: 'target', value: { stringValue: 'other::module' } },
        ] }],
      }] }],
    }] }, 'a'.repeat(32))
    const span = hydrateTrace(serializeTrace(model)).spans.get('1'.repeat(16))!
    expect(span.attributes.target).toBe('acme_storage::disk::read_block')
    expect(spanSubsystem(span)).toBe('acme::storage::disk::read_block')
    expect(span.events[0].attributes.target).toBe('other::module')
  })
})

describe('hierarchical palette', () => {
  const paths = ['alpha::core::read', 'alpha::core::write', 'alpha::net', 'beta::x', 'gamma']
  const distance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

  test('roots separate; nested forks narrow their bands even across hue zero', () => {
    const palette = subsystemPalette(paths, 5, 60)
    expect(palette.get('alpha')).toBe(5)
    expect(palette.get('beta')).toBe(245)
    expect(palette.get('gamma')).toBe(125)
    // Alpha gets a 40° band; core/net centers are 20° apart. Core's
    // 6⅔° band splits again, placing read/write 3⅓° apart, not 20°.
    expect(palette.get('alpha::core')).toBe(355)
    expect(palette.get('alpha::net')).toBe(15)
    expect(palette.get('alpha::core::read')).toBeCloseTo(353 + 1 / 3)
    expect(palette.get('alpha::core::write')).toBeCloseTo(356 + 2 / 3)
    expect(distance(palette.get(paths[0])!, palette.get(paths[1])!)).toBeCloseTo(10 / 3)
    expect(distance(palette.get(paths[0])!, palette.get('alpha::net')!)).toBeGreaterThan(20)
  })

  test('ordering, frequencies, and explicitly listing ancestors do not change colors', () => {
    expect(subsystemPalette([...paths].reverse().concat(Array(100).fill(paths[0]), 'alpha', 'alpha::core'), 170, 60))
      .toEqual(subsystemPalette(paths, 170, 60))
    expect(subsystemPalette([], 170, 60).size).toBe(0)
    expect(subsystemPalette(['vendor'], 170, 60).get('vendor')).toBe(170)
  })

  test('legend order keeps descendants next to their parent, not interleaved with siblings', () => {
    const palette = subsystemPalette(['root::a-leaf', 'root::a::child', 'root::z'], 170, 60)
    expect([...palette.keys()]).toEqual(['root', 'root::a', 'root::a::child', 'root::a-leaf', 'root::z'])
  })

  test('unbalanced trees do not let large branches steal the color budget', () => {
    const before = subsystemPalette(paths, 170, 60)
    const after = subsystemPalette([...paths,
      ...Array.from({ length: 300 }, (_, i) => `alpha::core::read::leaf${i}`),
    ], 170, 60)
    for (const path of before.keys()) expect(after.get(path)).toBe(before.get(path))
    const leaves = [...after].filter(([path]) => path.startsWith('alpha::core::read::'))
    for (const [, hue] of leaves) {
      expect(distance(hue, after.get('alpha::core::read')!)).toBeLessThan(1)
      expect(distance(hue, after.get('alpha::core::write')!)).toBeGreaterThan(2)
    }
  })

  test('unary chains preserve color budget until the next real fork', () => {
    const direct = subsystemPalette(['a::left', 'a::right', 'b'], 170, 60)
    const nested = subsystemPalette(['a::only::deep::left', 'a::only::deep::right', 'b'], 170, 60)
    expect(nested.get('a::only::deep')).toBe(direct.get('a'))
    expect(nested.get('a::only::deep::left')).toBe(direct.get('a::left'))
    expect(nested.get('a::only::deep::right')).toBe(direct.get('a::right'))
    const deepPath = Array(2000).fill('single').join('::')
    const deep = subsystemPalette([deepPath], 170, 60)
    expect(deep.size).toBe(2000)
    expect(deep.get(deepPath)).toBe(170)
  })

  test('generated asymmetric trees stay in their root bands at varying fanouts', () => {
    for (const count of [1, 2, 3, 7, 32, 128]) {
      const roots = Array.from({ length: count }, (_, i) => `root${String(i).padStart(3, '0')}`)
      const generated = roots.flatMap((root, i) => Array.from({ length: 2 + i % 7 }, (_, j) =>
        Array.from({ length: 1 + (i * 3 + j) % 5 }, (_, k) => `${root}::branch${j}::only::leaf${k}`)).flat())
      const palette = subsystemPalette(generated, 359, 60)
      const bandRadius = Math.min(30, 60 / count)
      for (let i = 0; i < roots.length; i++) {
        const center = ((359 - i * 360 / count) % 360 + 360) % 360
        expect(palette.get(roots[i])).toBeCloseTo(center)
        const hues = [...palette].filter(([path]) => path.startsWith(`${roots[i]}::`)).map(([, hue]) => hue)
        for (const hue of hues) {
          expect(Number.isFinite(hue) && hue >= 0 && hue < 360).toBe(true)
          expect(distance(hue, center)).toBeLessThanOrEqual(bandRadius + 1e-9)
        }
        if (count > 1) {
          const other = palette.get(roots[(i + 1) % count])!
          expect(Math.max(...hues.map(hue => distance(hue, center))))
            .toBeLessThan(Math.min(...hues.map(hue => distance(hue, other))))
        }
      }
    }
  })
})
