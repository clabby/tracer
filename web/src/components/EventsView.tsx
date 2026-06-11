import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Attributes, EventsViewProps, Instance, Level } from '../lib/model'
import { LEVELS, instanceColorVar } from '../lib/model'
import { formatClock, formatNs, shortId } from '../lib/format'
import './EventsView.css'

const MAX_ROWS = 2000
const PREVIEW_PAIRS = 3
const PREVIEW_CHARS = 60

function attrsPreview(attrs: Attributes): string {
  const pairs = Object.entries(attrs)
    .slice(0, PREVIEW_PAIRS)
    .map(([k, v]) => `${k}=${String(v)}`)
  const joined = pairs.join(' ')
  return joined.length > PREVIEW_CHARS
    ? `${joined.slice(0, PREVIEW_CHARS)}…`
    : joined
}

export default function EventsView({
  model,
  selectedSpanId,
  onSelectSpan,
  onSelectEvent,
}: EventsViewProps) {
  const [activeLevels, setActiveLevels] = useState<ReadonlySet<Level>>(
    () => new Set(),
  )
  const [nameQuery, setNameQuery] = useState('')

  const instancesById = useMemo(() => {
    const byId = new Map<string, Instance>()
    for (const instance of model.instances) byId.set(instance.id, instance)
    return byId
  }, [model])

  const filtered = useMemo(() => {
    const q = nameQuery.trim().toLowerCase()
    if (activeLevels.size === 0 && q === '') return model.events
    return model.events.filter((ev) => {
      if (
        activeLevels.size > 0 &&
        (ev.level === null || !activeLevels.has(ev.level))
      ) {
        return false
      }
      return q === '' || ev.name.toLowerCase().includes(q)
    })
  }, [model, activeLevels, nameQuery])

  const visible =
    filtered.length > MAX_ROWS ? filtered.slice(0, MAX_ROWS) : filtered

  const toggleLevel = (level: Level) => {
    setActiveLevels((prev) => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  return (
    <section className="panel ev">
      <div className="ev-toolbar">
        <div className="ev-chips">
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={
                activeLevels.has(level) ? 'chip ev-chip active' : 'chip ev-chip'
              }
              style={{ '--ev-level': `var(--level-${level})` } as CSSProperties}
              onClick={() => toggleLevel(level)}
            >
              <span className="swatch ev-chip-swatch" />
              {level}
            </button>
          ))}
        </div>
        <input
          className="input ev-filter"
          placeholder="filter by event name"
          value={nameQuery}
          onChange={(e) => setNameQuery(e.target.value)}
        />
        <span className="ev-count faint mono-num">
          {filtered.length} of {model.events.length} events
        </span>
      </div>

      {model.events.length === 0 ? (
        <div className="empty-state">no events in this trace</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">no events match the filters</div>
      ) : (
        <div className="ev-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>offset</th>
                <th>clock</th>
                <th>level</th>
                <th>name</th>
                <th>span</th>
                <th>instance</th>
                <th>attributes</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((ev, i) => {
                const instance = instancesById.get(ev.instanceId)
                const span = model.spans.get(ev.spanId)
                const inSelectedSpan = ev.spanId === selectedSpanId
                return (
                  <tr
                    key={i}
                    className={inSelectedSpan ? 'selected' : undefined}
                    onClick={() => onSelectEvent(ev)}
                  >
                    <td className="mono-num ev-offset">{formatNs(ev.timeNs)}</td>
                    <td className="mono-num">
                      {formatClock(model.startUnixMs + ev.timeNs / 1e6)}
                    </td>
                    <td>
                      {ev.level !== null ? (
                        <span className={`level level-${ev.level}`}>
                          {ev.level}
                        </span>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="ev-name">{ev.name}</td>
                    <td>
                      <button
                        type="button"
                        className={`ev-span-link${inSelectedSpan ? ' ev-span-link-hl' : ''}`}
                        title={
                          inSelectedSpan
                            ? 'this row belongs to the selected span'
                            : 'open span details'
                        }
                        onClick={(e) => {
                          e.stopPropagation()
                          onSelectSpan(ev.spanId)
                        }}
                      >
                        {span !== undefined ? span.name : shortId(ev.spanId)}
                      </button>
                    </td>
                    <td>
                      <span className="ev-instance">
                        <span
                          className="swatch"
                          style={{
                            background: instanceColorVar(
                              instance?.colorIndex ?? 0,
                            ),
                          }}
                        />
                        {(() => {
                          const n =
                            instance !== undefined ? instance.serviceName : ev.instanceId
                          return (
                            <span className="inst-name" title={n}>
                              {n}
                            </span>
                          )
                        })()}
                      </span>
                    </td>
                    <td className="ev-attrs faint">
                      {attrsPreview(ev.attributes)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {filtered.length > MAX_ROWS && (
            <div className="ev-notice faint">
              showing first {MAX_ROWS} of {filtered.length}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
