import type { EventDetailsProps } from '../lib/model'
import { instanceColorVar } from '../lib/model'
import { formatClock, formatNs } from '../lib/format'
import './EventDetails.css'

export default function EventDetails({
  model,
  event,
  onClose,
  onSelectSpan,
}: EventDetailsProps) {
  const span = model.spans.get(event.spanId)
  const instance = model.instances.find((i) => i.id === event.instanceId)
  const attrKeys = Object.keys(event.attributes).sort()

  return (
    <aside className="panel ed">
      <div className="panel-header ed-header">
        <span className="ed-kind faint">event</span>
        <span className="ed-name" title={event.name}>
          {event.name}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm ed-close"
          onClick={onClose}
          aria-label="close event details"
        >
          ×
        </button>
      </div>

      <div className="ed-body">
        <div className="ed-grid">
          <span className="label ed-k">level</span>
          <span className="ed-v">
            {event.level !== null ? (
              <span className={`level level-${event.level}`}>{event.level}</span>
            ) : (
              <span className="faint">—</span>
            )}
          </span>

          <span className="label ed-k">instance</span>
          <span className="ed-v">
            <span className="chip ed-instance">
              <span
                className="swatch"
                style={{ background: instanceColorVar(instance?.colorIndex ?? 0) }}
              />
              {instance !== undefined ? instance.id : event.instanceId}
            </span>
          </span>

          <span className="label ed-k">clock</span>
          <span className="ed-v mono-num">
            {formatClock(model.startUnixMs + event.timeNs / 1e6)}
          </span>

          <span className="label ed-k">trace offset</span>
          <span className="ed-v mono-num">+{formatNs(event.timeNs)}</span>

          {span !== undefined && (
            <>
              <span className="label ed-k">span offset</span>
              <span className="ed-v mono-num">
                +{formatNs(event.timeNs - span.startNs)}
              </span>
            </>
          )}
        </div>

        <div className="ed-section">
          <div className="panel-title">span</div>
          {span !== undefined ? (
            <button
              type="button"
              className="ed-span-link"
              onClick={() => onSelectSpan(span.spanId)}
              title="open span details"
            >
              <span className="ed-span-name">{span.name}</span>
              <span className="faint mono-num">{formatNs(span.durationNs)}</span>
            </button>
          ) : (
            <span className="faint">span not in trace ({event.spanId})</span>
          )}
        </div>

        <div className="ed-section">
          <div className="panel-title">attributes</div>
          {attrKeys.length === 0 ? (
            <div className="faint">none</div>
          ) : (
            <table className="ed-attrs">
              <tbody>
                {attrKeys.map((k) => (
                  <tr key={k}>
                    <td className="ed-attr-k">{k}</td>
                    <td className="ed-attr-v">{String(event.attributes[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </aside>
  )
}
