import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faFileExport, faMoon, faSun } from '@fortawesome/free-solid-svg-icons'
import { ApiClient } from './api/client'
import EventDetails from './components/EventDetails'
import ExportModal from './components/ExportModal'
import EventsView from './components/EventsView'
import SpanStats from './components/SpanStats'
import HeatMap from './components/HeatMap'
import FlameGraph from './components/FlameGraph'
import SearchPanel from './components/SearchPanel'
import SpanDetails from './components/SpanDetails'
import TraceList from './components/TraceList'
import { shortId } from './lib/format'
import {
  DEFAULT_FILTER,
  type EventSummary,
  type FilterState,
  type RangeSelection,
  type SearchTarget,
  type SpanEvent,
  type TimeRange,
  type TraceSummary,
} from './lib/model'
import { DEFAULT_RANGE, resolveRange } from './lib/range'
import './App.css'

// ----------------------------------------------------------------- routing --

type Route = { view: 'search' } | { view: 'trace'; traceId: string }

function parseHash(): Route {
  const m = /^#\/trace\/([0-9a-fA-F]+)/.exec(window.location.hash)
  return m ? { view: 'trace', traceId: m[1].toLowerCase() } : { view: 'search' }
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(parseHash)
  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const navigate = useCallback((r: Route) => {
    window.location.hash = r.view === 'trace' ? `/trace/${r.traceId}` : '/search'
  }, [])
  return [route, navigate]
}

// ---------------------------------------------------------------- settings --

type Theme = 'dark' | 'light'

// Fixed API base. The tracer API server (which talks to the deploy-time
// TEMPO_URL) serves it in production; in dev the Vite server proxies it to
// `bun run dev:api`. There is no in-app endpoint setting.
const API_BASE = '/api/v1'

export default function App() {
  const [route, navigate] = useRoute()

  // The theme defaults to the OS preference and tracks it live. The toolbar
  // toggle is an in-memory override only — never persisted, and reset by the
  // next OS theme change.
  const [theme, setTheme] = useState<Theme>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
  )
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) =>
      setTheme(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // The API endpoint is fixed at the relative /api/v1 path; the deployment
  // (the API server's TEMPO_URL, or the dev Vite proxy) decides what backs it.
  const client = useMemo(() => new ApiClient(API_BASE), [])

  const connected = useQuery({
    queryKey: ['ping'],
    queryFn: () => client.ping(),
    // Quick cadence so the status dot recovers within seconds of Tempo
    // coming back (ping never throws, so no retry/backoff involved).
    refetchInterval: 5_000,
    retry: false,
  })

  // ------------------------------------------------------------- search --

  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER)
  // Mirror of `filter` updated synchronously in the change handler so that a
  // search fired in the same event as a filter edit (e.g. Enter committing a
  // provider chip then bubbling to the panel's search handler) snapshots the
  // just-edited filter rather than the render-time closure.
  const filterRef = useRef(filter)
  const onFilterChange = useCallback((f: FilterState) => {
    filterRef.current = f
    setFilter(f)
  }, [])
  const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE)
  // Mirror of `range` so an Enter-fired search snapshots the just-picked range.
  const rangeRef = useRef(range)
  const onRangeChange = useCallback((r: RangeSelection) => {
    rangeRef.current = r
    setRange(r)
  }, [])
  // What the search targets: spans (trace rows) or events (event rows).
  const [target, setTarget] = useState<SearchTarget>('spans')
  const targetRef = useRef(target)

  // Snapshot of (filter, target, range) captured when a search fires; bumping
  // `nonce` is what actually triggers the query. `rangeSel` is retained so a
  // refresh re-anchors relative ranges to "now" while keeping absolute ones
  // fixed (and keeps Live live). Initialized so results stream immediately.
  const [submitted, setSubmitted] = useState<{
    filter: FilterState
    target: SearchTarget
    rangeSel: RangeSelection
    range: TimeRange
    nonce: number
  }>(() => ({
    filter: DEFAULT_FILTER,
    target: 'spans',
    rangeSel: DEFAULT_RANGE,
    range: resolveRange(DEFAULT_RANGE, Date.now()),
    nonce: 1,
  }))

  const onSearch = useCallback(() => {
    setSubmitted((prev) => ({
      filter: filterRef.current,
      target: targetRef.current,
      rangeSel: rangeRef.current,
      range: resolveRange(rangeRef.current, Date.now()),
      nonce: prev.nonce + 1,
    }))
  }, [])

  // Switching the results tab re-submits the current filter for the new
  // target right away.
  const onTargetChange = useCallback(
    (t: SearchTarget) => {
      targetRef.current = t
      setTarget(t)
      onSearch()
    },
    [onSearch],
  )

  // Re-run the LAST SUBMITTED filter (not the draft), re-resolving its range.
  const onRefresh = useCallback(() => {
    setSubmitted((prev) => ({
      ...prev,
      range: resolveRange(prev.rangeSel, Date.now()),
      nonce: prev.nonce + 1,
    }))
  }, [])

  const [refreshSec, setRefreshSec] = useState(15)
  useEffect(() => {
    if (refreshSec === 0 || route.view !== 'search') return
    const id = setInterval(onRefresh, refreshSec * 1000)
    // submitted.nonce in the deps restarts the timer whenever any search or
    // manual refresh fires, so the next auto tick is a full period away.
    return () => clearInterval(id)
  }, [refreshSec, onRefresh, submitted.nonce, route.view])

  type SearchResult =
    | { kind: 'spans'; rows: TraceSummary[] }
    | { kind: 'events'; rows: EventSummary[] }
  const search = useQuery<SearchResult>({
    queryKey: ['search', submitted.nonce],
    queryFn: async (): Promise<SearchResult> =>
      submitted.target === 'spans'
        ? { kind: 'spans', rows: await client.searchTraces(submitted.filter, submitted.range) }
        : { kind: 'events', rows: await client.searchEvents(submitted.filter, submitted.range) },
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  })
  const queryTraces = search.data?.kind === 'spans' ? search.data.rows : null
  const queryEvents = search.data?.kind === 'events' ? search.data.rows : null

  // -------------------------------------------------------------- trace --

  const traceId = route.view === 'trace' ? route.traceId : null
  const trace = useQuery({
    queryKey: ['trace', traceId],
    queryFn: () => client.fetchTrace(traceId!),
    enabled: traceId !== null,
  })
  const model = trace.data ?? null

  const [tab, setTab] = useState<'flame' | 'events' | 'stats' | 'heatmap'>('flame')
  // The details pane shows either a span or an event.
  const [selected, setSelected] = useState<
    { kind: 'span'; spanId: string } | { kind: 'event'; event: SpanEvent } | null
  >(null)
  // The flamegraph outlines the selected span — for events, the owning span.
  const selectedSpanId =
    selected === null
      ? null
      : selected.kind === 'span'
        ? selected.spanId
        : selected.event.spanId
  const selectSpan = useCallback((id: string | null) => {
    setSelected(id === null ? null : { kind: 'span', spanId: id })
  }, [])
  const selectEvent = useCallback((event: SpanEvent) => {
    setSelected({ kind: 'event', event })
  }, [])
  const [hiddenInstances, setHiddenInstances] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [exportOpen, setExportOpen] = useState(false)
  const onToggleInstance = useCallback((id: string) => {
    setHiddenInstances((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  // Any hidden → reveal all; none hidden → hide all.
  const onToggleAllInstances = useCallback(() => {
    setHiddenInstances((prev) =>
      prev.size > 0 ? new Set() : new Set(model?.instances.map((i) => i.id) ?? []),
    )
  }, [model])

  // Reset per-trace UI state when switching traces.
  const lastTraceRef = useRef<string | null>(null)
  useEffect(() => {
    if (traceId !== lastTraceRef.current) {
      lastTraceRef.current = traceId
      setSelected(null)
      setHiddenInstances(new Set())
      setExportOpen(false)
      setTab('flame')
    }
  }, [traceId])

  // When a trace is opened from search results, carry the search context in:
  // hide instances the service filter excluded. Opening an EVENT result also
  // pre-focuses that event's details pane; plain trace opens pre-select
  // nothing — the details pane stays closed until the user clicks something.
  const focusRef = useRef<{
    traceId: string
    services: string[]
    event?: { spanId: string; name: string }
  } | null>(null)

  const openTrace = useCallback(
    (id: string) => {
      focusRef.current = {
        traceId: id,
        services: submitted.filter.services,
      }
      navigate({ view: 'trace', traceId: id })
    },
    [navigate, submitted],
  )

  const openEvent = useCallback(
    (e: EventSummary) => {
      focusRef.current = {
        traceId: e.traceId,
        services: submitted.filter.services,
        event: { spanId: e.spanId, name: e.eventName },
      }
      navigate({ view: 'trace', traceId: e.traceId })
    },
    [navigate, submitted],
  )

  useEffect(() => {
    const focus = focusRef.current
    if (!model || focus === null || focus.traceId !== model.traceId) return
    focusRef.current = null
    if (focus.services.length > 0) {
      const hidden = model.instances
        .filter((i) => !focus.services.includes(i.serviceName))
        .map((i) => i.id)
      // Never hide everything — an empty flamegraph would look broken.
      if (hidden.length < model.instances.length) {
        setHiddenInstances(new Set(hidden))
      }
    }
    if (focus.event !== undefined) {
      const span = model.spans.get(focus.event.spanId)
      const name = focus.event.name
      const ev = span?.events.find((x) => x.name === name)
      if (ev !== undefined) selectEvent(ev)
      else if (span !== undefined) selectSpan(span.spanId)
    }
  }, [model, selectEvent, selectSpan])

  return (
    <div className="app">
      <header className="app-topbar">
        <button
          className="app-logo"
          onClick={() => navigate({ view: 'search' })}
          title="back to search"
        >
          tracer<span className="app-logo-dot">●</span>
        </button>

        {route.view === 'trace' && (
          <div className="app-tracebar">
            <span className="app-traceid mono-num" title={route.traceId}>
              {shortId(route.traceId)}
            </span>
          </div>
        )}

        <div className="app-topbar-spacer" />

        <div className="app-topbar-end">
          <span
            className={`app-conn ${connected.data ? 'ok' : 'down'}`}
            title={connected.data ? 'connected to Tempo' : 'Tempo unreachable'}
          >
            ● {connected.data ? 'tempo' : 'offline'}
          </span>
          <button
            className="btn btn-ghost btn-sm app-icon-btn"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title="toggle theme"
            aria-label="toggle theme"
          >
            <FontAwesomeIcon icon={theme === 'dark' ? faMoon : faSun} />
          </button>
        </div>
      </header>

      {route.view === 'search' ? (
        <main className="app-main app-search view-fade" key="search">
          <SearchPanel
            filter={filter}
            onChange={onFilterChange}
            target={target}
            range={range}
            onRangeChange={onRangeChange}
            onSearch={onSearch}
            searching={search.isFetching}
            client={client}
          />
          <TraceList
            target={target}
            onTargetChange={onTargetChange}
            results={queryTraces}
            events={queryEvents}
            loading={
              search.isLoading ||
              (search.isFetching && search.data?.kind !== submitted.target)
            }
            error={search.error ? String(search.error) : null}
            onOpen={openTrace}
            onOpenEvent={openEvent}
            refreshing={search.isFetching}
            refreshSec={refreshSec}
            onRefreshSecChange={setRefreshSec}
            onRefresh={onRefresh}
          />
        </main>
      ) : (
        <main className="app-main app-trace view-fade" key={route.traceId}>
          {trace.isLoading && (
            <div className="empty-state">
              <div className="spinner" />
              loading trace…
            </div>
          )}
          {trace.error != null && (
            <div className="empty-state app-error">
              failed to load trace: {String(trace.error)}
            </div>
          )}
          {model && (
            <>
              <div className="app-trace-toolbar">
                <div className="app-tabs">
                  <button
                    className={`chip ${tab === 'flame' ? 'active' : ''}`}
                    onClick={() => setTab('flame')}
                  >
                    flame
                  </button>
                  <button
                    className={`chip ${tab === 'events' ? 'active' : ''}`}
                    onClick={() => setTab('events')}
                  >
                    events ({model.events.length})
                  </button>
                  <button
                    className={`chip ${tab === 'stats' ? 'active' : ''}`}
                    onClick={() => setTab('stats')}
                  >
                    stats
                  </button>
                  <button
                    className={`chip ${tab === 'heatmap' ? 'active' : ''}`}
                    onClick={() => setTab('heatmap')}
                  >
                    heatmap
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm app-export"
                  title="export the displayed spans and events as JSON"
                  onClick={() => setExportOpen(true)}
                >
                  <FontAwesomeIcon icon={faFileExport} /> export
                </button>
                {model.warnings.length > 0 && (
                  <span
                    className="app-warnings level-warn"
                    title={model.warnings.join('\n')}
                  >
                    ⚠ {model.warnings.length}
                  </span>
                )}
              </div>
              {exportOpen && (
                <ExportModal
                  model={model}
                  hiddenInstances={hiddenInstances}
                  onClose={() => setExportOpen(false)}
                />
              )}
              <div className={`app-trace-body ${selected ? 'with-details' : ''}`}>
                <div className="app-trace-canvas">
                  {tab === 'flame' && (
                    <FlameGraph
                      model={model}
                      mode="instances"
                      selectedSpanId={selectedSpanId}
                      onSelect={selectSpan}
                      onSelectEvent={selectEvent}
                      hiddenInstances={hiddenInstances}
                      onToggleInstance={onToggleInstance}
                      onToggleAll={onToggleAllInstances}
                    />
                  )}
                  {tab === 'events' && (
                    <EventsView
                      model={model}
                      selectedSpanId={selectedSpanId}
                      onSelectSpan={selectSpan}
                      onSelectEvent={selectEvent}
                    />
                  )}
                  {tab === 'stats' && <SpanStats model={model} />}
                  {tab === 'heatmap' && <HeatMap model={model} />}
                </div>
                {selected?.kind === 'span' && (
                  <SpanDetails
                    model={model}
                    spanId={selected.spanId}
                    onClose={() => selectSpan(null)}
                    onSelectSpan={selectSpan}
                    onSelectEvent={selectEvent}
                  />
                )}
                {selected?.kind === 'event' && (
                  <EventDetails
                    model={model}
                    event={selected.event}
                    onClose={() => selectSpan(null)}
                    onSelectSpan={selectSpan}
                  />
                )}
              </div>
            </>
          )}
        </main>
      )}
    </div>
  )
}
