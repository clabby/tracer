import { useEffect, useRef, useState } from 'react'
import type { SpanDetailsProps } from '../lib/model'
import { instanceColorVar } from '../lib/model'
import { formatClock, formatNs, shortId } from '../lib/format'
import './SpanDetails.css'

export default function SpanDetails({
  model,
  spanId,
  onClose,
  onSelectSpan,
  onSelectEvent,
}: SpanDetailsProps) {
  const [copied, setCopied] = useState<'span' | 'trace' | null>(null)
  const copyTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const span = spanId !== null ? model.spans.get(spanId) : undefined
  if (span === undefined) return null

  const instance = model.instances.find((i) => i.id === span.instanceId)
  const parent =
    span.parentSpanId !== null ? model.spans.get(span.parentSpanId) : undefined
  const attrKeys = Object.keys(span.attributes).sort()
  const events = [...span.events].sort((a, b) => a.timeNs - b.timeNs)

  const copy = (kind: 'span' | 'trace', text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(kind)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(null), 1200)
  }

  return (
    <aside className="panel sd">
      <div className="panel-header sd-header">
        <span className="sd-name" title={span.name}>
          {span.name}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm sd-close"
          onClick={onClose}
          aria-label="close span details"
        >
          ×
        </button>
      </div>

      <div className="sd-body">
        <div className="sd-grid">
          <span className="label sd-k">instance</span>
          <span className="sd-v">
            <span className="chip sd-instance">
              <span
                className="swatch"
                style={{
                  background: instanceColorVar(instance?.colorIndex ?? 0),
                }}
              />
              {instance !== undefined ? instance.id : span.instanceId}
            </span>
          </span>

          <span className="label sd-k">kind</span>
          <span className="sd-v">{span.kind}</span>

          <span className="label sd-k">level</span>
          <span className="sd-v">
            {span.level !== null ? (
              <span className={`level level-${span.level}`}>{span.level}</span>
            ) : (
              <span className="faint">—</span>
            )}
          </span>

          <span className="label sd-k">status</span>
          <span
            className={span.status === 'error' ? 'sd-v sd-status-error' : 'sd-v'}
          >
            {span.status}
            {span.statusMessage !== '' && (
              <span className="sd-status-msg"> — {span.statusMessage}</span>
            )}
          </span>
        </div>

        <div className="sd-section">
          <div className="panel-title">timing</div>
          <div className="sd-grid">
            <span className="label sd-k">start</span>
            <span className="sd-v mono-num">
              {formatClock(model.startUnixMs + span.startNs / 1e6)}
            </span>
            <span className="label sd-k">offset</span>
            <span className="sd-v mono-num">{formatNs(span.startNs)}</span>
            <span className="label sd-k">duration</span>
            <span className="sd-v mono-num">{formatNs(span.durationNs)}</span>
          </div>
        </div>

        <div className="sd-section">
          <div className="panel-title">attributes</div>
          {attrKeys.length === 0 ? (
            <div className="faint">none</div>
          ) : (
            <table className="data sd-attrs">
              <tbody>
                {attrKeys.map((key) => (
                  <tr key={key}>
                    <td className="sd-attr-key">{key}</td>
                    <td className="sd-attr-val">
                      {String(span.attributes[key])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="sd-section">
          <div className="panel-title">events</div>
          {events.length === 0 ? (
            <div className="faint">none</div>
          ) : (
            <ul className="sd-events">
              {events.map((ev, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className="sd-event"
                    onClick={() => onSelectEvent(ev)}
                    title="open event details"
                  >
                    <span className="sd-event-time mono-num">
                      {formatNs(ev.timeNs - span.startNs)}
                    </span>
                    <span
                      className={
                        ev.level !== null
                          ? `sd-event-name level-${ev.level}`
                          : 'sd-event-name'
                      }
                    >
                      {ev.name}
                    </span>
                    {Object.keys(ev.attributes).length > 0 && (
                      <span className="sd-event-attrs faint">
                        {Object.keys(ev.attributes).length} attrs
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="sd-section">
          <div className="panel-title">relations</div>
          <div className="sd-grid">
            <span className="label sd-k">parent</span>
            <span className="sd-v">
              {parent !== undefined ? (
                <button
                  type="button"
                  className="sd-link"
                  onClick={() => onSelectSpan(parent.spanId)}
                >
                  {parent.name}
                </button>
              ) : span.parentSpanId !== null ? (
                <span className="faint">
                  {shortId(span.parentSpanId)} (missing)
                </span>
              ) : (
                <span className="faint">(root)</span>
              )}
            </span>

            <span className="label sd-k">children</span>
            <span className="sd-v">
              {span.children.length === 0 ? (
                <span className="faint">none</span>
              ) : (
                <ul className="sd-children">
                  {span.children.map((child) => (
                    <li key={child.spanId}>
                      <button
                        type="button"
                        className="sd-link"
                        onClick={() => onSelectSpan(child.spanId)}
                      >
                        {child.name}
                      </button>
                      <span className="sd-child-dur mono-num faint">
                        {formatNs(child.durationNs)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </span>
          </div>
        </div>

        <div className="sd-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => copy('span', span.spanId)}
          >
            {copied === 'span' ? 'copied' : 'copy span id'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => copy('trace', span.traceId)}
          >
            {copied === 'trace' ? 'copied' : 'copy trace id'}
          </button>
        </div>
      </div>
    </aside>
  )
}
