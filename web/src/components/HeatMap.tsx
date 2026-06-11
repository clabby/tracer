/*
 * HeatMap — a span-name × instance matrix for one trace.
 *
 * Each cell is the mean duration of that span on that node, heat-shaded
 * relative to the slowest node in its row, so cross-node skew (which node lags
 * on which phase) is visible at a glance. Cells with errors get a red ring.
 * Purely derived from span timing/status — no workload-specific assumptions.
 */

import { useMemo } from 'react'
import type { HeatMapProps } from '../lib/model'
import { instanceColorVar } from '../lib/model'
import { formatNs } from '../lib/format'
import './HeatMap.css'

interface Cell {
  meanNs: number
  errors: boolean
}
interface Row {
  name: string
  total: number
  cells: (Cell | null)[]
}

export default function HeatMap({ model }: HeatMapProps) {
  const insts = model.instances
  const rows = useMemo<Row[]>(() => {
    const idx = new Map(insts.map((i, k) => [i.id, k]))
    const byName = new Map<string, { sum: number; count: number; err: boolean }[]>()
    for (const s of model.spans.values()) {
      let cols = byName.get(s.name)
      if (!cols) {
        cols = insts.map(() => ({ sum: 0, count: 0, err: false }))
        byName.set(s.name, cols)
      }
      const k = idx.get(s.instanceId)
      if (k === undefined) continue
      cols[k].sum += s.durationNs
      cols[k].count++
      if (s.status === 'error' || s.level === 'error') cols[k].err = true
    }
    const out: Row[] = []
    for (const [name, cols] of byName) {
      let total = 0
      const cells = cols.map((c) => {
        if (c.count === 0) return null
        total += c.sum
        return { meanNs: c.sum / c.count, errors: c.err }
      })
      out.push({ name, total, cells })
    }
    out.sort((a, b) => b.total - a.total)
    return out
  }, [model, insts])

  return (
    <section className="panel hm">
      <div className="panel-header">
        <span className="panel-title">node × span heatmap</span>
        <span className="faint hm-legend">mean duration · brighter = slower in row</span>
      </div>
      <div className="hm-scroll">
        <div
          className="hm-grid"
          style={{ gridTemplateColumns: `var(--hm-name) repeat(${insts.length}, 1fr)` }}
        >
          <div className="hm-corner" />
          {insts.map((i) => (
            <div key={i.id} className="hm-col-head" title={i.serviceName}>
              <span className="swatch" style={{ background: instanceColorVar(i.colorIndex) }} />
              <span className="hm-col-name">{i.serviceName}</span>
            </div>
          ))}
          {rows.map((r) => {
            const maxMean = Math.max(1, ...r.cells.map((c) => (c ? c.meanNs : 0)))
            return (
              <div className="hm-row" key={r.name} style={{ display: 'contents' }}>
                <div className="hm-row-head" title={r.name}>
                  {r.name}
                </div>
                {r.cells.map((c, k) => (
                  <div
                    key={k}
                    className={`hm-cell${c ? '' : ' hm-empty'}${c?.errors ? ' hm-err' : ''}`}
                    style={
                      c
                        ? {
                            background: `color-mix(in srgb, var(--accent) ${Math.round(
                              18 + 72 * (c.meanNs / maxMean),
                            )}%, transparent)`,
                          }
                        : undefined
                    }
                    title={c ? `${r.name} · ${insts[k].serviceName}: ${formatNs(c.meanNs)}${c.errors ? ' · error' : ''}` : undefined}
                  >
                    {c ? formatNs(c.meanNs) : ''}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
