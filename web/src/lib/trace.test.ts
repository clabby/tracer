import { describe, expect, test } from 'bun:test'
import { buildAggregateTree, parseTrace } from './trace'
import { colorIndexForService } from './model'
import type { TraceModel } from './model'

/*
 * Handcrafted OTLP JSON fixtures. All absolute times are e18-magnitude
 * unixnano strings: at that magnitude a double's ulp is 256ns, so any
 * sub-256ns relative offset coming out exact proves the BigInt path.
 */

const T0 = 1749571200000000000n // 2025-06-10T16:00:00.000Z in ns
const at = (offsetNs: number | bigint): string => (T0 + BigInt(offsetNs)).toString()

const TRACE_HEX = '0af7651916cd43dd8448eb211c80319c'

// ------------------------------------------------------- fixture builders --

const sattr = (key: string, stringValue: string) => ({ key, value: { stringValue } })

interface SpanSpec {
  id: string
  parent?: string
  name: string
  start?: string
  end?: string
  kind?: unknown
  status?: unknown
  attrs?: unknown[]
  events?: unknown[]
  traceId?: string
}

function mkSpan(s: SpanSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    traceId: s.traceId ?? TRACE_HEX,
    spanId: s.id,
    name: s.name,
  }
  if (s.parent !== undefined) out.parentSpanId = s.parent
  if (s.start !== undefined) out.startTimeUnixNano = s.start
  if (s.end !== undefined) out.endTimeUnixNano = s.end
  if (s.kind !== undefined) out.kind = s.kind
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

function hexToB64(hex: string): string {
  const bytes = (hex.match(/../g) ?? []).map((h) => parseInt(h, 16))
  return btoa(String.fromCharCode(...bytes))
}

// A three-node consensus round sharing one trace id. Raw order is
// intentionally NOT natural order (node-10 first) to test instance sorting.
function multiInstanceRaw(): unknown {
  const node = (n: string, rootId: string, childId: string, startOff: number, dur: number) =>
    group(n, [
      mkSpan({ id: rootId, name: 'round', start: at(startOff), end: at(startOff + dur) }),
      mkSpan({
        id: childId,
        parent: rootId,
        name: 'verify',
        start: at(startOff + 10),
        end: at(startOff + 10 + Math.floor(dur / 2)),
      }),
    ])
  return {
    resourceSpans: [
      node('node-10', 'aaaaaaaaaaaa0010', 'bbbbbbbbbbbb0010', 200, 3000),
      node('node-2', 'aaaaaaaaaaaa0002', 'bbbbbbbbbbbb0002', 100, 2000),
      node('node-1', 'aaaaaaaaaaaa0001', 'bbbbbbbbbbbb0001', 0, 1000),
    ],
  }
}

// ----------------------------------------------------------------- parser --

describe('parseTrace: envelopes and ids', () => {
  const spans = [
    mkSpan({
      id: 'AABBCCDD00112233',
      name: 'root',
      start: at(0),
      end: at(1000),
      kind: 'SPAN_KIND_SERVER',
      status: { code: 'STATUS_CODE_ERROR', message: 'boom' },
    }),
    mkSpan({
      id: '00112233AABBCCDD',
      parent: 'AABBCCDD00112233',
      name: 'child',
      start: at(120),
      end: at(350),
      kind: 3,
      status: { code: 1 },
    }),
  ]

  const checkShape = (model: TraceModel) => {
    expect(model.traceId).toBe(TRACE_HEX)
    expect(model.spans.size).toBe(2)
    const root = model.spans.get('aabbccdd00112233')
    const child = model.spans.get('00112233aabbccdd')
    expect(root).toBeDefined()
    expect(child).toBeDefined()
    expect(root!.children).toEqual([child!])
    expect(child!.parentSpanId).toBe('aabbccdd00112233')
    expect(root!.depth).toBe(0)
    expect(child!.depth).toBe(1)
  }

  test('accepts {trace:{resourceSpans}} and lowercases hex ids', () => {
    const model = parseTrace(
      { trace: { resourceSpans: [group('node-1', spans)] } },
      TRACE_HEX.toUpperCase(),
    )
    checkShape(model)
    expect(model.warnings).toEqual([])
  })

  test('accepts bare {resourceSpans}', () => {
    checkShape(parseTrace({ resourceSpans: [group('node-1', spans)] }, TRACE_HEX))
  })

  test('accepts {batches} with instrumentationLibrarySpans and base64 ids', () => {
    const rootHex = 'fedcba9876543210'
    const childHex = '1122334455667788'
    const raw = {
      batches: [
        {
          resource: { attributes: [sattr('service.name', 'node-1')] },
          instrumentationLibrarySpans: [
            {
              spans: [
                mkSpan({
                  id: hexToB64(rootHex),
                  name: 'root',
                  start: at(0),
                  end: at(500),
                  traceId: hexToB64(TRACE_HEX),
                }),
                mkSpan({
                  id: hexToB64(childHex),
                  parent: hexToB64(rootHex),
                  name: 'child',
                  start: at(64),
                  end: at(128),
                  traceId: hexToB64(TRACE_HEX),
                }),
              ],
            },
          ],
        },
      ],
    }
    const model = parseTrace(raw, hexToB64(TRACE_HEX))
    expect(model.traceId).toBe(TRACE_HEX)
    const root = model.spans.get(rootHex)
    const child = model.spans.get(childHex)
    expect(root).toBeDefined()
    expect(child).toBeDefined()
    expect(child!.traceId).toBe(TRACE_HEX)
    expect(root!.children).toEqual([child!])
    expect(child!.startNs).toBe(64)
    expect(child!.durationNs).toBe(64)
  })

  test('garbage input yields an empty model with a warning', () => {
    const model = parseTrace({ nope: true }, TRACE_HEX)
    expect(model.spans.size).toBe(0)
    expect(model.instances).toEqual([])
    expect(model.durationNs).toBe(0)
    expect(model.warnings.some((w) => w.includes('no spans'))).toBe(true)
  })
})

describe('parseTrace: BigInt relative time math', () => {
  test('sub-256ns offsets at e18 magnitude survive exactly', () => {
    const model = parseTrace({ resourceSpans: [group('node-1', basicSpans())] }, TRACE_HEX)
    // Float math fails here: Number(at(120)) - Number(at(0)) === 0 because the
    // double ulp at 1.75e18 is 256ns.
    expect(Number(at(120)) - Number(at(0))).not.toBe(120)
    const child = model.spans.get('00112233aabbccdd')!
    expect(child.startNs).toBe(120)
    expect(child.durationNs).toBe(230)
    expect(model.startUnixMs).toBe(1749571200000)
    expect(model.durationNs).toBe(1000)
  })

  function basicSpans() {
    return [
      mkSpan({ id: 'aabbccdd00112233', name: 'root', start: at(0), end: at(1000) }),
      mkSpan({
        id: '00112233aabbccdd',
        parent: 'aabbccdd00112233',
        name: 'child',
        start: at(120),
        end: at(350),
      }),
    ]
  }
})

describe('parseTrace: kind, status, level, attributes', () => {
  const raw = {
    resourceSpans: [
      group('node-1', [
        mkSpan({
          id: 'aabbccdd00112233',
          name: 'root',
          start: at(0),
          end: at(1000),
          kind: 'SPAN_KIND_SERVER',
          status: { code: 'STATUS_CODE_ERROR', message: 'boom' },
          attrs: [
            sattr('level', 'WARN'),
            { key: 'height', value: { intValue: '42' } },
            { key: 'big', value: { intValue: '9007199254740993' } },
            { key: 'ratio', value: { doubleValue: 0.5 } },
            { key: 'ok', value: { boolValue: true } },
            { key: 'peers', value: { arrayValue: { values: [{ stringValue: 'a' }, { intValue: '2' }] } } },
          ],
        }),
        mkSpan({
          id: '00112233aabbccdd',
          parent: 'aabbccdd00112233',
          name: 'child',
          start: at(120),
          end: at(350),
          kind: 3,
          status: { code: 2 },
          attrs: [sattr('log.level', 'debug')],
        }),
        mkSpan({
          id: '99112233aabbccdd',
          parent: 'aabbccdd00112233',
          name: 'ok-child',
          start: at(10),
          end: at(20),
          kind: 1,
          status: { code: 1 },
        }),
        // no `status` key at all → must default to unset
        mkSpan({
          id: '88112233aabbccdd',
          parent: 'aabbccdd00112233',
          name: 'bare-child',
          start: at(400),
          end: at(500),
        }),
        // status object present but no code → also unset
        mkSpan({
          id: '77112233aabbccdd',
          parent: 'aabbccdd00112233',
          name: 'unset-child',
          start: at(600),
          end: at(700),
          status: {},
        }),
      ]),
    ],
  }
  const model = parseTrace(raw, TRACE_HEX)
  const root = model.spans.get('aabbccdd00112233')!
  const child = model.spans.get('00112233aabbccdd')!
  const okChild = model.spans.get('99112233aabbccdd')!
  const bareChild = model.spans.get('88112233aabbccdd')!
  const unsetChild = model.spans.get('77112233aabbccdd')!

  test('kind: string and numeric forms', () => {
    expect(root.kind).toBe('server')
    expect(child.kind).toBe('client')
    expect(okChild.kind).toBe('internal')
  })

  test('status: string code, numeric 2 → error, 1 → ok, missing → unset', () => {
    expect(root.status).toBe('error')
    expect(root.statusMessage).toBe('boom')
    expect(child.status).toBe('error')
    expect(okChild.status).toBe('ok')
    expect(okChild.statusMessage).toBe('')
    expect(bareChild.status).toBe('unset')
    expect(bareChild.statusMessage).toBe('')
    expect(unsetChild.status).toBe('unset')
    expect(unsetChild.statusMessage).toBe('')
  })

  test('level from attributes (level, log.level; case-insensitive)', () => {
    expect(root.level).toBe('warn')
    expect(child.level).toBe('debug')
    expect(okChild.level).toBeNull()
  })

  test('attribute value flattening', () => {
    expect(root.attributes['height']).toBe(42) // intValue as string → number
    expect(root.attributes['big']).toBe('9007199254740993') // unsafe int stays string
    expect(root.attributes['ratio']).toBe(0.5)
    expect(root.attributes['ok']).toBe(true)
    expect(root.attributes['peers']).toBe('["a",2]') // arrays → JSON string
  })

  test('children sorted by startNs', () => {
    expect(root.children.map((c) => c.name)).toEqual([
      'ok-child',
      'child',
      'bare-child',
      'unset-child',
    ])
  })
})

describe('parseTrace: instances', () => {
  test('derives id from service.name + optional service.instance.id', () => {
    const raw = {
      resourceSpans: [
        group('node-1', [mkSpan({ id: 'aaaaaaaaaaaa0001', name: 'a', start: at(0), end: at(1) })], 'abcdef1234567890'),
        group('node-2', [mkSpan({ id: 'aaaaaaaaaaaa0002', name: 'a', start: at(0), end: at(1) })]),
        { resource: {}, scopeSpans: [{ spans: [mkSpan({ id: 'aaaaaaaaaaaa0003', name: 'a', start: at(0), end: at(1) })] }] },
      ],
    }
    const model = parseTrace(raw, TRACE_HEX)
    expect(model.instances.map((i) => i.id)).toEqual([
      'node-1#abcdef1234567890',
      'node-2',
      'unknown',
    ])
    expect(model.instances[0].serviceName).toBe('node-1')
    expect(model.instances[0].instanceTag).toBe('abcdef1234567890')
    expect(model.instances[1].instanceTag).toBeNull()
  })

  test('tags sharing an 8-char prefix stay distinct instances', () => {
    const raw = {
      resourceSpans: [
        group('api', [mkSpan({ id: 'aaaaaaaaaaaa0001', name: 'a', start: at(0), end: at(1) })], 'worker-001'),
        group('api', [mkSpan({ id: 'aaaaaaaaaaaa0002', name: 'a', start: at(0), end: at(1) })], 'worker-002'),
      ],
    }
    const model = parseTrace(raw, TRACE_HEX)
    expect(model.instances.map((i) => i.id)).toEqual(['api#worker-001', 'api#worker-002'])
    expect(model.instances.map((i) => i.instanceTag)).toEqual(['worker-001', 'worker-002'])
    expect(model.instances.map((i) => i.spanCount)).toEqual([1, 1])
    expect(model.warnings).toEqual([])
  })

  test('multi-instance trace: natural sort (node-2 < node-10) + name-derived colors', () => {
    const model = parseTrace(multiInstanceRaw(), TRACE_HEX)
    expect(model.instances.map((i) => i.serviceName)).toEqual(['node-1', 'node-2', 'node-10'])
    // Colors derive deterministically from the service name, not sort order.
    expect(model.instances.map((i) => i.colorIndex)).toEqual(
      ['node-1', 'node-2', 'node-10'].map(colorIndexForService),
    )
    for (const inst of model.instances) {
      expect(inst.spanCount).toBe(2)
      expect(inst.rootSpans).toHaveLength(1)
      expect(inst.rootSpans[0].name).toBe('round')
      expect(inst.maxDepth).toBe(1)
    }
    expect(model.spans.size).toBe(6)
    expect(model.warnings).toEqual([])
    // every span tagged with its emitting instance
    expect(model.spans.get('bbbbbbbbbbbb0010')!.instanceId).toBe('node-10')
    expect(model.spans.get('aaaaaaaaaaaa0001')!.instanceId).toBe('node-1')
  })
})

describe('parseTrace: orphans and time anomalies', () => {
  test('orphan span becomes an instance root with a warning', () => {
    const raw = {
      resourceSpans: [
        group('node-1', [
          mkSpan({ id: 'aaaaaaaaaaaa0001', name: 'root', start: at(0), end: at(100) }),
          mkSpan({
            id: 'cccccccccccc0001',
            parent: 'deadbeefdeadbeef',
            name: 'lost',
            start: at(10),
            end: at(20),
          }),
        ]),
      ],
    }
    const model = parseTrace(raw, TRACE_HEX)
    const inst = model.instances[0]
    expect(inst.rootSpans.map((s) => s.name)).toEqual(['root', 'lost'])
    const lost = model.spans.get('cccccccccccc0001')!
    expect(lost.depth).toBe(0)
    expect(model.warnings.some((w) => w.includes('orphan') && w.includes('deadbeefdeadbeef'))).toBe(true)
  })

  test('2-span parent cycle is severed into an acyclic tree with a warning', () => {
    const raw = {
      resourceSpans: [
        group('node-1', [
          mkSpan({ id: 'aaaaaaaaaaaa0001', name: 'root', start: at(0), end: at(100) }),
          mkSpan({ id: 'cccccccccccc0001', parent: 'cccccccccccc0002', name: 'cycle-a', start: at(10), end: at(40) }),
          mkSpan({ id: 'cccccccccccc0002', parent: 'cccccccccccc0001', name: 'cycle-b', start: at(20), end: at(30) }),
        ]),
      ],
    }
    const model = parseTrace(raw, TRACE_HEX)
    expect(model.spans.size).toBe(3)
    expect(model.warnings.some((w) => w.includes('parent cycle'))).toBe(true)

    // exactly one cycle member is promoted to root, with its parent link severed
    const a = model.spans.get('cccccccccccc0001')!
    const b = model.spans.get('cccccccccccc0002')!
    const promoted = model.instances[0].rootSpans.filter((s) => s.name.startsWith('cycle-'))
    expect(promoted).toHaveLength(1)
    const cycleRoot = promoted[0]
    const cycleChild = cycleRoot === a ? b : a
    expect(cycleRoot.parentSpanId).toBeNull()
    expect(cycleRoot.depth).toBe(0)
    expect(cycleRoot.children).toEqual([cycleChild])
    expect(cycleChild.parentSpanId).toBe(cycleRoot.spanId)
    expect(cycleChild.depth).toBe(1)
    expect(cycleChild.children).toEqual([]) // back-edge severed — graph is acyclic

    // consumers that walk children unguarded must terminate
    const agg = buildAggregateTree(model, new Set())
    expect(agg.children.map((c) => c.name).sort()).toEqual([cycleRoot.name, 'root'].sort())
    const aggCycle = agg.children.find((c) => c.name === cycleRoot.name)!
    expect(aggCycle.children.map((c) => c.name)).toEqual([cycleChild.name])
    expect(aggCycle.children[0].children).toEqual([])
  })

  test('missing/zero/inverted times clamp without NaN, with warnings', () => {
    const raw = {
      resourceSpans: [
        group('node-1', [
          mkSpan({ id: 'aaaaaaaaaaaa0001', name: 'anchor', start: at(0), end: at(100) }),
          mkSpan({ id: 'aaaaaaaaaaaa0002', name: 'no-start', end: at(40) }),
          mkSpan({ id: 'aaaaaaaaaaaa0003', name: 'no-end', start: at(10) }),
          mkSpan({ id: 'aaaaaaaaaaaa0004', name: 'inverted', start: at(30), end: at(20) }),
          mkSpan({ id: 'aaaaaaaaaaaa0005', name: 'zero-dur', start: at(50), end: at(50) }),
        ]),
      ],
    }
    const model = parseTrace(raw, TRACE_HEX)
    for (const span of model.spans.values()) {
      expect(Number.isFinite(span.startNs)).toBe(true)
      expect(Number.isFinite(span.durationNs)).toBe(true)
      expect(span.durationNs).toBeGreaterThanOrEqual(0)
    }
    expect(model.spans.get('aaaaaaaaaaaa0002')!.startNs).toBe(0) // clamped to trace start
    expect(model.spans.get('aaaaaaaaaaaa0002')!.durationNs).toBe(40)
    expect(model.spans.get('aaaaaaaaaaaa0003')!.durationNs).toBe(0)
    expect(model.spans.get('aaaaaaaaaaaa0004')!.durationNs).toBe(0)
    expect(model.spans.get('aaaaaaaaaaaa0005')!.durationNs).toBe(0)
    expect(Number.isFinite(model.durationNs)).toBe(true)
    expect(model.warnings.some((w) => w.includes('missing start time'))).toBe(true)
    expect(model.warnings.some((w) => w.includes('missing end time'))).toBe(true)
    expect(model.warnings.some((w) => w.includes('ends before'))).toBe(true)
  })
})

describe('parseTrace: events', () => {
  const raw = {
    resourceSpans: [
      group('node-1', [
        mkSpan({
          id: 'aaaaaaaaaaaa0001',
          name: 'collect_votes',
          start: at(0),
          end: at(1000),
          events: [
            {
              name: 'vote.received',
              timeUnixNano: at(500),
              attributes: [sattr('level', 'warn'), sattr('peer', 'node-2')],
            },
            { name: 'vote.received', timeUnixNano: at(50), attributes: [sattr('peer', 'node-3')] },
          ],
        }),
      ]),
      group('node-2', [
        mkSpan({
          id: 'aaaaaaaaaaaa0002',
          name: 'verify',
          start: at(100),
          end: at(300),
          events: [{ name: 'error', timeUnixNano: at(250), attributes: [sattr('level', 'error')] }],
        }),
      ]),
    ],
  }
  const model = parseTrace(raw, TRACE_HEX)

  test('event level extraction + ownership', () => {
    const span = model.spans.get('aaaaaaaaaaaa0001')!
    expect(span.events).toHaveLength(2)
    // sorted within the span by time
    expect(span.events.map((e) => e.timeNs)).toEqual([50, 500])
    expect(span.events[1].level).toBe('warn')
    expect(span.events[0].level).toBeNull()
    expect(span.events[0].attributes['peer']).toBe('node-3')
    expect(span.events[0].spanId).toBe('aaaaaaaaaaaa0001')
    expect(span.events[0].instanceId).toBe('node-1')
  })

  test('model.events aggregates across instances, sorted by timeNs', () => {
    expect(model.events.map((e) => e.timeNs)).toEqual([50, 250, 500])
    expect(model.events[1].level).toBe('error')
    expect(model.events[1].instanceId).toBe('node-2')
  })
})

// --------------------------------------------------------- aggregate tree --

describe('buildAggregateTree', () => {
  const model = parseTrace(multiInstanceRaw(), TRACE_HEX)
  const NONE: ReadonlySet<string> = new Set()

  test('synthetic root', () => {
    const root = buildAggregateTree(model, NONE)
    expect(root.pathKey).toBe('')
    expect(root.name).toBe('')
    expect(root.depth).toBe(-1)
    expect(root.count).toBe(0)
    expect(root.spans.size).toBe(0)
    expect(root.children).toHaveLength(1)
  })

  test('groups by path with per-instance span lists and stats', () => {
    const root = buildAggregateTree(model, NONE)
    const round = root.children[0]
    expect(round.name).toBe('round')
    expect(round.depth).toBe(0)
    // per-instance lists in instance (sorted) order
    expect([...round.spans.keys()]).toEqual(['node-1', 'node-2', 'node-10'])
    expect(round.spans.get('node-2')!.map((s) => s.spanId)).toEqual(['aaaaaaaaaaaa0002'])
    // stats over durations 1000 (node-1), 2000 (node-2), 3000 (node-10)
    expect(round.count).toBe(3)
    expect(round.minNs).toBe(1000)
    expect(round.maxNs).toBe(3000)
    expect(round.totalNs).toBe(6000)
    expect(round.meanNs).toBe(2000)

    expect(round.children).toHaveLength(1)
    const verify = round.children[0]
    expect(verify.name).toBe('verify')
    expect(verify.depth).toBe(1)
    expect(verify.pathKey).toBe(round.pathKey + 'verify')
    expect(verify.count).toBe(3)
    // verify durations: floor(dur/2) → 500, 1000, 1500
    expect(verify.minNs).toBe(500)
    expect(verify.maxNs).toBe(1500)
    expect(verify.totalNs).toBe(3000)
    expect(verify.meanNs).toBe(1000)
    expect(verify.children).toEqual([])
  })

  test('hidden instances are skipped entirely', () => {
    const root = buildAggregateTree(model, new Set(['node-10']))
    const round = root.children[0]
    expect(round.count).toBe(2)
    expect(round.spans.has('node-10')).toBe(false)
    expect([...round.spans.keys()]).toEqual(['node-1', 'node-2'])
    expect(round.minNs).toBe(1000)
    expect(round.maxNs).toBe(2000)
    expect(round.totalNs).toBe(3000)
    expect(round.meanNs).toBe(1500)
    const verify = round.children[0]
    expect(verify.count).toBe(2)
    expect(verify.spans.has('node-10')).toBe(false)
  })

  test('hiding every instance yields an empty root', () => {
    const root = buildAggregateTree(model, new Set(['node-1', 'node-2', 'node-10']))
    expect(root.children).toEqual([])
    expect(root.count).toBe(0)
  })

  test('children keyed by name in order of first appearance', () => {
    const raw = {
      resourceSpans: [
        group('node-1', [
          mkSpan({ id: 'aaaaaaaaaaaa0001', name: 'round', start: at(0), end: at(100) }),
          mkSpan({ id: 'bbbbbbbbbbbb0001', parent: 'aaaaaaaaaaaa0001', name: 'propose', start: at(5), end: at(10) }),
          mkSpan({ id: 'bbbbbbbbbbbb0002', parent: 'aaaaaaaaaaaa0001', name: 'verify', start: at(20), end: at(30) }),
          // second 'verify' sibling merges into the same aggregate node
          mkSpan({ id: 'bbbbbbbbbbbb0003', parent: 'aaaaaaaaaaaa0001', name: 'verify', start: at(40), end: at(70) }),
        ]),
        group('node-2', [
          mkSpan({ id: 'aaaaaaaaaaaa0002', name: 'round', start: at(0), end: at(100) }),
          mkSpan({ id: 'bbbbbbbbbbbb0004', parent: 'aaaaaaaaaaaa0002', name: 'verify', start: at(15), end: at(35) }),
        ]),
      ],
    }
    const root = buildAggregateTree(parseTrace(raw, TRACE_HEX), new Set())
    const round = root.children[0]
    expect(round.children.map((c) => c.name)).toEqual(['propose', 'verify'])
    const verify = round.children[1]
    expect(verify.count).toBe(3)
    expect(verify.spans.get('node-1')!).toHaveLength(2)
    expect(verify.spans.get('node-2')!).toHaveLength(1)
    expect(verify.totalNs).toBe(10 + 30 + 20)
    expect(verify.minNs).toBe(10)
    expect(verify.maxNs).toBe(30)
  })
})
