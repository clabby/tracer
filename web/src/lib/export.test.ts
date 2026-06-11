import { describe, expect, test } from 'bun:test'
import { exportTrace } from './export'
import { parseTrace } from './trace'

const TRACE = 'aaaabbbbccccdddd0000111122223333'
const NS = 1_781_000_000_000_000_000n

function span(
  id: string,
  parent: string | null,
  name: string,
  service: string,
  startOffsetNs: number,
  durNs: number,
  extra: object = {},
) {
  return {
    resource: {
      attributes: [{ key: 'service.name', value: { stringValue: service } }],
    },
    scopeSpans: [
      {
        spans: [
          {
            traceId: TRACE,
            spanId: id,
            parentSpanId: parent ?? undefined,
            name,
            startTimeUnixNano: String(NS + BigInt(startOffsetNs)),
            endTimeUnixNano: String(NS + BigInt(startOffsetNs + durNs)),
            ...extra,
          },
        ],
      },
    ],
  }
}

const RAW = {
  resourceSpans: [
    span('1111111111111111', null, 'round', 'node-0', 0, 5_000_000, {
      attributes: [{ key: 'level', value: { stringValue: 'info' } }],
    }),
    span('2222222222222222', '1111111111111111', 'commit', 'node-0', 1_000_000, 2_000_000, {
      status: { code: 2, message: 'quorum not reached' },
      events: [
        {
          name: 'error',
          timeUnixNano: String(NS + 1_500_000n),
          attributes: [{ key: 'level', value: { stringValue: 'error' } }],
        },
      ],
    }),
    span('3333333333333333', null, 'round', 'node-1', 500_000, 4_000_000),
  ],
}

describe('exportTrace', () => {
  test('namespaces nested spans and events by service', () => {
    const model = parseTrace(RAW, TRACE)
    const out = exportTrace(model, new Set())

    expect(out.traceId).toBe(TRACE)
    expect(Object.keys(out.services).sort()).toEqual(['node-0', 'node-1'])

    const root = out.services['node-0'].spans[0]
    expect(root.name).toBe('round')
    expect(root.startOffsetMs).toBe(0)
    expect(root.durationMs).toBe(5)
    expect(root.level).toBe('info')
    expect(root.status).toBeUndefined()

    const commit = root.children![0]
    expect(commit.name).toBe('commit')
    expect(commit.startOffsetMs).toBe(1)
    expect(commit.status).toBe('error')
    expect(commit.statusMessage).toBe('quorum not reached')
    expect(commit.events).toHaveLength(1)
    expect(commit.events![0]).toMatchObject({ name: 'error', offsetMs: 1.5, level: 'error' })

    // Empty collections are omitted, not empty.
    expect(out.services['node-1'].spans[0].children).toBeUndefined()
    expect(out.services['node-1'].spans[0].events).toBeUndefined()
  })

  test('hidden instances are excluded like the flamegraph', () => {
    const model = parseTrace(RAW, TRACE)
    const out = exportTrace(model, new Set(['node-1']))
    expect(Object.keys(out.services)).toEqual(['node-0'])
  })

  test('round-trips through JSON cleanly', () => {
    const model = parseTrace(RAW, TRACE)
    const out = exportTrace(model, new Set())
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })
})
