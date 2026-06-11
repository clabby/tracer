/*
 * FlameGraph — canvas-rendered flame chart with two modes:
 *
 *  - 'instances': one stacked lane per visible instance, spans laid out by
 *    startNs/depth on a shared, zoomable time axis.
 *  - 'merged': the aggregate tree from buildAggregateTree(); each node row
 *    draws adjacent sub-bars (one per instance present), sub-bar width
 *    proportional to that instance's mean duration relative to the node's
 *    mean-sum.
 *
 * Rendering is devicePixelRatio-aware and driven by a single
 * requestAnimationFrame scheduler (no rAF loop while idle). Colors are read
 * once per theme via getComputedStyle and invalidated by a MutationObserver
 * watching <html data-theme>. Hit-testing uses rect arrays bucketed by row,
 * so mousemove never scans every span.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { clamp, formatClock, formatNs } from '../lib/format'
import {
  INSTANCE_COLOR_COUNT,
  instanceColorVar,
  type AggregateNode,
  type FlameGraphProps,
  type Instance,
  type Level,
  type SpanEvent,
  type SpanNode,
} from '../lib/model'
import { buildAggregateTree } from '../lib/trace'
import Select from './Select'
import './FlameGraph.css'

// ------------------------------------------------------------- constants --

const RULER_H = 26
const ROW_H = 20
const BAR_H = 16
const BAR_PAD_Y = (ROW_H - BAR_H) / 2 // vertical inset, centers the bar in its row
const CELL_GAP = 2 // horizontal gap carved from each bar's right edge
const CELL_RADIUS = 5 // rounded corners, matching .btn-sm
const CELL_PAD_X = 8 // label inset, matching .btn-sm padding
const GUTTER = 140
const LANE_GAP_ROWS = 1
const MIN_WINDOW_NS = 1000 // 1µs minimum zoom window
const LABEL_MIN_W = 40
// Depth-shade ramp length; deeper frames get a slightly more opaque tint.
const SHADE_LEVELS = 10
const FILL_ALPHA_BASE = 0.9
const FILL_ALPHA_STEP = 0.01
const FILL_ALPHA_MAX = 0.95

// ----------------------------------------------------------------- types --

interface Theme {
  bg: string
  flameBg: string
  flameGrid: string
  border: string
  text: string
  textMuted: string
  textFaint: string
  accent: string
  error: string
  /** Level → color, for event markers and badges. */
  levels: Record<Level, string>
  instances: string[]
  /** Per-instance translucent tint fills, indexed by depth-shade level. */
  fills: string[][]
  /** Per-instance cell border: the vivid base color (lighter than the fill,
      like a .btn edge over its dark surface). */
  borders: string[]
  font: string
  fontSmall: string
  charW: number
  charWSmall: number
}

interface View {
  t0: number
  t1: number
}

interface Geom {
  plotX0: number
  plotW: number
  cssW: number
  cssH: number
}

interface HitRect {
  /** A span bar, or an event-overlay diamond marker. */
  kind: 'span' | 'event'
  x0: number
  x1: number
  name: string
  instanceId: string
  /** Span duration ('instances') or per-instance mean ('merged'). */
  durNs: number
  /** Exclusive (self) time: duration minus children. -1 when not applicable. */
  selfNs: number
  /** Start offset; -1 in merged mode (no time position). */
  startNs: number
  /** 1 in instances mode; per-instance span count in merged mode. */
  count: number
  level: Level | null
  error: boolean
  eventCount: number
  /** Span id passed to onSelect on click (owning span for events). */
  selectId: string
  /** Owning span name, set for kind === 'event'. */
  spanName?: string
  /** The event itself, set for kind === 'event'. */
  event?: SpanEvent
}

type Tip = HitRect & { x: number; y: number }

interface MergedSeg {
  instanceId: string
  colorIndex: number
  x0Ns: number
  /** Visual width; may be rescaled below the true mean to fit the parent. */
  widthNs: number
  /** True per-instance mean (tooltip value), never rescaled. */
  meanNs: number
  spans: SpanNode[]
  level: Level | null
  hasError: boolean
  eventCount: number
}

interface MergedBar {
  node: AggregateNode
  x0Ns: number
  widthNs: number
  depth: number
  segs: MergedSeg[]
}

interface MergedLayout {
  bars: MergedBar[]
  totalNs: number
  maxDepth: number
}

/** A span placed in a lane, with a (possibly focus-rebased) row depth. */
interface LaneSpan {
  span: SpanNode
  depth: number
}

interface Lane {
  inst: Instance
  spans: LaneSpan[]
  startRow: number
  rowCount: number
}

/**
 * Active layout: which spans each visible instance contributes and the time
 * extent to render. Unfocused = every span over the full trace; focused = the
 * double-clicked span's subtree (by name), rebased to depth 0, across all
 * visible instances, bounded to that subtree's time span.
 */
interface ActiveLane {
  inst: Instance
  spans: LaneSpan[]
  maxDepth: number
}
interface Active {
  lo: number
  hi: number
  focused: boolean
  lanes: ActiveLane[]
}

// --------------------------------------------------------- color helpers --

function parseRgb(color: string): [number, number, number] | null {
  if (color.startsWith('#')) {
    const hex = color.slice(1)
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ]
    }
    if (hex.length >= 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ]
    }
    return null
  }
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Mix a color toward white by t (0 = unchanged, 1 = white). */
function lighten(color: string, t: number): string {
  const [r, g, b] = parseRgb(color) ?? [123, 135, 247]
  return `rgb(${Math.round(r + (255 - r) * t)}, ${Math.round(g + (255 - g) * t)}, ${Math.round(b + (255 - b) * t)})`
}

/**
 * Build the per-depth fill ramp for one instance color: the base hue at near-
 * full opacity, nudged slightly more opaque with depth. The border uses a
 * lighter tint of the same hue, so the cell reads like a .btn — solid surface,
 * lighter edge.
 */
function alphaRamp(color: string): string[] {
  const [r, g, b] = parseRgb(color) ?? [123, 135, 247]
  const ramp: string[] = []
  for (let d = 0; d < SHADE_LEVELS; d++) {
    const a = Math.min(FILL_ALPHA_BASE + d * FILL_ALPHA_STEP, FILL_ALPHA_MAX)
    ramp.push(`rgba(${r}, ${g}, ${b}, ${a})`)
  }
  return ramp
}

function resolveTheme(): Theme {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback
  const mono = v('--font-mono', 'monospace')
  const instances: string[] = []
  for (let i = 0; i < INSTANCE_COLOR_COUNT; i++) {
    instances.push(v(`--instance-${i}`, '#7b87f7'))
  }
  const flameBg = v('--flame-bg', '#121217')
  return {
    bg: v('--bg', '#0e0e12'),
    flameBg,
    flameGrid: v('--flame-grid', '#1e1e25'),
    border: v('--border', '#26262e'),
    text: v('--text', '#e7e7ec'),
    textMuted: v('--text-muted', '#9b9ba6'),
    textFaint: v('--text-faint', '#62626d'),
    accent: v('--accent', '#7b87f7'),
    error: v('--error', '#e0635c'),
    levels: {
      trace: v('--level-trace', '#62626d'),
      debug: v('--level-debug', '#6faee8'),
      info: v('--level-info', '#4fb6a2'),
      warn: v('--level-warn', '#e0a458'),
      error: v('--level-error', '#e0635c'),
    },
    instances,
    fills: instances.map((c) => alphaRamp(c)),
    borders: instances.map((c) => lighten(c, 0.4)),
    font: `11px ${mono}`,
    fontSmall: `10px ${mono}`,
    charW: 0,
    charWSmall: 0,
  }
}

// -------------------------------------------------------- canvas helpers --

/** 1-2-5 progression tick step, never below 1ns. */
function niceStep(raw: number): number {
  const safe = Math.max(raw, 1e-9)
  const pow = Math.pow(10, Math.floor(Math.log10(safe)))
  const m = safe / pow
  const f = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10
  return Math.max(f * pow, 1)
}

/** Monospace-exact ellipsis without iterative measureText. */
function ellipsize(text: string, maxPx: number, charW: number): string {
  if (charW <= 0) return text
  const maxChars = Math.floor(maxPx / charW)
  if (text.length <= maxChars) return text
  if (maxChars < 2) return ''
  return text.slice(0, maxChars - 1) + '…'
}

/** Truncate a legend service name past 10 chars (full name stays in title). */
function truncName(name: string): string {
  return name.length > 10 ? `${name.slice(0, 10)}…` : name
}

/**
 * Pack a span tree into rows so time-overlapping spans never share a row,
 * while every child stays strictly below its parent. Greedy: walk preorder
 * (children by start time), placing each span on the lowest row ≥ parent+1
 * whose last span ended before this one starts. Concurrent siblings spread
 * onto adjacent rows; sequential ones reuse a row. Also returns the time
 * extent [lo, hi] of the packed set.
 */
function packRows(roots: SpanNode[]): { spans: LaneSpan[]; maxRow: number; lo: number; hi: number } {
  const spans: LaneSpan[] = []
  const rowEnd: number[] = [] // exclusive end (ns) of the last span on each row
  let maxRow = 0
  let lo = Infinity
  let hi = -Infinity
  const place = (s: SpanNode, minRow: number) => {
    let row = minRow
    while (row < rowEnd.length && rowEnd[row] > s.startNs) row++
    if (row >= rowEnd.length) rowEnd.push(0)
    const end = s.startNs + s.durationNs
    rowEnd[row] = end
    spans.push({ span: s, depth: row })
    if (row > maxRow) maxRow = row
    if (s.startNs < lo) lo = s.startNs
    if (end > hi) hi = end
    for (const c of [...s.children].sort((a, b) => a.startNs - b.startNs)) place(c, row + 1)
  }
  for (const r of [...roots].sort((a, b) => a.startNs - b.startNs)) place(r, 0)
  if (lo === Infinity) {
    lo = 0
    hi = 1
  }
  return { spans, maxRow, lo, hi }
}

type LaneSort = 'order' | 'duration' | 'finish' | 'errors'

/**
 * Reorder lanes by a generic metric (model order by default). `duration` =
 * the lane's active wall-clock extent, `finish` = its latest span end
 * (stragglers first), `errors` = error-span count. All derived from span
 * timing/status, so nothing is tied to a particular workload.
 */
function sortLanes(lanes: ActiveLane[], mode: LaneSort): ActiveLane[] {
  if (mode === 'order') return lanes
  const metric = (l: ActiveLane) => {
    let lo = Infinity
    let hi = -Infinity
    let errs = 0
    for (const { span } of l.spans) {
      if (span.startNs < lo) lo = span.startNs
      const end = span.startNs + span.durationNs
      if (end > hi) hi = end
      if (span.status === 'error' || span.level === 'error') errs++
    }
    return { extent: hi - lo, finish: hi, errs }
  }
  const m = new Map(lanes.map((l) => [l, metric(l)]))
  return [...lanes].sort((a, b) => {
    const ma = m.get(a)!
    const mb = m.get(b)!
    if (mode === 'errors') return mb.errs - ma.errs || mb.extent - ma.extent
    if (mode === 'finish') return mb.finish - ma.finish
    return mb.extent - ma.extent
  })
}

function pathRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

// -------------------------------------------------------------- component --

export default function FlameGraph(props: FlameGraphProps) {
  const {
    model,
    mode,
    selectedSpanId,
    onSelect,
    onSelectEvent,
    hiddenInstances,
    onToggleInstance,
    onToggleAll,
  } = props

  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const minimapRef = useRef<HTMLCanvasElement | null>(null)

  const themeRef = useRef<Theme | null>(null)
  const viewRef = useRef<View | null>(null) // null = fit to full extent
  const geomRef = useRef<Geom | null>(null)
  const hitRef = useRef<Array<HitRect[] | undefined> | null>(null)
  const eventHitRef = useRef<Array<HitRect[] | undefined> | null>(null)
  // Active time extent [lo, hi] (abs ns) the zoom/timeline operate within:
  // the full trace, or the focused subtree. Read by pointer handlers.
  const rangeRef = useRef<{ lo: number; hi: number }>({ lo: 0, hi: 1 })
  const dragRef = useRef<{ moved: boolean } | null>(null)
  const suppressClickRef = useRef(false)

  const [tip, setTip] = useState<Tip | null>(null)
  const tipRef = useRef<Tip | null>(null)
  // State mirror of viewRef so the header timestamps re-render on zoom/pan.
  const [viewWin, setViewWin] = useState<View | null>(null)
  // Event overlay: level-colored diamonds at event times ('instances' mode).
  const [showEvents, setShowEvents] = useState(true)
  // Focused subtree: double-click a span to restrict to spans named this,
  // across all visible instances. null = whole trace.
  const [focusName, setFocusName] = useState<string | null>(null)
  // Highlight: dim spans whose name doesn't contain this (case-insensitive).
  const [highlight, setHighlight] = useState('')
  // Lane ordering in 'instances' mode.
  const [laneSort, setLaneSort] = useState<LaneSort>('order')
  // Self-time heat: color bars by exclusive (self) duration instead of instance.
  const [selfTime, setSelfTime] = useState(false)
  // Wait-gaps: shade the parts of a parent span not covered by its children.
  const [gaps, setGaps] = useState(false)

  const hideTip = useCallback(() => {
    if (tipRef.current !== null) {
      tipRef.current = null
      setTip(null)
    }
  }, [])

  const showTip = useCallback((t: Tip) => {
    tipRef.current = t
    setTip(t)
  }, [])

  // ------------------------------------------------------ derived layout --

  const instMap = useMemo(() => {
    const m = new Map<string, Instance>()
    for (const inst of model.instances) m.set(inst.id, inst)
    return m
  }, [model])

  // Exclusive (self) time per span = duration minus the sum of child durations
  // (clamped ≥ 0; concurrent children can exceed the parent). Generic — no
  // dependence on span names. `max` normalizes the heat coloring.
  const selfTimes = useMemo(() => {
    const map = new Map<string, number>()
    let max = 1
    for (const s of model.spans.values()) {
      let childSum = 0
      for (const c of s.children) childSum += c.durationNs
      const self = Math.max(0, s.durationNs - childSum)
      map.set(s.spanId, self)
      if (self > max) max = self
    }
    return { map, max }
  }, [model])

  /** Aggregate tree laid out in "mean-ns" space (zoom-independent). */
  const mergedLayout = useMemo<MergedLayout | null>(() => {
    if (mode !== 'merged') return null
    const root = buildAggregateTree(model, hiddenInstances)
    const bars: MergedBar[] = []
    let maxDepth = 0
    const layout = (node: AggregateNode, x0: number): number => {
      let widthNs = 0
      if (node.depth >= 0) {
        const segs: MergedSeg[] = []
        let off = x0
        for (const inst of model.instances) {
          if (hiddenInstances.has(inst.id)) continue
          const spans = node.spans.get(inst.id)
          if (!spans || spans.length === 0) continue
          let total = 0
          let hasError = false
          let eventCount = 0
          let level: Level | null = null
          for (const s of spans) {
            total += s.durationNs
            if (s.status === 'error' || s.level === 'error') hasError = true
            eventCount += s.events.length
            if (level === null && s.level !== null) level = s.level
          }
          const meanNs = total / spans.length
          segs.push({
            instanceId: inst.id,
            colorIndex: inst.colorIndex,
            x0Ns: off,
            widthNs: meanNs,
            meanNs,
            spans,
            level,
            hasError,
            eventCount,
          })
          off += meanNs
          widthNs += meanNs
        }
        bars.push({ node, x0Ns: x0, widthNs, depth: node.depth, segs })
        if (node.depth > maxDepth) maxDepth = node.depth
      }
      const firstChildBar = bars.length
      let cx = x0
      for (const child of node.children) cx += layout(child, cx)
      // Children can sum wider than their parent (concurrent children within
      // an instance, or a child present in only some parent occurrences whose
      // mean is averaged over fewer spans). Rescale the whole child pass into
      // the parent extent so containment holds and nothing lands past the
      // zoom domain.
      if (node.depth >= 0 && cx - x0 > widthNs) {
        const scale = widthNs / (cx - x0)
        for (let i = firstChildBar; i < bars.length; i++) {
          const b = bars[i]
          b.x0Ns = x0 + (b.x0Ns - x0) * scale
          b.widthNs *= scale
          for (const seg of b.segs) {
            seg.x0Ns = x0 + (seg.x0Ns - x0) * scale
            seg.widthNs *= scale
          }
        }
      }
      if (node.depth < 0) widthNs = cx - x0
      return widthNs
    }
    const totalNs = layout(root, 0)
    return { bars, totalNs, maxDepth }
  }, [mode, model, hiddenInstances])

  const domain = Math.max(
    1,
    mode === 'merged' ? (mergedLayout ? mergedLayout.totalNs : 1) : model.durationNs,
  )

  /**
   * Resolve the visible instances + their spans for 'instances' mode, honoring
   * the focus. When focused, each instance contributes the subtree(s) rooted at
   * the top-most spans named `focusName`, rebased to depth 0, and [lo, hi] is
   * tightened to that subtree's extent. If the name is absent from every
   * visible instance, focus silently falls back to the full view.
   */
  const active = useMemo<Active>(() => {
    const fullHi = Math.max(1, model.durationNs)
    const buildFull = (): Active => ({
      lo: 0,
      hi: fullHi,
      focused: false,
      lanes: sortLanes(
        model.instances
          .filter((i) => !hiddenInstances.has(i.id))
          .map((inst) => {
            const packed = packRows(inst.rootSpans)
            return { inst, spans: packed.spans, maxDepth: packed.maxRow }
          }),
        laneSort,
      ),
    })
    if (focusName === null) return buildFull()

    let lo = Infinity
    let hi = -Infinity
    const lanes: ActiveLane[] = []
    for (const inst of model.instances) {
      if (hiddenInstances.has(inst.id)) continue
      // Top-most spans named focusName (don't descend past a match).
      const roots: SpanNode[] = []
      const find: SpanNode[] = [...inst.rootSpans]
      while (find.length > 0) {
        const s = find.pop()!
        if (s.name === focusName) roots.push(s)
        else for (let i = s.children.length - 1; i >= 0; i--) find.push(s.children[i])
      }
      if (roots.length === 0) continue
      const packed = packRows(roots)
      lanes.push({ inst, spans: packed.spans, maxDepth: packed.maxRow })
      if (packed.lo < lo) lo = packed.lo
      if (packed.hi > hi) hi = packed.hi
    }
    if (lanes.length === 0 || lo === Infinity) return buildFull()
    return { lo, hi: Math.max(hi, lo + 1), focused: true, lanes: sortLanes(lanes, laneSort) }
  }, [model, focusName, hiddenInstances, laneSort])

  // Zoom/timeline extent: focus subtree in 'instances' mode, else full domain.
  const rangeLo = mode === 'instances' ? active.lo : 0
  const rangeHi = mode === 'instances' ? active.hi : domain
  rangeRef.current = { lo: rangeLo, hi: rangeHi }

  // ------------------------------------------------------------ rendering --

  const draw = () => {
    const canvas = canvasRef.current
    const scroll = scrollRef.current
    if (!canvas || !scroll) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let theme = themeRef.current
    if (!theme) {
      theme = resolveTheme()
      themeRef.current = theme
    }

    const hl = highlight.trim().toLowerCase()
    const accRgb = parseRgb(theme.accent) ?? [123, 135, 247]
    const selfOverlay = `rgba(${accRgb[0]}, ${accRgb[1]}, ${accRgb[2]}, 0.6)`
    const bgRgb = parseRgb(theme.flameBg) ?? [18, 18, 23]
    // Scrim used to fade child-covered (non-self) regions toward the canvas.
    const coverScrim = `rgba(${bgRgb[0]}, ${bgRgb[1]}, ${bgRgb[2]}, 0.6)`

    // Row layout.
    const lanes: Lane[] = []
    let totalRows = 0
    if (mode === 'instances') {
      for (const al of active.lanes) {
        const rowCount = al.maxDepth + 1
        lanes.push({ inst: al.inst, spans: al.spans, startRow: totalRows, rowCount })
        totalRows += rowCount + LANE_GAP_ROWS
      }
    } else if (mergedLayout && mergedLayout.bars.length > 0) {
      totalRows = mergedLayout.maxDepth + 1
    }

    // Backing-store size (devicePixelRatio-aware).
    const cssW = Math.max(80, scroll.clientWidth)
    const cssH = Math.max(140, RULER_H + totalRows * ROW_H + 10)
    const dpr = window.devicePixelRatio || 1
    const pw = Math.round(cssW * dpr)
    const ph = Math.round(cssH * dpr)
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw
      canvas.height = ph
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    if (theme.charW === 0) {
      ctx.font = theme.font
      theme.charW = ctx.measureText('0').width || 7
      ctx.font = theme.fontSmall
      theme.charWSmall = ctx.measureText('0').width || 6
    }

    // Resolve the zoom window (clamped to the active extent [rangeLo, rangeHi];
    // when focused this is the subtree, so you can't zoom out past it).
    const rangeSpan = Math.max(1, rangeHi - rangeLo)
    const minWin = Math.min(MIN_WINDOW_NS, rangeSpan)
    const v = viewRef.current
    const win = v ? clamp(v.t1 - v.t0, minWin, rangeSpan) : rangeSpan
    const t0 = v ? clamp(v.t0, rangeLo, rangeHi - win) : rangeLo
    const t1 = t0 + win
    const plotX0 = mode === 'instances' ? GUTTER : 0
    const plotW = Math.max(1, cssW - plotX0)
    const pxPerNs = plotW / win
    const toX = (t: number) => plotX0 + (t - t0) * pxPerNs
    geomRef.current = { plotX0, plotW, cssW, cssH }

    // Background.
    ctx.fillStyle = theme.flameBg
    ctx.fillRect(0, 0, cssW, cssH)
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.lineWidth = 1

    // Time ruler + vertical grid: adaptive 1-2-5 tick steps, formatNs labels.
    const step = niceStep((win * 90) / plotW)
    ctx.font = theme.fontSmall
    for (let t = Math.ceil(t0 / step) * step; t <= t1 + step * 1e-6; t += step) {
      const x = Math.round(toX(t)) + 0.5
      ctx.strokeStyle = theme.flameGrid
      ctx.beginPath()
      ctx.moveTo(x, RULER_H)
      ctx.lineTo(x, cssH)
      ctx.stroke()
      const label = formatNs(t)
      if (x + 4 + label.length * theme.charWSmall < cssW - 2) {
        ctx.fillStyle = theme.textFaint
        ctx.fillText(label, x + 4, RULER_H / 2 + 1)
      }
    }
    ctx.strokeStyle = theme.border
    ctx.beginPath()
    ctx.moveTo(0, RULER_H - 0.5)
    ctx.lineTo(cssW, RULER_H - 0.5)
    ctx.stroke()

    // Hit buckets, one array per 18px row. Event markers get their own
    // buckets so they win hover/click over the bars they sit on.
    const buckets: Array<HitRect[] | undefined> = new Array(totalRows)
    const evBuckets: Array<HitRect[] | undefined> = new Array(totalRows)

    if (mode === 'instances') {
      // Gutter separator.
      ctx.strokeStyle = theme.border
      ctx.beginPath()
      ctx.moveTo(GUTTER - 0.5, RULER_H)
      ctx.lineTo(GUTTER - 0.5, cssH)
      ctx.stroke()

      for (const lane of lanes) {
        const { inst } = lane
        const laneTop = RULER_H + lane.startRow * ROW_H
        const laneH = lane.rowCount * ROW_H
        const ci = inst.colorIndex % INSTANCE_COLOR_COUNT

        // Gutter: color stripe + instance name (+ span count).
        ctx.fillStyle = theme.instances[ci]
        ctx.fillRect(0, laneTop + 2, 3, laneH - 4)
        ctx.font = theme.font
        ctx.fillStyle = theme.textMuted
        ctx.fillText(
          ellipsize(inst.serviceName, GUTTER - 18, theme.charW),
          10,
          laneTop + ROW_H / 2,
        )
        if (lane.rowCount > 1) {
          ctx.font = theme.fontSmall
          ctx.fillStyle = theme.textFaint
          ctx.fillText(
            ellipsize(`${inst.spanCount} spans`, GUTTER - 18, theme.charWSmall),
            10,
            laneTop + ROW_H + ROW_H / 2,
          )
        }

        // Lane separator (mid-gap).
        ctx.strokeStyle = theme.flameGrid
        ctx.beginPath()
        ctx.moveTo(0, laneTop + laneH + ROW_H / 2 + 0.5)
        ctx.lineTo(cssW, laneTop + laneH + ROW_H / 2 + 0.5)
        ctx.stroke()

        const ramp = theme.fills[ci]
        const borderC = theme.borders[ci]
        ctx.font = theme.font
        for (const { span, depth } of lane.spans) {
          const sx0 = toX(span.startNs)
          const sx1 = toX(span.startNs + span.durationNs)
          if (sx1 < plotX0 || sx0 > cssW) continue
          const x0 = Math.max(sx0, plotX0)
          const x1 = Math.min(sx1, cssW)
          const w = Math.max(x1 - x0 - CELL_GAP, 1)
          const y = laneTop + depth * ROW_H + BAR_PAD_Y
          const isError = span.status === 'error' || span.level === 'error'
          // Highlight: fade spans whose name doesn't match the query.
          ctx.globalAlpha = hl !== '' && !span.name.toLowerCase().includes(hl) ? 0.16 : 1
          const selfNs = selfTimes.map.get(span.spanId) ?? 0

          pathRoundRect(ctx, x0, y, w, BAR_H, CELL_RADIUS)
          ctx.fillStyle = ramp[Math.min(depth, SHADE_LEVELS - 1)]
          ctx.fill()
          if (w >= 3) {
            ctx.strokeStyle = borderC
            ctx.stroke()
          }
          // Self-time: accent the segments not covered by any child (the
          // span's own work/wait) and fade the child-covered segments so self
          // stands out. Leaves are all self. Accent reads over any hue.
          if (selfTime) {
            const end = span.startNs + span.durationNs
            const seg = (g0: number, g1: number, style: string) => {
              const gx0 = Math.max(toX(g0), x0)
              const gx1 = Math.min(toX(g1), x0 + w)
              if (gx1 - gx0 > 0.5) {
                ctx.fillStyle = style
                ctx.fillRect(gx0, y, gx1 - gx0, BAR_H)
              }
            }
            if (span.children.length === 0) {
              seg(span.startNs, end, selfOverlay)
            } else {
              // Merge child intervals → covered; the complement is self.
              const ivs = span.children
                .map((c) => [c.startNs, c.startNs + c.durationNs] as [number, number])
                .sort((a, b) => a[0] - b[0])
              const covered: [number, number][] = []
              for (const iv of ivs) {
                const last = covered[covered.length - 1]
                if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
                else covered.push([...iv])
              }
              let cursor = span.startNs
              for (const [s, e] of covered) {
                if (s > cursor) seg(cursor, s, selfOverlay)
                seg(Math.max(s, span.startNs), e, coverScrim)
                cursor = Math.max(cursor, e)
              }
              if (cursor < end) seg(cursor, end, selfOverlay)
            }
          }
          // Wait-gaps: darken the parent's extent not covered by any child —
          // where it's doing its own work or blocked waiting.
          if (gaps && span.children.length > 0) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.34)'
            const end = span.startNs + span.durationNs
            const ivs = span.children
              .map((c) => [c.startNs, c.startNs + c.durationNs] as [number, number])
              .sort((a, b) => a[0] - b[0])
            let cursor = span.startNs
            const shade = (g0: number, g1: number) => {
              const gx0 = Math.max(toX(g0), x0)
              const gx1 = Math.min(toX(g1), x0 + w)
              if (gx1 - gx0 > 0.5) ctx.fillRect(gx0, y, gx1 - gx0, BAR_H)
            }
            for (const [s, e] of ivs) {
              if (s > cursor) shade(cursor, s)
              if (e > cursor) cursor = e
            }
            if (cursor < end) shade(cursor, end)
          }
          if (isError) {
            ctx.fillStyle = theme.error
            ctx.fillRect(x0 + CELL_RADIUS, y + BAR_H - 2, Math.max(w - 2 * CELL_RADIUS, 1), 2)
          }
          if (span.spanId === selectedSpanId) {
            pathRoundRect(ctx, x0 + 1, y + 1, w - 2, BAR_H - 2, CELL_RADIUS - 1)
            ctx.strokeStyle = theme.accent
            ctx.lineWidth = 2
            ctx.stroke()
            ctx.lineWidth = 1
          }
          if (w > LABEL_MIN_W) {
            ctx.fillStyle = theme.bg
            ctx.fillText(
              ellipsize(span.name, w - 2 * CELL_PAD_X, theme.charW),
              x0 + CELL_PAD_X,
              y + BAR_H / 2 + 0.5,
            )
          }

          const row = lane.startRow + depth
          ;(buckets[row] ??= []).push({
            kind: 'span',
            x0,
            x1,
            name: span.name,
            instanceId: inst.id,
            durNs: span.durationNs,
            selfNs,
            startNs: span.startNs,
            count: 1,
            level: span.level,
            error: isError,
            eventCount: span.events.length,
            selectId: span.spanId,
          })
        }
        ctx.globalAlpha = 1

        // Event overlay: one diamond per event at its timestamp, on the
        // owning span's row, colored by level. Drawn after every bar in the
        // lane so markers are never overpainted by sibling bars.
        if (showEvents) {
          for (const { span, depth } of lane.spans) {
            if (span.events.length === 0) continue
            const row = lane.startRow + depth
            const cy = laneTop + depth * ROW_H + BAR_PAD_Y + BAR_H / 2
            for (const ev of span.events) {
              const ex = toX(ev.timeNs)
              if (ex < plotX0 || ex > cssW) continue
              ctx.beginPath()
              ctx.moveTo(ex, cy - 4.5)
              ctx.lineTo(ex + 4.5, cy)
              ctx.lineTo(ex, cy + 4.5)
              ctx.lineTo(ex - 4.5, cy)
              ctx.closePath()
              ctx.fillStyle = theme.levels[ev.level ?? 'trace']
              ctx.fill()
              ctx.strokeStyle = theme.bg
              ctx.stroke()
              ;(evBuckets[row] ??= []).push({
                kind: 'event',
                x0: ex - 5,
                x1: ex + 5,
                name: ev.name,
                instanceId: inst.id,
                durNs: -1,
                selfNs: -1,
                startNs: ev.timeNs,
                count: 1,
                level: ev.level,
                error: ev.level === 'error',
                eventCount: 1,
                selectId: span.spanId,
                spanName: span.name,
                event: ev,
              })
            }
          }
        }
      }

      if (lanes.length === 0) {
        ctx.font = theme.font
        ctx.fillStyle = theme.textFaint
        ctx.textAlign = 'center'
        ctx.fillText('all instances hidden', cssW / 2, (RULER_H + cssH) / 2)
        ctx.textAlign = 'left'
      }
    } else if (mergedLayout) {
      for (const bar of mergedLayout.bars) {
        const bx0 = toX(bar.x0Ns)
        const bx1 = toX(bar.x0Ns + bar.widthNs)
        if (bx1 < plotX0 || bx0 > cssW) continue
        const y = RULER_H + bar.depth * ROW_H + BAR_PAD_Y
        const shade = Math.min(bar.depth, SHADE_LEVELS - 1)

        for (const seg of bar.segs) {
          const sx0 = toX(seg.x0Ns)
          const sx1 = toX(seg.x0Ns + seg.widthNs)
          if (sx1 < plotX0 || sx0 > cssW) continue
          const x0 = Math.max(sx0, plotX0)
          const x1 = Math.min(sx1, cssW)
          const w = Math.max(x1 - x0 - CELL_GAP, 1)
          const ci = seg.colorIndex % INSTANCE_COLOR_COUNT

          pathRoundRect(ctx, x0, y, w, BAR_H, CELL_RADIUS)
          ctx.fillStyle = theme.fills[ci][shade]
          ctx.fill()
          if (w >= 3) {
            ctx.strokeStyle = theme.borders[ci]
            ctx.stroke()
          }
          if (seg.hasError) {
            ctx.fillStyle = theme.error
            ctx.fillRect(x0 + CELL_RADIUS, y + BAR_H - 2, Math.max(w - 2 * CELL_RADIUS, 1), 2)
          }
          if (
            selectedSpanId !== null &&
            seg.spans.some((s) => s.spanId === selectedSpanId)
          ) {
            pathRoundRect(ctx, x0 + 1, y + 1, w - 2, BAR_H - 2, CELL_RADIUS - 1)
            ctx.strokeStyle = theme.accent
            ctx.lineWidth = 2
            ctx.stroke()
            ctx.lineWidth = 1
          }

          ;(buckets[bar.depth] ??= []).push({
            kind: 'span',
            x0,
            x1,
            name: bar.node.name,
            instanceId: seg.instanceId,
            durNs: seg.meanNs,
            selfNs: -1,
            startNs: -1,
            count: seg.spans.length,
            level: seg.level,
            error: seg.hasError,
            eventCount: seg.eventCount,
            selectId: seg.spans[0].spanId,
          })
        }

        // Node label across the whole row: name + mean duration.
        const lx0 = Math.max(bx0, plotX0)
        const lw = Math.min(bx1, cssW) - lx0
        if (lw > LABEL_MIN_W) {
          ctx.font = theme.font
          ctx.fillStyle = theme.bg
          ctx.fillText(
            ellipsize(
              `${bar.node.name} ${formatNs(bar.node.meanNs)}`,
              lw - 2 * CELL_PAD_X,
              theme.charW,
            ),
            lx0 + CELL_PAD_X,
            y + BAR_H / 2 + 0.5,
          )
        }
      }

      if (mergedLayout.bars.length === 0) {
        ctx.font = theme.font
        ctx.fillStyle = theme.textFaint
        ctx.textAlign = 'center'
        ctx.fillText('all instances hidden', cssW / 2, (RULER_H + cssH) / 2)
        ctx.textAlign = 'left'
      }
    }

    hitRef.current = buckets
    eventHitRef.current = evBuckets
  }

  // Activity overview inside the timeline track: one thick, full-opacity band
  // per instance marking where its spans are active across the active extent
  // (full trace, or — when focused — the subtree, so the minimap auto-zooms to
  // it). The window brush over it shows the current view.
  const drawMinimap = () => {
    const canvas = minimapRef.current
    const track = timelineRef.current
    if (!canvas || !track) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const theme = themeRef.current ?? (themeRef.current = resolveTheme())
    const cssW = Math.max(1, track.clientWidth)
    const cssH = Math.max(1, track.clientHeight)
    const dpr = window.devicePixelRatio || 1
    const pw = Math.round(cssW * dpr)
    const ph = Math.round(cssH * dpr)
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw
      canvas.height = ph
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const lo = active.lo
    const span = Math.max(1, active.hi - lo)
    const lanes = active.lanes
    const laneH = cssH / (lanes.length || 1)
    const gap = lanes.length > 1 ? 2 : 0
    lanes.forEach((al, li) => {
      const ci = al.inst.colorIndex % INSTANCE_COLOR_COUNT
      const laneTop = li * laneH
      const h = Math.max(laneH - gap, 2)
      ctx.fillStyle = theme.instances[ci]
      for (const { span: s } of al.spans) {
        const x = ((s.startNs - lo) / span) * cssW
        const w = Math.max((s.durationNs / span) * cssW, 1)
        ctx.fillRect(x, laneTop + gap / 2, w, h)
      }
    })
  }

  const drawRef = useRef<() => void>(() => {})
  drawRef.current = draw
  const drawMinimapRef = useRef<() => void>(() => {})
  drawMinimapRef.current = drawMinimap

  /** Single rAF scheduler — coalesces invalidations, idle when idle. */
  const rafRef = useRef(0)
  const schedule = useCallback(() => {
    if (rafRef.current !== 0) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      drawRef.current()
      drawMinimapRef.current()
    })
  }, [])

  useEffect(
    () => () => {
      if (rafRef.current !== 0) {
        cancelAnimationFrame(rafRef.current)
        // Reset so a later schedule() (e.g. StrictMode remount) isn't wedged
        // by the stale, already-cancelled frame id.
        rafRef.current = 0
      }
    },
    [],
  )

  /** Commit a zoom window (clamped to the active extent) and repaint. */
  const applyView = useCallback(
    (t0: number, t1: number) => {
      const { lo, hi } = rangeRef.current
      const span = Math.max(1, hi - lo)
      const minWin = Math.min(MIN_WINDOW_NS, span)
      const win = clamp(t1 - t0, minWin, span)
      const a = clamp(t0, lo, hi - win)
      viewRef.current = { t0: a, t1: a + win }
      setViewWin(viewRef.current)
      hideTip()
      schedule()
    },
    [hideTip, schedule],
  )

  /** Reset to the full extent (fit). */
  const resetView = useCallback(() => {
    viewRef.current = null
    setViewWin(null)
    hideTip()
    schedule()
  }, [hideTip, schedule])

  // Reset zoom (fit) when the trace, mode, or focus changes.
  useLayoutEffect(() => {
    viewRef.current = null
    setViewWin(null)
    hideTip()
  }, [model, mode, focusName, hideTip])

  // Clear focus when the trace or mode changes (a stale name won't match).
  useLayoutEffect(() => {
    setFocusName(null)
  }, [model, mode])

  // Repaint on any canvas-relevant input change.
  useLayoutEffect(() => {
    schedule()
  }, [schedule, model, mode, selectedSpanId, hiddenInstances, showEvents, focusName, highlight, active, selfTime, gaps])

  // Invalidate cached colors when the theme attribute flips.
  useEffect(() => {
    const mo = new MutationObserver(() => {
      themeRef.current = null
      schedule()
    })
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => mo.disconnect()
  }, [schedule])

  // Repaint on container resize.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => schedule())
    ro.observe(el)
    return () => ro.disconnect()
  }, [schedule])

  // Repaint when devicePixelRatio changes (window dragged across monitors).
  // The dppx value is baked into the media query, so re-register per value.
  useEffect(() => {
    let mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onChange = () => {
      schedule()
      mq.removeEventListener('change', onChange)
      mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      mq.addEventListener('change', onChange)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [schedule])

  // Wheel: horizontal intent (deltaX, or Shift+wheel) zooms around the cursor;
  // vertical wheel is left to scroll the lane list natively. Non-passive only
  // when we actually zoom, so vertical scrolling isn't blocked.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      // Treat Shift+wheel as horizontal (browsers may report it on either
      // axis), otherwise require the horizontal axis to dominate.
      const amt =
        e.shiftKey && e.deltaX === 0 ? e.deltaY : Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : 0
      if (amt === 0) return // vertical scroll: let the container handle it
      e.preventDefault()
      const g = geomRef.current
      if (!g) return
      const { lo, hi } = rangeRef.current
      const span = Math.max(1, hi - lo)
      const minWin = Math.min(MIN_WINDOW_NS, span)
      const v = viewRef.current
      const win0 = v ? clamp(v.t1 - v.t0, minWin, span) : span
      const vt0 = v ? clamp(v.t0, lo, hi - win0) : lo
      const rect = canvas.getBoundingClientRect()
      const frac = clamp((e.clientX - rect.left - g.plotX0) / g.plotW, 0, 1)
      const delta = e.deltaMode === 1 ? amt * 24 : amt
      const nwin = clamp(win0 * Math.exp(delta * 0.0022), minWin, span)
      const cursorT = vt0 + frac * win0
      const nt0 = clamp(cursorT - frac * nwin, lo, hi - nwin)
      viewRef.current = { t0: nt0, t1: nt0 + nwin }
      setViewWin(viewRef.current)
      hideTip()
      schedule()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [schedule, hideTip])

  // ---------------------------------------------------------- interaction --

  /** Row-bucketed hit test — O(bars in one row), never O(all spans). */
  const hitTest = useCallback((px: number, py: number): HitRect | null => {
    if (py < RULER_H) return null
    const row = Math.floor((py - RULER_H) / ROW_H)
    if (row < 0) return null

    // Event markers first: they sit on top of bars and are small targets,
    // so the nearest marker within range wins over the bar underneath.
    const evBucket = eventHitRef.current?.[row]
    if (evBucket) {
      let best: HitRect | null = null
      let bestDist = Infinity
      for (const r of evBucket) {
        if (px < r.x0 || px > r.x1) continue
        const dist = Math.abs(px - (r.x0 + r.x1) / 2)
        if (dist < bestDist) {
          best = r
          bestDist = dist
        }
      }
      if (best) return best
    }

    const buckets = hitRef.current
    if (!buckets || row >= buckets.length) return null
    const bucket = buckets[row]
    if (!bucket) return null
    for (let i = bucket.length - 1; i >= 0; i--) {
      const r = bucket[i]
      if (px >= r.x0 && px <= r.x1) return r
    }
    return null
  }, [])

  const handleMouseDown = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    rootRef.current?.focus()
    suppressClickRef.current = false
    const canvas = e.currentTarget
    const g = geomRef.current
    if (!g) return
    const { lo, hi } = rangeRef.current
    const rangeSpan = Math.max(1, hi - lo)
    const minWin = Math.min(MIN_WINDOW_NS, rangeSpan)
    const v = viewRef.current
    const win = v ? clamp(v.t1 - v.t0, minWin, rangeSpan) : rangeSpan
    const startT0 = v ? clamp(v.t0, lo, hi - win) : lo
    const startX = e.clientX
    const drag = { moved: false }
    dragRef.current = drag
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      if (!drag.moved && Math.abs(dx) < 3) return
      drag.moved = true
      canvas.style.cursor = 'grabbing'
      const nt0 = clamp(startT0 - (dx / g.plotW) * win, lo, hi - win)
      viewRef.current = { t0: nt0, t1: nt0 + win }
      setViewWin(viewRef.current)
      hideTip()
      schedule()
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (drag.moved) suppressClickRef.current = true
      dragRef.current = null
      canvas.style.cursor = 'default'
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleMouseMove = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current) return // panning is handled by window listeners
    const canvas = e.currentTarget
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const hit = hitTest(px, py)
    canvas.style.cursor = hit ? 'pointer' : 'default'
    if (hit) showTip({ ...hit, x: px, y: py })
    else hideTip()
  }

  const handleMouseLeave = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    e.currentTarget.style.cursor = 'default'
    hideTip()
  }

  const handleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top)
    if (hit?.kind === 'event' && hit.event !== undefined) {
      onSelectEvent(hit.event)
    } else {
      onSelect(hit ? hit.selectId : null)
    }
  }

  // Double-click a span to focus its subtree (by name) across all visible
  // instances; double-click empty space resets the zoom to fit.
  const handleDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (mode !== 'instances') {
      resetView()
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top)
    if (hit && hit.kind === 'span') setFocusName(hit.name)
    else resetView()
  }

  // Overview timeline: drag the window body to pan, an edge handle to zoom,
  // or empty track to rubber-band a new range. Shares viewRef with the
  // canvas, so wheel-zoom and timeline drags stay in lockstep.
  const onTimelinePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const track = timelineRef.current
    if (!track) return
    e.preventDefault()
    rootRef.current?.focus()
    const rect = track.getBoundingClientRect()
    const { lo, hi } = rangeRef.current
    const rangeSpan = Math.max(1, hi - lo)
    const tAt = (clientX: number) =>
      lo + clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1) * rangeSpan

    const ds = (e.target as HTMLElement).dataset
    const mode: 'left' | 'right' | 'pan' | 'select' =
      ds.tlHandle === 'left'
        ? 'left'
        : ds.tlHandle === 'right'
          ? 'right'
          : ds.tlWindow === 'true'
            ? 'pan'
            : 'select'

    const v = viewRef.current
    const win0 = v ? clamp(v.t1 - v.t0, 0, rangeSpan) : rangeSpan
    const a0 = v ? clamp(v.t0, lo, hi - win0) : lo
    const anchorT = tAt(e.clientX)
    const downX = e.clientX
    let moved = false

    const onMove = (ev: PointerEvent) => {
      if (!moved && mode === 'select' && Math.abs(ev.clientX - downX) < 3) return
      moved = true
      const cur = tAt(ev.clientX)
      if (mode === 'pan') {
        const shift = cur - anchorT
        applyView(a0 + shift, a0 + shift + win0)
      } else if (mode === 'left') {
        applyView(Math.min(cur, a0 + win0), a0 + win0)
      } else if (mode === 'right') {
        applyView(a0, Math.max(cur, a0))
      } else {
        applyView(Math.min(anchorT, cur), Math.max(anchorT, cur))
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') onSelect(null)
  }

  // ----------------------------------------------------------------- view --

  const tipInst = tip ? instMap.get(tip.instanceId) : undefined
  let tipLeft = 0
  let tipTop = 0
  if (tip) {
    const g = geomRef.current
    const w = g ? g.cssW : 600
    const h = g ? g.cssH : 400
    tipLeft = Math.max(4, Math.min(tip.x + 14, w - 270))
    tipTop = tip.y + 16
    if (tipTop > h - 140) tipTop = Math.max(4, tip.y - 140)
  }

  // Overview-timeline window, as a percentage of the active extent.
  const tlSpan = Math.max(1, rangeHi - rangeLo)
  const winT0 = viewWin ? clamp(viewWin.t0, rangeLo, rangeHi) : rangeLo
  const winT1 = viewWin ? clamp(viewWin.t1, rangeLo, rangeHi) : rangeHi
  const tlLeft = ((winT0 - rangeLo) / tlSpan) * 100
  const tlWidth = Math.max(((winT1 - winT0) / tlSpan) * 100, 0.6)
  const zoomed = viewWin !== null && winT1 - winT0 < tlSpan - 0.5

  // The span we're viewing: the focused subtree's name, or the trace's root
  // span name (the one shared by every visible instance's top-level span).
  const rootName =
    active.focused && focusName !== null
      ? focusName
      : (() => {
          const names = new Set<string>()
          for (const lane of active.lanes)
            for (const ls of lane.spans) if (ls.depth === 0) names.add(ls.span.name)
          return names.size === 1 ? [...names][0] : names.size === 0 ? 'trace' : 'multiple roots'
        })()

  // Span/instance counts for the header: the focused subtree across visible
  // instances when focused, else every visible instance's spans.
  const shownSpans = active.lanes.reduce((n, lane) => n + lane.spans.length, 0)
  const shownInstances = active.lanes.length

  return (
    <div className="fg" ref={rootRef} tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="fg-header">
        <span className="fg-header-title" title={rootName}>
          {rootName}
        </span>
        <span className="fg-header-meta mono-num">
          {formatClock(model.startUnixMs + winT0 / 1e6)}
          {' → '}
          {formatClock(model.startUnixMs + winT1 / 1e6)}
          <span className="fg-header-dot">·</span>
          {formatNs(winT1 - winT0)}
          <span className="fg-header-dot">·</span>
          {shownSpans} spans
          <span className="fg-header-dot">·</span>
          {shownInstances} {shownInstances === 1 ? 'instance' : 'instances'}
        </span>
      </div>
      <div className="fg-legend">
        {active.focused && focusName !== null && (
          <button
            type="button"
            className="chip fg-chip fg-focus-chip active"
            title="focused on a sub-tree — click to view the whole trace"
            onClick={() => setFocusName(null)}
          >
            <span className="fg-focus-label">focus</span>
            <span className="fg-focus-name">{focusName}</span>
            <span className="chip-x">×</span>
          </button>
        )}
        {model.instances.length > 1 &&
          (() => {
            const anyHidden = model.instances.some((i) => hiddenInstances.has(i.id))
            return (
              <button
                type="button"
                className="chip fg-chip fg-toggle-all"
                title={anyHidden ? 'show all services' : 'hide all services'}
                onClick={onToggleAll}
              >
                {anyHidden ? 'select all' : 'deselect all'}
              </button>
            )
          })()}
        {model.instances.map((inst) => {
          const hidden = hiddenInstances.has(inst.id)
          return (
            <button
              key={inst.id}
              type="button"
              className={`chip fg-chip${hidden ? ' fg-chip-hidden' : ''}`}
              aria-pressed={!hidden}
              title={`${inst.id} · ${inst.spanCount} spans · click to ${hidden ? 'show' : 'hide'}`}
              onClick={() => onToggleInstance(inst.id)}
            >
              <span
                className="swatch"
                style={{ background: instanceColorVar(inst.colorIndex) }}
              />
              <span className="fg-chip-name" title={inst.serviceName}>
                {truncName(inst.serviceName)}
              </span>
              <span className="faint mono-num">{inst.spanCount}</span>
            </button>
          )
        })}
        {mode === 'instances' && model.events.length > 0 && (
          <button
            type="button"
            className={`chip fg-chip${showEvents ? ' active' : ''}`}
            aria-pressed={showEvents}
            title="overlay event markers at their timestamps, colored by level"
            onClick={() => setShowEvents((v) => !v)}
          >
            ◆ events
            <span className="faint mono-num">{model.events.length}</span>
          </button>
        )}
      </div>

      {mode === 'instances' && (
        <div className="fg-controls">
          <Select
            className="fg-sort"
            label="sort lanes"
            value={laneSort}
            options={[
              { value: 'order', label: 'sort: default' },
              { value: 'duration', label: 'sort: duration' },
              { value: 'finish', label: 'sort: finish' },
              { value: 'errors', label: 'sort: errors' },
            ]}
            onChange={(v) => setLaneSort(v)}
          />
          <input
            className="input fg-find"
            type="search"
            placeholder="search spans"
            value={highlight}
            spellCheck={false}
            onChange={(e) => setHighlight(e.target.value)}
          />
          <button
            type="button"
            className={`chip fg-chip${selfTime ? ' active' : ''}`}
            aria-pressed={selfTime}
            title="highlight the self-time segments of each span (not covered by children)"
            onClick={() => setSelfTime((v) => !v)}
          >
            self-time
          </button>
          <button
            type="button"
            className={`chip fg-chip${gaps ? ' active' : ''}`}
            aria-pressed={gaps}
            title="shade the parts of a span not covered by its children (self/wait)"
            onClick={() => setGaps((v) => !v)}
          >
            gaps
          </button>
        </div>
      )}

      <div className="fg-timeline">
        {mode === 'instances' && (
          <span className="fg-timeline-label" style={{ width: GUTTER }}>
            timeline
          </span>
        )}
        <div
          ref={timelineRef}
          className="fg-timeline-track"
          onPointerDown={onTimelinePointerDown}
          onDoubleClick={resetView}
          title="drag to scrub · drag an edge to zoom · drag empty track to select a range · double-click to reset"
        >
          <canvas ref={minimapRef} className="fg-timeline-minimap" />
          <div
            className={`fg-timeline-window${zoomed ? ' zoomed' : ''}`}
            data-tl-window="true"
            style={{ left: `${tlLeft}%`, width: `${tlWidth}%` }}
          >
            <span className="fg-timeline-handle left" data-tl-handle="left" />
            <span className="fg-timeline-handle right" data-tl-handle="right" />
          </div>
        </div>
      </div>

      <div className="fg-scroll" ref={scrollRef}>
        <div className="fg-canvas-wrap">
          <canvas
            ref={canvasRef}
            className="fg-canvas"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
          />
          {tip && (
            <div className="fg-tooltip" style={{ left: tipLeft, top: tipTop }}>
              <div className="fg-tooltip-name">
                <span className="fg-tooltip-kind">{tip.kind}</span>
                {tip.name || '(unnamed)'}
              </div>
              <div className="fg-tooltip-row">
                <span className="fg-tooltip-label">instance</span>
                <span className="fg-tooltip-value">
                  <span
                    className="swatch"
                    style={{
                      background: instanceColorVar(tipInst ? tipInst.colorIndex : 0),
                    }}
                  />
                  {(() => {
                    const n = tipInst ? tipInst.serviceName : tip.instanceId
                    return (
                      <span className="inst-name" title={n}>
                        {n}
                      </span>
                    )
                  })()}
                </span>
              </div>
              {tip.kind === 'span' && (
                <div className="fg-tooltip-row">
                  <span className="fg-tooltip-label">
                    {tip.count > 1 ? `mean ×${tip.count}` : 'duration'}
                  </span>
                  <span className="fg-tooltip-value mono-num">{formatNs(tip.durNs)}</span>
                </div>
              )}
              {tip.kind === 'span' && tip.selfNs >= 0 && (
                <div className="fg-tooltip-row">
                  <span className="fg-tooltip-label">self</span>
                  <span className="fg-tooltip-value mono-num">{formatNs(tip.selfNs)}</span>
                </div>
              )}
              {tip.startNs >= 0 && (
                <div className="fg-tooltip-row">
                  <span className="fg-tooltip-label">
                    {tip.kind === 'event' ? 'time' : 'start'}
                  </span>
                  <span className="fg-tooltip-value mono-num">
                    +{formatNs(tip.startNs)}
                  </span>
                </div>
              )}
              {tip.kind === 'event' && tip.spanName !== undefined && (
                <div className="fg-tooltip-row">
                  <span className="fg-tooltip-label">span</span>
                  <span className="fg-tooltip-value">{tip.spanName}</span>
                </div>
              )}
              {tip.level && (
                <div className="fg-tooltip-row">
                  <span className="fg-tooltip-label">level</span>
                  <span className={`level level-${tip.level}`}>{tip.level}</span>
                </div>
              )}
              {tip.kind === 'span' && (
                <div className="fg-tooltip-row">
                  <span className="fg-tooltip-label">events</span>
                  <span className="fg-tooltip-value mono-num">{tip.eventCount}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
