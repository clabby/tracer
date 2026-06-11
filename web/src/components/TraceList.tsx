import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowsRotate } from '@fortawesome/free-solid-svg-icons'
import type { EventSummary, TraceListProps, TraceSummary } from '../lib/model'
import { colorIndexForService, eventSummaryKey, instanceColorVar } from '../lib/model'
import {
  formatAgo,
  formatClock,
  formatDateTime,
  formatNs,
  shortId,
} from '../lib/format'
import Select from './Select'
import './TraceList.css'

const MAX_SWATCHES = 4

function ServicesCell({ services }: { services: string[] }) {
  const sorted = [...services].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )
  const shown = sorted.slice(0, MAX_SWATCHES)
  return (
    <span className="tl-services" title={sorted.join(', ')}>
      {shown.map((s) => (
        <span
          key={s}
          className="swatch"
          style={{ background: instanceColorVar(colorIndexForService(s)) }}
        />
      ))}
      {sorted.length > MAX_SWATCHES && (
        <span className="tl-more faint">+{sorted.length - MAX_SWATCHES}</span>
      )}
    </span>
  )
}

/** "exchange ×4" — matched span names grouped with per-name counts. */
function matchedSummary(names: string[]): string {
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  return [...counts.entries()]
    .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
    .join(', ')
}

const SORT_OPTIONS = [
  { label: 'most recent', value: 'recent' },
  { label: 'slowest', value: 'slowest' },
  { label: 'most spans', value: 'spans' },
]
type SortOrder = 'recent' | 'slowest' | 'spans'

function Row({
  trace,
  onOpen,
  maxMs,
}: {
  trace: TraceSummary
  onOpen: (traceId: string) => void
  maxMs: number
}) {
  return (
    <tr onClick={() => onOpen(trace.traceId)}>
      <td className="tl-id mono-num" title={trace.traceId}>
        {shortId(trace.traceId)}
      </td>
      <td className="tl-name">
        {trace.rootTraceName}
        {trace.matchedSpanNames.length > 0 &&
          matchedSummary(trace.matchedSpanNames) !== trace.rootTraceName && (
            <span
              className="tl-matched faint"
              title={`spans matched by the query: ${matchedSummary(trace.matchedSpanNames)}`}
            >
              → {matchedSummary(trace.matchedSpanNames)}
            </span>
          )}
      </td>
      <td className="tl-start" title={formatDateTime(trace.startUnixMs)}>
        <span className="mono-num">{formatClock(trace.startUnixMs)}</span>
        <span className="tl-ago faint">{formatAgo(trace.startUnixMs)}</span>
      </td>
      <td className="tl-num tl-dur">
        <span
          className="tl-dur-bar"
          style={{ width: `${maxMs > 0 ? Math.min(100, (trace.durationMs / maxMs) * 100) : 0}%` }}
        />
        <span className="tl-dur-val mono-num">{formatNs(trace.durationMs * 1e6)}</span>
      </td>
      <td className="tl-num mono-num">{trace.spanCount}</td>
      <td>
        <ServicesCell services={trace.services} />
      </td>
    </tr>
  )
}

function EventRow({
  event,
  onOpen,
}: {
  event: EventSummary
  onOpen: (e: EventSummary) => void
}) {
  return (
    <tr onClick={() => onOpen(event)}>
      <td className="tl-start" title={formatDateTime(event.spanStartUnixMs)}>
        <span className="mono-num">{formatClock(event.spanStartUnixMs)}</span>
        <span className="tl-ago faint">{formatAgo(event.spanStartUnixMs)}</span>
      </td>
      <td className={event.level !== null ? `tl-event level-${event.level}` : 'tl-event'}>
        {event.eventName}
      </td>
      <td className="tl-name">{event.spanName}</td>
      <td>
        <span className="tl-service-cell">
          <span
            className="swatch"
            style={{
              background: instanceColorVar(colorIndexForService(event.serviceName)),
            }}
          />
          {event.serviceName}
        </span>
      </td>
      <td className="tl-num mono-num">{formatNs(event.spanDurationNs)}</td>
      <td className="tl-id mono-num" title={event.traceId}>
        {shortId(event.traceId)}
      </td>
    </tr>
  )
}

const REFRESH_OPTIONS = [
  { label: 'off', value: 0 },
  { label: '5s', value: 5 },
  { label: '15s', value: 15 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
]

export default function TraceList({
  target,
  onTargetChange,
  results,
  events,
  loading,
  error,
  onOpen,
  onOpenEvent,
  refreshing,
  refreshSec,
  onRefreshSecChange,
  onRefresh,
}: TraceListProps) {
  const forEvents = target === 'events'
  const count = forEvents ? events?.length : results?.length
  const hasRows = forEvents ? events !== null : results !== null

  const [order, setOrder] = useState<SortOrder>('recent')
  const maxMs = useMemo(
    () => (results ? Math.max(1, ...results.map((t) => t.durationMs)) : 1),
    [results],
  )
  const ordered = useMemo(() => {
    if (!results) return results
    if (order === 'recent') return results
    const r = [...results]
    r.sort((a, b) => (order === 'slowest' ? b.durationMs - a.durationMs : b.spanCount - a.spanCount))
    return r
  }, [results, order])

  let body: ReactNode
  if (loading) {
    body = (
      <div className="empty-state">
        <span className="spinner" />
        <span>searching…</span>
      </div>
    )
  } else if (error !== null) {
    body = <div className="empty-state tl-error">{error}</div>
  } else if (!hasRows) {
    body = <div className="empty-state">run a search</div>
  } else if (count === 0) {
    body = (
      <div className="empty-state">
        {forEvents
          ? 'no events matched — widen the time range or relax filters'
          : 'no traces matched — widen the time range or relax filters'}
      </div>
    )
  } else if (forEvents) {
    body = (
      <div className="tl-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>start</th>
              <th>event</th>
              <th>span</th>
              <th>service</th>
              <th className="tl-num">span duration</th>
              <th>trace</th>
            </tr>
          </thead>
          <tbody>
            {events!.map((e) => (
              <EventRow key={eventSummaryKey(e)} event={e} onOpen={onOpenEvent} />
            ))}
          </tbody>
        </table>
      </div>
    )
  } else {
    body = (
      <div className="tl-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>trace</th>
              <th>name</th>
              <th>start</th>
              <th className="tl-num">duration</th>
              <th className="tl-num">spans</th>
              <th>services</th>
            </tr>
          </thead>
          <tbody>
            {ordered!.map((t) => (
              <Row key={t.traceId} trace={t} onOpen={onOpen} maxMs={maxMs} />
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <section className="panel tl">
      <div className="panel-header">
        <span className="tl-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={!forEvents}
            className={`tl-tab${forEvents ? '' : ' active'}`}
            onClick={() => onTargetChange('spans')}
          >
            spans
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={forEvents}
            className={`tl-tab${forEvents ? ' active' : ''}`}
            onClick={() => onTargetChange('events')}
          >
            events
          </button>
        </span>
        {!loading && error === null && count !== undefined && (
          <span className="tl-count faint mono-num">{count}</span>
        )}
        <span className="tl-actions">
          {!forEvents && (
            <span className="tl-sort-ctl">
              <span className="tl-control-label">sort</span>
              <Select
                className="tl-sort"
                label="sort traces"
                value={order}
                options={SORT_OPTIONS}
                onChange={(v) => setOrder(v as SortOrder)}
              />
            </span>
          )}
          <span className="tl-refresh">
            <span className="faint tl-refresh-label">refresh</span>
            <Select
              className="tl-refresh-select"
              label="auto-refresh interval"
              value={refreshSec}
              options={REFRESH_OPTIONS}
              onChange={onRefreshSecChange}
            />
            <button
              type="button"
              className="btn btn-sm tl-refresh-btn"
              onClick={onRefresh}
              disabled={refreshing}
              title="refresh now (resets the timer)"
            >
              {refreshing ? (
                <span className="spinner tl-refresh-spinner" />
              ) : (
                <FontAwesomeIcon icon={faArrowsRotate} />
              )}
            </button>
          </span>
        </span>
      </div>
      {body}
    </section>
  )
}
