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
 * Rendering is devicePixelRatio-aware. Instance lanes use lazy native-resolution
 * canvases; merged mode and the overview share the parent repaint scheduler.
 * Colors come from the resolved theme, and hit-testing uses rect arrays bucketed
 * by row so mousemove never scans every span.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { fitCanvasBackingStore, nativeCanvasSize, splitCanvasRows } from '../lib/canvas'
import { clamp, formatClock, formatNs } from '../lib/format'
import {
  instanceColorVar,
  type AggregateNode,
  type FlameGraphProps,
  type Instance,
  type Level,
  type SpanEvent,
  type SpanNode,
} from '../lib/model'
import { buildAggregateTree } from '../lib/trace'
import { spanSubsystem, subsystemPalette } from '../lib/subsystem'
import FlameTimeline from './FlameTimeline'
import Select from './Select'
import './FlameGraph.css'

// ------------------------------------------------------------- constants --

const RULER_H = 26
const ROW_H = 20
// A canvas can't grow past the browser's max backing-store dimension (~16384px
// on Chrome/Safari); exceed it and the 2D context enters a permanent error
// state (every draw call throws).
const MAX_CANVAS_PX = 16384
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

interface InstanceColor {
  /** Solid base color (the lane dot / minimap fill / cell border source). */
  base: string
  /** Translucent tint fills, indexed by depth-shade level. */
  fills: string[]
  /** Cell border: a lighter tint of the base, like a .btn edge. */
  border: string
  label: string
}

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
  /** Instance saturation/lightness (%), from --instance-sat/-lum per theme. */
  sat: number
  lum: number
  /** Memoized hue → derived colors, so a frame never recomputes per span. */
  colorCache: Map<number, InstanceColor>
  unknownSubsystem: InstanceColor
  font: string
  fontSmall: string
  charW: number
  charWSmall: number
}

/** Derive (and cache) an instance's colors from its hue at the theme's S/L. */
function instanceColor(theme: Theme, hue: number): InstanceColor {
  let c = theme.colorCache.get(hue)
  if (c === undefined) {
    const base = hslCss(hue, theme.sat, theme.lum)
    c = { base, fills: alphaRamp(base), border: lighten(base, 0.4), label: contrastText(base, theme.bg, theme.text) }
    theme.colorCache.set(hue, c)
  }
  return c
}

interface View {
  t0: number
  t1: number
}

// Linear 500ms ramp, with no delay: pan 2→4 view widths/s; zoom 3→5.25
// doublings/s. Arrow scrolling uses the pan rate in viewport heights/s.
export function keyboardNavigationSpeed(heldSeconds: number, motion: 'pan' | 'zoom'): number {
  const progress = clamp(heldSeconds / 0.5, 0, 1)
  return motion === 'pan' ? 2 * (1 + progress) : 3 * (1 + 0.75 * progress)
}

/** Integrate viewport-relative pan and exponential, cursor-anchored zoom. */
export function navigateFlameView(
  view: View, extent: View, pan: number, zoom: number, anchor: number, dt: number,
): View {
  const span = Math.max(1, extent.t1 - extent.t0)
  const win = clamp(view.t1 - view.t0, Math.min(MIN_WINDOW_NS, span), span)
  const start = clamp(view.t0, extent.t0, extent.t1 - win)
  const nextWin = clamp(win * Math.exp(zoom * dt), Math.min(MIN_WINDOW_NS, span), span)
  // Integrate panning over the changing window, including simultaneous W+D.
  const meanWin = nextWin === win ? win : (nextWin - win) / Math.log(nextWin / win)
  const t0 = clamp(start + (win - nextWin) * anchor + pan * meanWin * dt,
    extent.t0, extent.t1 - nextWin)
  return { t0, t1: t0 + nextWin }
}

interface Geom {
  plotX0: number
  plotW: number
  cssW: number
  cssH: number
  t0: number
  t1: number
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

/** HSL (hue in degrees, s/l in %) → `rgb(r, g, b)`, matching CSS hsl() so the
 *  canvas fills agree with the inline-style swatches built by instanceColorVar. */
function hslCss(h: number, s: number, l: number): string {
  const sn = s / 100
  const ln = l / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x]
  const m = ln - c / 2
  const to = (n: number) => Math.round((n + m) * 255)
  return `rgb(${to(r1)}, ${to(g1)}, ${to(b1)})`
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

/** Pick the more legible of the theme's light/dark foregrounds, once per hue. */
function contrastText(base: string, a: string, b: string): string {
  const luminance = (color: string) => {
    const rgb = parseRgb(color)
    if (!rgb) return 0
    const [r, g, blue] = rgb.map((value) => {
      const c = value / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * blue
  }
  const background = luminance(base) + 0.05
  const contrast = (color: string) => {
    const foreground = luminance(color) + 0.05
    return Math.max(background, foreground) / Math.min(background, foreground)
  }
  return contrast(a) >= contrast(b) ? a : b
}

function resolveTheme(): Theme {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback
  const mono = v('--font-mono', 'monospace')
  const num = (name: string, fallback: number) => parseFloat(v(name, String(fallback))) || fallback
  const flameBg = v('--flame-bg', '#121217')
  const unknown = cs.getPropertyValue('--subsystem-unknown').trim()
  const bg = v('--bg', '#0e0e12')
  const text = v('--text', '#e7e7ec')
  return {
    bg,
    flameBg,
    flameGrid: v('--flame-grid', '#1e1e25'),
    border: v('--border', '#26262e'),
    text,
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
    sat: num('--instance-sat', 72),
    lum: num('--instance-lum', 70),
    colorCache: new Map(),
    unknownSubsystem: { base: unknown, fills: alphaRamp(unknown), border: lighten(unknown, 0.4), label: contrastText(unknown, bg, text) },
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

interface FlameLaneProps {
  lane: ActiveLane
  width: number
  rangeLo: number
  rangeHi: number
  view: View | null
  selectedSpanId: string | null
  showEvents: boolean
  search: string
  selfTime: boolean
  selfTimes: Map<string, number>
  subsystemColors: ReadonlyMap<string, number> | null
  scrollRoot: HTMLElement | null
  paintVersion: number
  onHover: (hit: HitRect, clientX: number, clientY: number) => void
  onLeave: () => void
  onPick: (hit: HitRect | null) => void
  onFocus: (name: string | null) => void
  onPanStart: (canvas: HTMLCanvasElement, clientX: number) => void
}

interface FlameLaneTileProps extends Omit<FlameLaneProps, 'scrollRoot'> {
  startRow: number
  rowCount: number
  last: boolean
}

function FlameLaneTile(props: FlameLaneTileProps) {
  const {
    lane,
    width,
    rangeLo,
    rangeHi,
    view,
    selectedSpanId,
    showEvents,
    search,
    selfTime,
    selfTimes,
    subsystemColors,
    paintVersion,
    startRow,
    rowCount,
    last,
    onHover,
    onLeave,
    onPick,
    onFocus,
    onPanStart,
  } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const hitRef = useRef<Array<HitRect[] | undefined>>([])
  const eventHitRef = useRef<Array<HitRect[] | undefined>>([])
  const cssHeight = rowCount * ROW_H + (last ? LANE_GAP_ROWS * ROW_H : 0)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const theme = resolveTheme()
    const dpr = window.devicePixelRatio || 1
    const size = nativeCanvasSize(width, cssHeight, dpr)
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width
      canvas.height = size.height
    }
    canvas.style.width = `${width}px`
    canvas.style.height = `${cssHeight}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = theme.flameBg
    ctx.fillRect(0, 0, width, cssHeight)
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.lineWidth = 1
    ctx.font = theme.font
    theme.charW = ctx.measureText('0').width || 7
    ctx.font = theme.fontSmall
    theme.charWSmall = ctx.measureText('0').width || 6

    const rangeSpan = Math.max(1, rangeHi - rangeLo)
    const minWin = Math.min(MIN_WINDOW_NS, rangeSpan)
    const win = view ? clamp(view.t1 - view.t0, minWin, rangeSpan) : rangeSpan
    const t0 = view ? clamp(view.t0, rangeLo, rangeHi - win) : rangeLo
    const t1 = t0 + win
    const plotW = Math.max(1, width - GUTTER)
    const toX = (time: number) => GUTTER + (time - t0) * (plotW / win)

    const step = niceStep((win * 90) / plotW)
    for (let time = Math.ceil(t0 / step) * step; time <= t1 + step * 1e-6; time += step) {
      const x = Math.round(toX(time)) + 0.5
      ctx.strokeStyle = theme.flameGrid
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, cssHeight)
      ctx.stroke()
    }
    ctx.strokeStyle = theme.border
    ctx.beginPath()
    ctx.moveTo(GUTTER - 0.5, 0)
    ctx.lineTo(GUTTER - 0.5, cssHeight)
    ctx.stroke()

    const laneColor = instanceColor(theme, lane.inst.colorIndex)
    ctx.fillStyle = laneColor.base
    ctx.fillRect(0, 2, 3, Math.max(cssHeight - (last ? ROW_H : 0) - 4, 1))
    if (startRow === 0) {
      ctx.font = theme.font
      ctx.fillStyle = theme.textMuted
      ctx.fillText(
        ellipsize(lane.inst.serviceName, GUTTER - 18, theme.charW || 7),
        10,
        ROW_H / 2,
      )
      if (lane.maxDepth > 0) {
        ctx.font = theme.fontSmall
        ctx.fillStyle = theme.textFaint
        ctx.fillText(
          ellipsize(`${lane.inst.spanCount} spans`, GUTTER - 18, theme.charWSmall || 6),
          10,
          ROW_H + ROW_H / 2,
        )
      }
    }
    if (last) {
      ctx.strokeStyle = theme.flameGrid
      ctx.beginPath()
      ctx.moveTo(0, rowCount * ROW_H + ROW_H / 2 + 0.5)
      ctx.lineTo(width, rowCount * ROW_H + ROW_H / 2 + 0.5)
      ctx.stroke()
    }

    const buckets: Array<HitRect[] | undefined> = new Array(rowCount)
    const eventBuckets: Array<HitRect[] | undefined> = new Array(rowCount)
    const tileEnd = startRow + rowCount
    const tileSpans = lane.spans.filter(({ depth }) => depth >= startRow && depth < tileEnd)
    const accRgb = parseRgb(theme.accent) ?? [123, 135, 247]
    const selfOverlay = `rgba(${accRgb[0]}, ${accRgb[1]}, ${accRgb[2]}, 0.6)`
    const bgRgb = parseRgb(theme.flameBg) ?? [18, 18, 23]
    const coverScrim = `rgba(${bgRgb[0]}, ${bgRgb[1]}, ${bgRgb[2]}, 0.6)`
    ctx.font = theme.font

    for (const { span, depth } of tileSpans) {
      const sx0 = toX(span.startNs)
      const sx1 = toX(span.startNs + span.durationNs)
      if (sx1 < GUTTER || sx0 > width) continue
      const x0 = Math.max(sx0, GUTTER)
      const x1 = Math.min(sx1, width)
      const barWidth = Math.max(x1 - x0 - CELL_GAP, 1)
      const localRow = depth - startRow
      const y = localRow * ROW_H + BAR_PAD_Y
      const isError = span.status === 'error' || span.level === 'error'
      ctx.globalAlpha = search !== '' && !span.name.toLowerCase().includes(search) ? 0.16 : 1
      const selfNs = selfTimes.get(span.spanId) ?? 0
      const hue = subsystemColors?.get(span.spanId)
      const color = subsystemColors === null ? laneColor
        : hue === undefined ? theme.unknownSubsystem : instanceColor(theme, hue)

      pathRoundRect(ctx, x0, y, barWidth, BAR_H, CELL_RADIUS)
      ctx.fillStyle = color.fills[Math.min(depth, SHADE_LEVELS - 1)]
      ctx.fill()
      if (barWidth >= 3) {
        ctx.strokeStyle = color.border
        ctx.stroke()
      }
      if (selfTime) {
        const end = span.startNs + span.durationNs
        const segment = (from: number, to: number, style: string) => {
          const left = Math.max(toX(from), x0)
          const right = Math.min(toX(to), x0 + barWidth)
          if (right - left > 0.5) {
            ctx.fillStyle = style
            ctx.fillRect(left, y, right - left, BAR_H)
          }
        }
        if (span.children.length === 0) {
          segment(span.startNs, end, selfOverlay)
        } else {
          const intervals = span.children
            .map((child) => [child.startNs, child.startNs + child.durationNs] as [number, number])
            .sort((a, b) => a[0] - b[0])
          const covered: [number, number][] = []
          for (const interval of intervals) {
            const previous = covered[covered.length - 1]
            if (previous && interval[0] <= previous[1]) {
              previous[1] = Math.max(previous[1], interval[1])
            }
            else covered.push([...interval])
          }
          let cursor = span.startNs
          for (const [from, to] of covered) {
            if (from > cursor) segment(cursor, from, selfOverlay)
            segment(Math.max(from, span.startNs), to, coverScrim)
            cursor = Math.max(cursor, to)
          }
          if (cursor < end) segment(cursor, end, selfOverlay)
        }
      }
      if (isError) {
        ctx.fillStyle = theme.error
        ctx.fillRect(x0 + CELL_RADIUS, y + BAR_H - 2, Math.max(barWidth - 2 * CELL_RADIUS, 1), 2)
      }
      if (span.spanId === selectedSpanId) {
        pathRoundRect(ctx, x0 + 1, y + 1, barWidth - 2, BAR_H - 2, CELL_RADIUS - 1)
        ctx.strokeStyle = theme.accent
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.lineWidth = 1
      }
      if (barWidth > LABEL_MIN_W) {
        ctx.fillStyle = subsystemColors === null ? theme.bg : color.label
        ctx.fillText(
          ellipsize(span.name, barWidth - 2 * CELL_PAD_X, theme.charW || 7),
          x0 + CELL_PAD_X,
          y + BAR_H / 2 + 0.5,
        )
      }
      ;(buckets[localRow] ??= []).push({
        kind: 'span',
        x0,
        x1,
        name: span.name,
        instanceId: lane.inst.id,
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

    if (showEvents) {
      for (const { span, depth } of tileSpans) {
        if (span.events.length === 0) continue
        const localRow = depth - startRow
        const cy = localRow * ROW_H + BAR_PAD_Y + BAR_H / 2
        for (const event of span.events) {
          const x = toX(event.timeNs)
          if (x < GUTTER || x > width) continue
          ctx.beginPath()
          ctx.moveTo(x, cy - 4.5)
          ctx.lineTo(x + 4.5, cy)
          ctx.lineTo(x, cy + 4.5)
          ctx.lineTo(x - 4.5, cy)
          ctx.closePath()
          ctx.fillStyle = theme.levels[event.level ?? 'trace']
          ctx.fill()
          ctx.strokeStyle = theme.bg
          ctx.stroke()
          ;(eventBuckets[localRow] ??= []).push({
            kind: 'event',
            x0: x - 5,
            x1: x + 5,
            name: event.name,
            instanceId: lane.inst.id,
            durNs: -1,
            selfNs: -1,
            startNs: event.timeNs,
            count: 1,
            level: event.level,
            error: event.level === 'error',
            eventCount: 1,
            selectId: span.spanId,
            spanName: span.name,
            event,
          })
        }
      }
    }
    hitRef.current = buckets
    eventHitRef.current = eventBuckets
  }, [
    lane,
    width,
    rangeLo,
    rangeHi,
    view,
    selectedSpanId,
    showEvents,
    search,
    selfTime,
    selfTimes,
    subsystemColors,
    paintVersion,
    startRow,
    rowCount,
    last,
    cssHeight,
  ])

  const hitTest = (x: number, y: number): HitRect | null => {
    const row = Math.floor(y / ROW_H)
    if (row < 0 || row >= rowCount) return null
    const events = eventHitRef.current[row]
    if (events) {
      let nearest: HitRect | null = null
      let distance = Infinity
      for (const hit of events) {
        if (x < hit.x0 || x > hit.x1) continue
        const next = Math.abs(x - (hit.x0 + hit.x1) / 2)
        if (next < distance) {
          nearest = hit
          distance = next
        }
      }
      if (nearest) return nearest
    }
    const hits = hitRef.current[row]
    if (!hits) return null
    for (let i = hits.length - 1; i >= 0; i--) {
      if (x >= hits[i].x0 && x <= hits[i].x1) return hits[i]
    }
    return null
  }

  const localHit = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return hitTest(event.clientX - rect.left, event.clientY - rect.top)
  }

  return (
    <canvas
      ref={canvasRef}
      className="fg-canvas fg-lane-canvas"
      onMouseDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        onPanStart(event.currentTarget, event.clientX)
      }}
      onMouseMove={(event) => {
        const hit = localHit(event)
        event.currentTarget.style.cursor = hit ? 'pointer' : 'default'
        if (hit) onHover(hit, event.clientX, event.clientY)
        else onLeave()
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.cursor = 'default'
        onLeave()
      }}
      onClick={(event) => onPick(localHit(event))}
      onDoubleClick={(event) => {
        const hit = localHit(event)
        onFocus(hit?.kind === 'span' ? hit.name : null)
      }}
    />
  )
}

function FlameLane(props: FlameLaneProps) {
  const { lane, scrollRoot } = props
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const tiles = splitCanvasRows(
    lane.maxDepth + 1,
    ROW_H,
    dpr,
    MAX_CANVAS_PX,
    LANE_GAP_ROWS,
  )
  const height = (lane.maxDepth + 1 + LANE_GAP_ROWS) * ROW_H

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || !scrollRoot || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry.isIntersecting),
      { root: scrollRoot, rootMargin: '100% 0px' },
    )
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [scrollRoot])

  return (
    <div ref={wrapperRef} className="fg-lane" style={{ height }}>
      {nearViewport && tiles.map((tile, index) => (
        <FlameLaneTile
          {...props}
          key={tile.startRow}
          startRow={tile.startRow}
          rowCount={tile.rowCount}
          last={index === tiles.length - 1}
        />
      ))}
    </div>
  )
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

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [canvasWidth, setCanvasWidth] = useState(0)
  const [paintVersion, setPaintVersion] = useState(0)
  const bindScroll = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    setScrollRoot(node)
  }, [])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const minimapRef = useRef<HTMLCanvasElement | null>(null)
  const cursorRef = useRef<HTMLDivElement | null>(null)
  const cursorLabelRef = useRef<HTMLSpanElement | null>(null)
  const cursorXRef = useRef<number | null>(null)

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
  const tooltipElementRef = useRef<HTMLDivElement | null>(null)
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
  const [colorBy, setColorBy] = useState<'instance' | 'subsystem'>('instance')

  const subsystems = useMemo(() => {
    const paths = new Map<string, string>()
    for (const span of model.spans.values()) {
      const path = spanSubsystem(span)
      if (path) paths.set(span.spanId, path)
    }
    return paths
  }, [model])
  const palette = useMemo(() => {
    // Theme tokens are available only in the browser, not during server rendering.
    if (typeof document === 'undefined') return new Map<string, number>()
    const cs = getComputedStyle(document.documentElement)
    return subsystemPalette(subsystems.values(),
      parseFloat(cs.getPropertyValue('--subsystem-hue-start')),
      parseFloat(cs.getPropertyValue('--subsystem-hue-spread')))
  }, [subsystems, paintVersion])
  const paletteEntries = useMemo(() => [...palette], [palette])
  const subsystemColors = useMemo(() => {
    if (colorBy === 'instance') return null
    return new Map([...subsystems].map(([id, path]) => [id, palette.get(path)!]))
  }, [subsystems, palette, colorBy])

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
    const buildFull = (): Active => {
      const lanes = sortLanes(
        model.instances
          .filter((i) => !hiddenInstances.has(i.id))
          .map((inst) => {
            const packed = packRows(inst.rootSpans)
            return { inst, spans: packed.spans, maxDepth: packed.maxRow }
          }),
        laneSort,
      )
      return { lo: 0, hi: fullHi, focused: false, lanes }
    }
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

  const spanSearch = highlight.trim().toLowerCase()
  const displayedLanes = useMemo(
    () => spanSearch === ''
      ? active.lanes
      : active.lanes.filter((lane) =>
          lane.spans.some(({ span }) => span.name.toLowerCase().includes(spanSearch)),
        ),
    [active.lanes, spanSearch],
  )
  const matchingInstanceIds = useMemo(
    () => new Set(displayedLanes.map((lane) => lane.inst.id)),
    [displayedLanes],
  )

  // Zoom/timeline extent: focus subtree in 'instances' mode, else full domain.
  const rangeLo = mode === 'instances' ? active.lo : 0
  const rangeHi = mode === 'instances' ? active.hi : domain
  rangeRef.current = { lo: rangeLo, hi: rangeHi }

  // ------------------------------------------------------------ rendering --

  // A DOM overlay follows the pointer without repainting spans or the minimap.
  // Read the painted geometry so zoom, focus, and resize use the same time axis.
  const updateCursor = useCallback(() => {
    const cursor = cursorRef.current
    const label = cursorLabelRef.current
    const scroll = scrollRef.current
    const g = geomRef.current
    if (!cursor || !label || !scroll || !g) return
    const x = cursorXRef.current === null ? -1
      : cursorXRef.current - scroll.getBoundingClientRect().left
    cursor.hidden = x < g.plotX0 || x > g.cssW
    if (cursor.hidden) return
    const time = g.t0 + (x - g.plotX0) / g.plotW * (g.t1 - g.t0)
    label.textContent = formatNs(time)
    cursor.style.transform = `translateX(${x}px)`
    const labelX = clamp(x - label.offsetWidth / 2, g.plotX0, g.cssW - label.offsetWidth)
    // The instances axis is sticky; merged mode's axis scrolls with its canvas.
    label.style.transform = `translate(${labelX - x}px, ${mode === 'instances' ? scroll.scrollTop : 0}px)`
  }, [mode])

  useEffect(() => {
    const scroll = scrollRoot
    if (!scroll) return
    let frame = 0
    const update = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        updateCursor()
      })
    }
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      cursorXRef.current = event.clientX
      update()
    }
    const hide = () => {
      cursorXRef.current = null
      if (cursorRef.current) cursorRef.current.hidden = true
    }
    scroll.addEventListener('pointermove', move)
    scroll.addEventListener('pointerleave', hide)
    scroll.addEventListener('scroll', update)
    window.addEventListener('blur', hide)
    return () => {
      cancelAnimationFrame(frame)
      hide()
      scroll.removeEventListener('pointermove', move)
      scroll.removeEventListener('pointerleave', hide)
      scroll.removeEventListener('scroll', update)
      window.removeEventListener('blur', hide)
    }
  }, [scrollRoot, updateCursor, model])

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

    // Row layout.
    let totalRows = 0
    if (mode === 'merged' && mergedLayout && mergedLayout.bars.length > 0) {
      totalRows = mergedLayout.maxDepth + 1
    }

    // The instance ruler stays at native DPR. Merged mode retains the guarded
    // single-canvas backing store because its height is not multiplied by lanes.
    const cssW = Math.max(80, scroll.clientWidth)
    const cssH = mode === 'instances' ? RULER_H : Math.max(140, RULER_H + totalRows * ROW_H + 10)
    const dpr = window.devicePixelRatio || 1
    const backing = mode === 'instances'
      ? { ...nativeCanvasSize(cssW, cssH, dpr), scaleX: dpr, scaleY: dpr }
      : fitCanvasBackingStore(cssW, cssH, dpr, MAX_CANVAS_PX)
    if (canvas.width !== backing.width || canvas.height !== backing.height) {
      canvas.width = backing.width
      canvas.height = backing.height
    }
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    ctx.setTransform(backing.scaleX, 0, 0, backing.scaleY, 0, 0)

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
    geomRef.current = { plotX0, plotW, cssW, cssH, t0, t1 }
    updateCursor()

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

    if (mode === 'instances') {
      hitRef.current = []
      eventHitRef.current = []
      return
    }

    // Hit buckets, one array per packed row. Event markers get their own
    // buckets so they win hover/click over the bars they sit on.
    const buckets: Array<HitRect[] | undefined> = new Array(totalRows)
    const evBuckets: Array<HitRect[] | undefined> = new Array(totalRows)

    if (mergedLayout) {
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
          const color = instanceColor(theme, seg.colorIndex)

          pathRoundRect(ctx, x0, y, w, BAR_H, CELL_RADIUS)
          ctx.fillStyle = color.fills[shade]
          ctx.fill()
          if (w >= 3) {
            ctx.strokeStyle = color.border
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

  // Activity overview inside the timeline track: one band per instance marking
  // where its spans are active across the active extent. Span search keeps all
  // bands for context and mutes lanes without a match.
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
      const laneTop = li * laneH
      const h = Math.max(laneH - gap, 2)
      const hasMatch = spanSearch === '' || al.spans.some(({ span: item }) =>
        item.name.toLowerCase().includes(spanSearch),
      )
      ctx.fillStyle = hasMatch
        ? instanceColor(theme, al.inst.colorIndex).base
        : theme.textFaint
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

  // Held keys drive a frame-timed loop, independent of OS key-repeat delay.
  useEffect(() => {
    const scroll = scrollRoot
    if (!scroll) return
    const held = new Map<string, number>()
    let frame = 0
    let lastTime = 0
    let mouseX: number | null = null
    const stop = () => {
      held.clear()
      cancelAnimationFrame(frame)
      frame = 0
    }
    const tick = (now: number) => {
      const dt = clamp((now - lastTime) / 1000, 0, 0.05)
      lastTime = now
      const speed = (code: string, motion: 'pan' | 'zoom') => {
        const since = held.get(code)
        return since === undefined ? 0 : keyboardNavigationSpeed(
          (now - since) / 1000 - dt / 2, motion,
        )
      }
      // Opposite directions cancel, even when one was held longer.
      const pan = held.has('KeyA') && held.has('KeyD') ? 0
        : speed('KeyD', 'pan') - speed('KeyA', 'pan')
      const zoom = held.has('KeyW') && held.has('KeyS') ? 0 : Math.LN2 * (
        speed('KeyS', 'zoom') - speed('KeyW', 'zoom')
      )
      const vertical = held.has('ArrowUp') && held.has('ArrowDown') ? 0
        : speed('ArrowDown', 'pan') - speed('ArrowUp', 'pan')
      if (vertical !== 0) {
        scroll.scrollTop += vertical * scroll.clientHeight * dt
        hideTip()
      }
      if (pan !== 0 || zoom !== 0) {
        const { lo, hi } = rangeRef.current
        const g = geomRef.current
        const anchor = mouseX === null || !g ? 0.5
          : clamp((mouseX - scroll.getBoundingClientRect().left - g.plotX0) / g.plotW, 0, 1)
        const extent = { t0: lo, t1: hi }
        const next = navigateFlameView(viewRef.current ?? extent, extent, pan, zoom, anchor, dt)
        applyView(next.t0, next.t1)
      }
      frame = requestAnimationFrame(tick)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) {
        stop()
        return
      }
      if (e.target !== scroll) return
      if (e.defaultPrevented || !['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown'].includes(e.code)) return
      e.preventDefault()
      if (!held.has(e.code)) held.set(e.code, performance.now())
      if (!frame) {
        lastTime = performance.now()
        frame = requestAnimationFrame(tick)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(e.code)
      if (held.size === 0) stop()
    }
    const onPointerMove = (e: PointerEvent) => { mouseX = e.clientX }
    const onPointerLeave = () => { mouseX = null }
    scroll.addEventListener('keydown', onKeyDown)
    scroll.addEventListener('blur', stop, true)
    scroll.addEventListener('pointermove', onPointerMove)
    scroll.addEventListener('pointerleave', onPointerLeave)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', stop)
    document.addEventListener('visibilitychange', stop)
    return () => {
      stop()
      scroll.removeEventListener('keydown', onKeyDown)
      scroll.removeEventListener('blur', stop, true)
      scroll.removeEventListener('pointermove', onPointerMove)
      scroll.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', stop)
      document.removeEventListener('visibilitychange', stop)
    }
  }, [applyView, hideTip, scrollRoot, model, mode, focusName])

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
  }, [schedule, model, mode, selectedSpanId, hiddenInstances, showEvents, focusName, highlight, active, selfTime])

  // Invalidate cached colors when the theme attribute flips.
  useEffect(() => {
    const mo = new MutationObserver(() => {
      themeRef.current = null
      setPaintVersion((version) => version + 1)
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
    const el = scrollRoot
    if (!el) return
    const update = () => {
      setCanvasWidth(Math.max(80, el.clientWidth))
      schedule()
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [schedule, scrollRoot])

  // Repaint when devicePixelRatio changes (window dragged across monitors).
  // The dppx value is baked into the media query, so re-register per value.
  useEffect(() => {
    let mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onChange = () => {
      setPaintVersion((version) => version + 1)
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
    const scroll = scrollRoot
    if (!scroll) return
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
      const rect = scroll.getBoundingClientRect()
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
    scroll.addEventListener('wheel', onWheel, { passive: false })
    return () => scroll.removeEventListener('wheel', onWheel)
  }, [schedule, hideTip, scrollRoot])

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

  const startPan = (canvas: HTMLCanvasElement, startX: number) => {
    // Focus the scrolling viewport so Page Up/Down retain native behavior.
    scrollRef.current?.focus({ preventScroll: true })
    suppressClickRef.current = false
    const g = geomRef.current
    if (!g) return
    const { lo, hi } = rangeRef.current
    const rangeSpan = Math.max(1, hi - lo)
    const minWin = Math.min(MIN_WINDOW_NS, rangeSpan)
    const v = viewRef.current
    const win = v ? clamp(v.t1 - v.t0, minWin, rangeSpan) : rangeSpan
    const startT0 = v ? clamp(v.t0, lo, hi - win) : lo
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

  const handleMouseDown = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    startPan(e.currentTarget, e.clientX)
  }

  const handleMouseMove = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current) return // panning is handled by window listeners
    const canvas = e.currentTarget
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const hit = hitTest(px, py)
    canvas.style.cursor = hit ? 'pointer' : 'default'
    if (hit) showTip({ ...hit, x: e.clientX, y: e.clientY })
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

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') onSelect(null)
  }

  // ----------------------------------------------------------------- view --

  const tipInst = tip ? instMap.get(tip.instanceId) : undefined
  useLayoutEffect(() => {
    const element = tooltipElementRef.current
    if (!tip || !element) return
    // Target paths can span several lines; position using the actual size.
    const { width, height } = element.getBoundingClientRect()
    const left = Math.max(4, Math.min(tip.x + 14, window.innerWidth - width - 4))
    const below = tip.y + 16
    const top = below + height <= window.innerHeight - 4 ? below : Math.max(4, tip.y - height - 16)
    element.style.left = `${left}px`
    element.style.top = `${top}px`
  }, [tip])

  const winT0 = viewWin ? clamp(viewWin.t0, rangeLo, rangeHi) : rangeLo
  const winT1 = viewWin ? clamp(viewWin.t1, rangeLo, rangeHi) : rangeHi

  // The span we're viewing: the focused subtree's name, or the trace's root
  // span name (the one shared by every visible instance's top-level span).
  const rootName =
    active.focused && focusName !== null
      ? focusName
      : (() => {
          const names = new Set<string>()
          for (const lane of displayedLanes)
            for (const ls of lane.spans) if (ls.depth === 0) names.add(ls.span.name)
          return names.size === 1 ? [...names][0] : names.size === 0 ? 'trace' : 'multiple roots'
        })()

  // Span/instance counts for the header: the focused subtree across visible
  // instances when focused, else every visible instance's spans.
  const shownSpans = displayedLanes.reduce((n, lane) => n + lane.spans.length, 0)
  const shownInstances = displayedLanes.length

  return (
    <div className="fg" onKeyDown={handleKeyDown}>
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
          const missedBySearch = spanSearch !== '' && !hidden && !matchingInstanceIds.has(inst.id)
          const stateClass = hidden
            ? ' fg-chip-hidden'
            : missedBySearch
              ? ' fg-chip-missed'
              : ''
          const action = hidden ? 'show' : 'hide'
          const searchState = missedBySearch ? ' · no spans match search' : ''
          return (
            <button
              key={inst.id}
              type="button"
              className={`chip fg-chip${stateClass}`}
              aria-pressed={!hidden}
              title={`${inst.id} · ${inst.spanCount} spans${searchState} · click to ${action}`}
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
            className="fg-sort fg-color-by"
            label="color spans by"
            value={colorBy}
            options={[
              { value: 'instance', label: 'color: instance' },
              { value: 'subsystem', label: 'color: target' },
            ]}
            onChange={setColorBy}
          />
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
        </div>
      )}

      {mode === 'instances' && colorBy === 'subsystem' && (
        <div className="fg-subsystems" aria-label="target color legend">
          {paletteEntries.filter(([path]) => !path.includes('::')).map(([path, hue]) => (
            <span key={path} className="fg-subsystem">
              <span className="swatch" style={{ background: instanceColorVar(hue) }} />
              {path}
            </span>
          ))}
          {subsystems.size < model.spans.size && (
            <span className="fg-subsystem" title="No target metadata or qualified span name">
              <span className="swatch" style={{ background: 'var(--subsystem-unknown)' }} />
              unknown
            </span>
          )}
          {palette.size > 0 && (
            <details className="fg-target-tree">
              <summary>target tree</summary>
              <div className="fg-target-tree-list">
                {paletteEntries.slice(0, 2000).map(([path, hue]) => {
                  const parts = path.split('::')
                  return <div key={path} className="fg-subsystem" title={path}
                    style={{ paddingLeft: (parts.length - 1) * 12 }}>
                    <span className="swatch" style={{ background: instanceColorVar(hue) }} />
                    <span className="fg-target-name">{parts.at(-1)}</span>
                  </div>
                })}
                {palette.size > 2000 && <span className="faint">Showing the first 2000 components.</span>}
              </div>
            </details>
          )}
        </div>
      )}

      <FlameTimeline
        low={rangeLo}
        high={rangeHi}
        viewLow={viewWin?.t0 ?? rangeLo}
        viewHigh={viewWin?.t1 ?? rangeHi}
        trackRef={timelineRef}
        label={mode === 'instances' ? 'timeline' : undefined}
        labelWidth={GUTTER}
        onChange={applyView}
        onReset={resetView}
      >
        <canvas ref={minimapRef} className="fg-timeline-minimap" />
      </FlameTimeline>

      <div
        className="fg-scroll"
        ref={bindScroll}
        tabIndex={0}
        role="region"
        aria-label="Flame graph. Hold W/S to zoom in/out at the cursor; A/D to pan left/right; Up/Down to scroll. Page Up/Down scroll by a page."
        aria-keyshortcuts="W A S D ArrowUp ArrowDown PageUp PageDown"
      >
        <div className="fg-canvas-wrap">
          {mode === 'instances' ? (
            <>
              <canvas ref={canvasRef} className="fg-canvas fg-ruler-canvas" />
              {displayedLanes.map((lane) => (
                <FlameLane
                  key={lane.inst.id}
                  lane={lane}
                  width={canvasWidth}
                  rangeLo={rangeLo}
                  rangeHi={rangeHi}
                  view={viewWin}
                  selectedSpanId={selectedSpanId}
                  showEvents={showEvents}
                  search={spanSearch}
                  selfTime={selfTime}
                  selfTimes={selfTimes.map}
                  subsystemColors={subsystemColors}
                  scrollRoot={scrollRoot}
                  paintVersion={paintVersion}
                  onHover={(hit, x, y) => showTip({ ...hit, x, y })}
                  onLeave={hideTip}
                  onPick={(hit) => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false
                      return
                    }
                    if (hit?.kind === 'event' && hit.event !== undefined) onSelectEvent(hit.event)
                    else onSelect(hit?.selectId ?? null)
                  }}
                  onFocus={(name) => name === null ? resetView() : setFocusName(name)}
                  onPanStart={startPan}
                />
              ))}
              {displayedLanes.length === 0 && (
                <div className="fg-lane-empty">
                  {spanSearch === '' ? 'all instances hidden' : 'no spans match search'}
                </div>
              )}
            </>
          ) : (
            <canvas
              ref={canvasRef}
              className="fg-canvas"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
            />
          )}
          <div ref={cursorRef} className="fg-cursor" hidden aria-hidden="true">
            <span ref={cursorLabelRef} className="fg-cursor-label mono-num" />
          </div>
          {tip && (
            <div className="fg-tooltip" ref={tooltipElementRef} style={{ left: tip.x + 14, top: tip.y + 16 }}>
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
              {mode === 'instances' && colorBy === 'subsystem' && tip.kind === 'span' && (
                <div className="fg-tooltip-row fg-tooltip-target-row">
                  <span className="fg-tooltip-label">target</span>
                  <span className="fg-tooltip-value fg-tooltip-target">
                    {(subsystems.get(tip.selectId) ?? 'unknown').split('::').map((part, index, parts) => (
                      <Fragment key={index}>
                        {part}{index < parts.length - 1 && <>::<wbr /></>}
                      </Fragment>
                    ))}
                  </span>
                </div>
              )}
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
