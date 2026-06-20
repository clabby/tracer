/*
 * Shared data model — the authoritative contract between every module in the
 * app. All components, the Tempo client, and the trace parser import their
 * types from here. Do not redefine these shapes elsewhere.
 */

// ----------------------------------------------------------------- levels --

export type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export const LEVELS: readonly Level[] = ['trace', 'debug', 'info', 'warn', 'error']

/** Extract a level from OTLP attributes (`level`, `log.level`, `severity`). */
export function levelFromAttributes(attrs: Attributes): Level | null {
  const raw = attrs['level'] ?? attrs['log.level'] ?? attrs['severity']
  if (typeof raw !== 'string') return null
  const lower = raw.toLowerCase()
  return (LEVELS as readonly string[]).includes(lower) ? (lower as Level) : null
}

// ------------------------------------------------------------- attributes --

export type AttrPrimitive = string | number | boolean
export type Attributes = Record<string, AttrPrimitive>

// ------------------------------------------------------------------ spans --

export type SpanKind =
  | 'unspecified'
  | 'internal'
  | 'server'
  | 'client'
  | 'producer'
  | 'consumer'

export type SpanStatus = 'unset' | 'ok' | 'error'

export interface SpanEvent {
  name: string
  /** Nanoseconds relative to `TraceModel.startUnixMs`. */
  timeNs: number
  attributes: Attributes
  level: Level | null
  /** Owning span. */
  spanId: string
  instanceId: string
}

export interface SpanNode {
  spanId: string
  parentSpanId: string | null
  traceId: string
  name: string
  kind: SpanKind
  /** Nanoseconds relative to `TraceModel.startUnixMs`. */
  startNs: number
  durationNs: number
  attributes: Attributes
  events: SpanEvent[]
  status: SpanStatus
  statusMessage: string
  level: Level | null
  /** Id of the `Instance` (provider/node) that emitted this span. */
  instanceId: string
  children: SpanNode[]
  /** 0 for roots, parent.depth + 1 otherwise. */
  depth: number
}

// -------------------------------------------------------------- instances --

/**
 * An instance is one emitting process — typically one node of the distributed
 * system. Derived from OTLP resource attributes (`service.name`, plus
 * `service.instance.id` when present).
 */
export interface Instance {
  /** Stable unique id, e.g. `node-2` or `node-2#a1b2`. */
  id: string
  serviceName: string
  instanceTag: string | null
  /** Hue (0-359) for this instance's generated color; see colorIndexForService. */
  colorIndex: number
  spanCount: number
  rootSpans: SpanNode[]
  /** Deepest span depth within this instance, for lane layout. */
  maxDepth: number
}

/**
 * CSS color for an instance: its hue at the theme's instance saturation and
 * lightness (`--instance-sat` / `--instance-lum`). The hue is generated, not
 * drawn from a fixed palette, so any number of instances (50, 500, …) each get
 * a distinct color, and switching themes recolors via the CSS vars alone.
 */
export function instanceColorVar(colorIndex: number): string {
  return `hsl(${colorIndex} var(--instance-sat) var(--instance-lum))`
}

/**
 * Stable hue (0-359) for a service name — THE single color-derivation function
 * for instances, used on every surface (search swatches, provider chips,
 * flamegraph lanes, stats, details) so one instance is one color everywhere,
 * with no shared state.
 *
 * FNV-1a hashes the name, then Knuth's multiplicative hash maps it onto the hue
 * wheel. The multiply is what spreads near-sequential names (`node-0`, `node-1`,
 * …) far apart — a plain `% 360` aliases them into a couple of clustered hues
 * (the "every node is blue or orange" failure). It also degrades gracefully:
 * arbitrarily many instances stay well distributed.
 */
export function colorIndexForService(serviceName: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < serviceName.length; i++) {
    h ^= serviceName.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const mixed = Math.imul(h, 0x9e3779b1) >>> 0 // 2654435761 ≈ 2^32 / φ
  return Math.floor((mixed / 0x1_0000_0000) * 360)
}

// ------------------------------------------------------------ trace model --

export interface TraceModel {
  traceId: string
  /** Epoch milliseconds of the earliest span start. */
  startUnixMs: number
  /** Extent from earliest start to latest end, nanoseconds. */
  durationNs: number
  instances: Instance[]
  /** Every span, keyed by spanId. */
  spans: Map<string, SpanNode>
  /** Every event across all spans, sorted by timeNs. */
  events: SpanEvent[]
  /** Non-fatal parse anomalies (orphan spans, missing times, ...). */
  warnings: string[]
}

export interface MatchedSpanSummary {
  spanId: string
  name: string
  attributes: Attributes
}

// ------------------------------------------------------------ comparison --

/**
 * One node's contribution to a cross-trace comparison: the span that matched
 * the compare query (a span name plus an attribute) and the `Instance` that
 * emitted it. Each match's subtree becomes one lane in the assembled
 * comparison trace.
 */
export interface SpanMatch {
  instance: Instance
  root: SpanNode
  /**
   * Epoch ms of the source trace's earliest span, used to place this lane on
   * the shared time axis: the root's absolute start is
   * `startUnixMs + root.startNs / 1e6`.
   */
  startUnixMs: number
}

// ----------------------------------------------------- aggregated flame --

/**
 * The merged ("aggregate") flame tree groups spans from all instances by
 * their path (root → ... → name). Each node carries per-instance span lists
 * so the flamegraph can draw one sub-bar per instance, colored by instance.
 */
export interface AggregateNode {
  /** Names joined by '' from root to this node. */
  pathKey: string
  name: string
  depth: number
  children: AggregateNode[]
  /** instanceId → spans from that instance matching this path. */
  spans: Map<string, SpanNode[]>
  count: number
  minNs: number
  maxNs: number
  meanNs: number
  totalNs: number
}

// ---------------------------------------------------------------- filters --

export type AttrOp = '=' | '!=' | '=~' | '!~' | '>' | '<' | '>=' | '<='

/** What the search targets: spans (trace results) or events (event results). */
export type SearchTarget = 'spans' | 'events'

export interface AttrFilter {
  /** Local uid for React keys. */
  id: string
  scope: 'span' | 'resource' | 'event'
  key: string
  op: AttrOp
  value: string
}

export interface FilterState {
  /** Selected providers (`resource.service.name`). Empty = all. */
  services: string[]
  /** Span name match. Interpreted as regex when `nameIsRegex`. */
  name: string
  nameIsRegex: boolean
  /** Selected levels (span attribute `level`). Empty = all. */
  levels: Level[]
  attrs: AttrFilter[]
  /** Duration bounds as human strings ("150ms", "2s"). Empty = unset. */
  minDuration: string
  maxDuration: string
  errorsOnly: boolean
  /** Raw TraceQL escape hatch; when non-empty it overrides everything else. */
  rawQuery: string
  limit: number
}

export const DEFAULT_FILTER: FilterState = {
  services: [],
  name: '',
  nameIsRegex: true,
  levels: [],
  attrs: [],
  minDuration: '',
  maxDuration: '',
  errorsOnly: false,
  rawQuery: '',
  limit: 50,
}

/**
 * True when the filter narrows results beyond the default "show all" — any
 * service, name, level, non-blank attribute, duration bound, errors-only, or
 * raw query. Drives whether a "clear" affordance is offered. `limit` and
 * `nameIsRegex` alone don't count: they tune a query, they aren't one.
 */
export function isFilterConfigured(filter: FilterState): boolean {
  return (
    filter.services.length > 0 ||
    filter.name.trim() !== '' ||
    filter.levels.length > 0 ||
    filter.attrs.some((a) => a.key.trim() !== '') ||
    filter.minDuration.trim() !== '' ||
    filter.maxDuration.trim() !== '' ||
    filter.errorsOnly ||
    filter.rawQuery.trim() !== ''
  )
}

/**
 * True when the filter pins one operation with an exact span attribute — what
 * the `/compare` route requires to correlate the same span across nodes.
 */
export function hasComparePinningAttr(filter: FilterState): boolean {
  return filter.attrs.some((a) => {
    if (a.scope !== 'span') return false
    if (a.op !== '=') return false
    if (a.key.trim() === '') return false
    return a.value.trim() !== ''
  })
}

/** Time range in unix seconds. */
export interface TimeRange {
  from: number
  to: number
}

/**
 * A user's time-range choice. Relative ranges re-anchor to "now" each time
 * they're resolved (search/refresh); absolute ranges are fixed wall-clock
 * bounds in epoch milliseconds.
 */
export type RangeSelection =
  | { kind: 'relative'; seconds: number }
  | { kind: 'absolute'; fromMs: number; toMs: number }

// ----------------------------------------------------------- search model --

export interface TraceSummary {
  traceId: string
  rootServiceName: string
  rootTraceName: string
  startUnixMs: number
  durationMs: number
  /** Total spans in the trace (Tempo serviceStats; matched-span count if absent). */
  spanCount: number
  /** Distinct service names seen in the trace, when available. */
  services: string[]
  /** Ids of the spans the search query actually matched (may be empty). */
  matchedSpanIds: string[]
  /** Name of each matched span, one entry per span (duplicates expected). */
  matchedSpanNames: string[]
  /** Matched spans with the attributes Tempo returned for the span set. */
  matchedSpans: MatchedSpanSummary[]
}

/** One matched event from an event-targeted search (span-level fidelity). */
export interface EventSummary {
  traceId: string
  spanId: string
  spanName: string
  eventName: string
  level: Level | null
  serviceName: string
  /** Owning span's start (Tempo search doesn't expose event timestamps). */
  spanStartUnixMs: number
  spanDurationNs: number
  /** Attributes Tempo returned for the matched span/event row. */
  attributes: Attributes
}

/** Stable identity for merge/dedup of event results. */
export function eventSummaryKey(e: EventSummary): string {
  return `${e.spanId}:${e.eventName}`
}

// ----------------------------------------------------------- tempo client --

export type TagScope = 'span' | 'resource' | 'event'

/**
 * Scopes attribute-name suggestions to one span (or event) name, so the key
 * dropdown offers only attributes actually seen on the spans the search targets
 * — not every attribute in the store.
 */
export interface TagNameContext {
  target: SearchTarget
  name: string
  nameIsRegex: boolean
}

export interface ITempoClient {
  readonly baseUrl: string
  searchTraces(filter: FilterState, range: TimeRange): Promise<TraceSummary[]>
  /** Search for spans containing matching events; one row per span+name. */
  searchEvents(filter: FilterState, range: TimeRange): Promise<EventSummary[]>
  fetchTrace(traceId: string): Promise<TraceModel>
  /** Tag name suggestions for the given scope, optionally scoped to a name. */
  tagNames(scope: TagScope, q?: string, context?: TagNameContext): Promise<string[]>
  /** Tag value suggestions, e.g. tagValues('service.name', 'resource'). */
  tagValues(tag: string, scope: TagScope, q?: string): Promise<string[]>
  ping(): Promise<boolean>
}

// -------------------------------------------------------- component props --

export type FlameMode = 'instances' | 'merged'

export interface FlameGraphProps {
  model: TraceModel
  mode: FlameMode
  selectedSpanId: string | null
  onSelect: (spanId: string | null) => void
  /** Clicked an event marker: open that event's details pane. */
  onSelectEvent: (event: SpanEvent) => void
  hiddenInstances: ReadonlySet<string>
  onToggleInstance: (instanceId: string) => void
  /** Show all instances when any are hidden; otherwise hide all. */
  onToggleAll: () => void
}

export interface SpanStatsProps {
  model: TraceModel
}

export interface HeatMapProps {
  model: TraceModel
}

export interface SearchPanelProps {
  filter: FilterState
  onChange: (f: FilterState) => void
  /** Current search target — drives labels and suggestion scopes. */
  target: SearchTarget
  range: RangeSelection
  onRangeChange: (r: RangeSelection) => void
  onSearch: () => void
  searching: boolean
  client: ITempoClient
}

export interface TraceListProps {
  /** Active tab; the header tabs switch it. */
  target: SearchTarget
  onTargetChange: (t: SearchTarget) => void
  results: TraceSummary[] | null
  /** Event results, shown when target === 'events'. */
  events: EventSummary[] | null
  /** Synthetic search rows keyed to their compare URL query. */
  compareQueries: Readonly<Record<string, string>>
  loading: boolean
  error: string | null
  /** Open a trace. `matchedSpanIds` are the spans the query hit in that trace;
   *  the view focuses the single match when unambiguous (else the root / nothing). */
  onOpen: (traceId: string, matchedSpanIds: string[]) => void
  onOpenCompare: (query: string) => void
  /** Open an event result: navigate to its trace with the event focused. */
  onOpenEvent: (event: EventSummary) => void
  /** True while a refetch is in flight (initial load uses `loading`). */
  refreshing: boolean
  /** Auto-refresh cadence in seconds; 0 = off. */
  refreshSec: number
  onRefreshSecChange: (sec: number) => void
  /** Explicit refresh; also resets the auto-refresh timer. */
  onRefresh: () => void
}

export interface SpanDetailsProps {
  model: TraceModel
  spanId: string | null
  onClose: () => void
  onSelectSpan: (spanId: string) => void
  /** Open the event details pane for one of this span's events. */
  onSelectEvent: (event: SpanEvent) => void
}

export interface EventDetailsProps {
  model: TraceModel
  event: SpanEvent
  onClose: () => void
  /** Link back to the owning (or any other) span's details. */
  onSelectSpan: (spanId: string) => void
}

export interface EventsViewProps {
  model: TraceModel
  selectedSpanId: string | null
  onSelectSpan: (spanId: string) => void
  /** Row click: open the event details pane. */
  onSelectEvent: (event: SpanEvent) => void
}
