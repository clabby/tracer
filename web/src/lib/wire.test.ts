import { describe, expect, test } from 'bun:test'
import { parseTrace } from './trace'
import { hydrateTrace, serializeTrace } from './wire'

/*
 * Round-trip contract: hydrateTrace(serializeTrace(model)) must deep-equal
 * the model parseTrace produced, including on traces that exercised every
 * parser anomaly path (duplicates, orphans, cycles, clamped times). The wire
 * form must also survive JSON encoding unchanged.
 */

const T0 = 1749571200000000000n // 2025-06-10T16:00:00.000Z in ns
const at = (offsetNs: number | bigint): string => (T0 + BigInt(offsetNs)).toString()

const TRACE_HEX = '0af7651916cd43dd8448eb211c80319c'

const sattr = (key: string, stringValue: string) => ({ key, value: { stringValue } })

interface SpanSpec {
  id: string
  parent?: string
  name: string
  start?: string
  end?: string
  status?: unknown
  attrs?: unknown[]
  events?: unknown[]
}

function mkSpan(s: SpanSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { traceId: TRACE_HEX, spanId: s.id, name: s.name }
  if (s.parent !== undefined) out.parentSpanId = s.parent
  if (s.start !== undefined) out.startTimeUnixNano = s.start
  if (s.end !== undefined) out.endTimeUnixNano = s.end
  if (s.status !== undefined) out.status = s.status
  if (s.attrs !== undefined) out.attributes = s.attrs
  if (s.events !== undefined) out.events = s.events
  return out
}

function group(service: string, spans: unknown[], instanceId?: string): Record<string, unknown> {
  const attributes: unknown[] = [sattr('service.name', service)]
  if (instanceId !== undefined) attributes.push(sattr('service.instance.id', instanceId))
  return { resource: { attributes }, scopeSpans: [{ scope: { name: 'test' }, spans }] }
}

/**
 * A messy three-node trace: events, an error span, a duplicate span id, an
 * orphan, a parent cycle, and a missing end time — every warning path at once.
 */
function messyRaw(): unknown {
  return {
    resourceSpans: [
      group('node-10', [
        mkSpan({ id: 'aaaaaaaaaaaa0010', name: 'round', start: at(200), end: at(3200) }),
        mkSpan({
          id: 'bbbbbbbbbbbb0010',
          parent: 'aaaaaaaaaaaa0010',
          name: 'verify',
          start: at(210),
          end: at(1710),
          status: { code: 2, message: 'boom' },
          events: [
            { name: 'vote.received', timeUnixNano: at(500), attributes: [sattr('level', 'warn')] },
            { name: 'vote.received', timeUnixNano: at(250), attributes: [sattr('peer', 'node-3')] },
          ],
        }),
      ]),
      group(
        'node-2',
        [
          mkSpan({ id: 'aaaaaaaaaaaa0002', name: 'round', start: at(100), end: at(2100) }),
          // duplicate span id — parser keeps the first, warns on this one
          mkSpan({ id: 'aaaaaaaaaaaa0002', name: 'round', start: at(101), end: at(2101) }),
          // orphan — parent never appears
          mkSpan({ id: 'cccccccccccc0002', parent: 'deadbeefdeadbeef', name: 'lost', start: at(150), end: at(180) }),
          // missing end time — clamped with a warning
          mkSpan({ id: 'dddddddddddd0002', parent: 'aaaaaaaaaaaa0002', name: 'no-end', start: at(120) }),
        ],
        'a1b2',
      ),
      group('node-1', [
        mkSpan({ id: 'aaaaaaaaaaaa0001', name: 'round', start: at(0), end: at(1000) }),
        // 2-span parent cycle — severed by the parser
        mkSpan({ id: 'cccccccccccc0001', parent: 'cccccccccccc0011', name: 'cycle-a', start: at(10), end: at(40) }),
        mkSpan({ id: 'cccccccccccc0011', parent: 'cccccccccccc0001', name: 'cycle-b', start: at(20), end: at(30) }),
      ]),
    ],
  }
}

describe('wire round-trip', () => {
  test('clean multi-instance trace survives serialize -> hydrate exactly', () => {
    const raw = {
      resourceSpans: [
        group('node-2', [
          mkSpan({ id: 'aaaaaaaaaaaa0002', name: 'round', start: at(100), end: at(2100) }),
          mkSpan({ id: 'bbbbbbbbbbbb0002', parent: 'aaaaaaaaaaaa0002', name: 'verify', start: at(110), end: at(1110) }),
        ]),
        group('node-1', [
          mkSpan({ id: 'aaaaaaaaaaaa0001', name: 'round', start: at(0), end: at(1000) }),
        ]),
      ],
    }
    const model = parseTrace(raw, TRACE_HEX)
    expect(model.warnings).toEqual([])
    expect(hydrateTrace(serializeTrace(model))).toEqual(model)
  })

  test('messy trace (dupes, orphan, cycle, clamped times) round-trips', () => {
    const model = parseTrace(messyRaw(), TRACE_HEX)
    expect(model.warnings.length).toBeGreaterThan(0)
    expect(hydrateTrace(serializeTrace(model))).toEqual(model)
  })

  test('wire form survives JSON encode/decode', () => {
    const model = parseTrace(messyRaw(), TRACE_HEX)
    const wire = JSON.parse(JSON.stringify(serializeTrace(model)))
    expect(hydrateTrace(wire)).toEqual(model)
  })

  test('empty model round-trips', () => {
    const model = parseTrace({ nope: true }, TRACE_HEX)
    expect(hydrateTrace(serializeTrace(model))).toEqual(model)
  })
})

describe('wire shape', () => {
  const model = parseTrace(messyRaw(), TRACE_HEX)
  const wire = serializeTrace(model)

  test('childSpanIds preserve the parser sibling order', () => {
    for (const w of wire.spans) {
      const node = model.spans.get(w.spanId)!
      expect(w.childSpanIds).toEqual(node.children.map((c) => c.spanId))
    }
  })

  test('spans ride in parser encounter order', () => {
    expect(wire.spans.map((s) => s.spanId)).toEqual([...model.spans.keys()])
  })

  test('instance rollups: rootSpanIds, errorCount, time extents', () => {
    expect(wire.instances.map((i) => i.id)).toEqual(['node-1', 'node-2#a1b2', 'node-10'])

    const node10 = wire.instances.find((i) => i.id === 'node-10')!
    expect(node10.rootSpanIds).toEqual(['aaaaaaaaaaaa0010'])
    expect(node10.errorCount).toBe(1) // the failed verify span
    expect(node10.earliestStartNs).toBe(200)
    expect(node10.latestEndNs).toBe(3200)

    const node2 = wire.instances.find((i) => i.id === 'node-2#a1b2')!
    // root + promoted orphan
    expect(node2.rootSpanIds).toEqual(['aaaaaaaaaaaa0002', 'cccccccccccc0002'])
    expect(node2.errorCount).toBe(0)
    expect(node2.earliestStartNs).toBe(100)
    expect(node2.latestEndNs).toBe(2100)

    const node1 = wire.instances.find((i) => i.id === 'node-1')!
    expect(node1.earliestStartNs).toBe(0)
    expect(node1.latestEndNs).toBe(1000)
  })

  test('span fields carry over without object references', () => {
    const verify = wire.spans.find((s) => s.spanId === 'bbbbbbbbbbbb0010')!
    expect(verify.status).toBe('error')
    expect(verify.statusMessage).toBe('boom')
    expect(verify.events.map((e) => e.timeNs)).toEqual([250, 500])
    expect(verify.instanceId).toBe('node-10')
    expect('children' in verify).toBe(false)
  })
})
