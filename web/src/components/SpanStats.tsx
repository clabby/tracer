/*
 * SpanStats — per-span-name aggregates across instances for one trace.
 *
 * Surfaces cross-node skew: for each distinct span name, its count, latency
 * percentiles, error rate, and the straggler (the instance whose mean is
 * slowest) with its delta over the per-instance median. Purely derived from
 * span timing/status — no dependence on any particular workload.
 */

import { useMemo } from 'react'
import type { SpanStatsProps } from '../lib/model'
import { instanceColorVar } from '../lib/model'
import { formatNs } from '../lib/format'
import './SpanStats.css'

interface Row {
  name: string
  count: number
  nodes: number
  p50: number
  p95: number
  max: number
  total: number
  errPct: number
  straggler: string | null
  skewNs: number
}

/** Value at percentile p (0–100) of an ascending-sorted array. */
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export default function SpanStats({ model }: SpanStatsProps) {
  const rows = useMemo<Row[]>(() => {
    const byName = new Map<
      string,
      { durs: number[]; errors: number; perInst: Map<string, number[]> }
    >()
    for (const s of model.spans.values()) {
      let g = byName.get(s.name)
      if (!g) {
        g = { durs: [], errors: 0, perInst: new Map() }
        byName.set(s.name, g)
      }
      g.durs.push(s.durationNs)
      if (s.status === 'error' || s.level === 'error') g.errors++
      const arr = g.perInst.get(s.instanceId)
      if (arr) arr.push(s.durationNs)
      else g.perInst.set(s.instanceId, [s.durationNs])
    }
    const out: Row[] = []
    for (const [name, g] of byName) {
      const sorted = [...g.durs].sort((a, b) => a - b)
      // Per-instance mean → slowest instance and the spread over the median.
      let straggler: string | null = null
      let slowMean = -1
      const means: number[] = []
      for (const [inst, ds] of g.perInst) {
        const mean = ds.reduce((a, b) => a + b, 0) / ds.length
        means.push(mean)
        if (mean > slowMean) {
          slowMean = mean
          straggler = inst
        }
      }
      const med = median(means)
      out.push({
        name,
        count: g.durs.length,
        nodes: g.perInst.size,
        p50: pct(sorted, 50),
        p95: pct(sorted, 95),
        max: pct(sorted, 100),
        total: g.durs.reduce((a, b) => a + b, 0),
        errPct: g.errors / g.durs.length,
        straggler: g.perInst.size > 1 ? straggler : null,
        skewNs: g.perInst.size > 1 ? slowMean - med : 0,
      })
    }
    out.sort((a, b) => b.total - a.total)
    return out
  }, [model])

  const instName = (id: string) =>
    model.instances.find((i) => i.id === id)?.serviceName ?? id
  // Color the straggler by its instance hue so it matches the flame lanes.
  const instHue = (id: string) => model.instances.find((i) => i.id === id)?.colorIndex ?? 0

  return (
    <section className="panel stats">
      <div className="panel-header">
        <span className="panel-title">span stats</span>
        <span className="faint mono-num">{rows.length} names</span>
      </div>
      <div className="stats-scroll">
        <table className="data stats-table">
          <thead>
            <tr>
              <th>span</th>
              <th className="num">count</th>
              <th className="num">nodes</th>
              <th className="num">p50</th>
              <th className="num">p95</th>
              <th className="num">max</th>
              <th>straggler</th>
              <th className="num">err</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td className="stats-name">{r.name}</td>
                <td className="num mono-num">{r.count}</td>
                <td className="num mono-num">{r.nodes}</td>
                <td className="num mono-num">{formatNs(r.p50)}</td>
                <td className="num mono-num">{formatNs(r.p95)}</td>
                <td className="num mono-num">{formatNs(r.max)}</td>
                <td>
                  {r.straggler ? (
                    <span className="stats-straggler">
                      <span
                        className="swatch"
                        style={{ background: instanceColorVar(instHue(r.straggler)) }}
                      />
                      <span className="inst-name" title={instName(r.straggler)}>
                        {instName(r.straggler)}
                      </span>
                      {r.skewNs > 0 && (
                        <span className="faint mono-num"> +{formatNs(r.skewNs)}</span>
                      )}
                    </span>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td className="num mono-num">
                  {r.errPct > 0 ? (
                    <span className="level-error">{Math.round(r.errPct * 100)}%</span>
                  ) : (
                    <span className="faint">0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
