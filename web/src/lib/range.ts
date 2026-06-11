/* Time-range presets and helpers shared by the search panel and App. */

import type { RangeSelection, TimeRange } from './model'

export interface RangePreset {
  /** Menu label, e.g. "Last 15 minutes". */
  label: string
  /** Compact form for the trigger/bracket, e.g. "15m". */
  short: string
  seconds: number
}

export const RANGE_PRESETS: readonly RangePreset[] = [
  { label: 'Last 15 minutes', short: '15m', seconds: 15 * 60 },
  { label: 'Last 1 hour', short: '1h', seconds: 60 * 60 },
  { label: 'Last 3 hours', short: '3h', seconds: 3 * 60 * 60 },
  { label: 'Last 12 hours', short: '12h', seconds: 12 * 60 * 60 },
  { label: 'Last 24 hours', short: '24h', seconds: 24 * 60 * 60 },
]

export const DEFAULT_RANGE: RangeSelection = { kind: 'relative', seconds: 15 * 60 }

/** Resolve a selection to absolute unix-second bounds at the given instant. */
export function resolveRange(sel: RangeSelection, nowMs: number): TimeRange {
  if (sel.kind === 'relative') {
    const to = Math.floor(nowMs / 1000)
    return { from: to - sel.seconds, to }
  }
  return { from: Math.floor(sel.fromMs / 1000), to: Math.floor(sel.toMs / 1000) }
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`)

/** "Jun 10, 14:30:05" in local time. */
export function formatDateTimeShort(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}:${pad2(d.getSeconds())}`
}

/** Short label for the range trigger. */
export function rangeLabel(sel: RangeSelection): string {
  if (sel.kind === 'relative') {
    const preset = RANGE_PRESETS.find((p) => p.seconds === sel.seconds)
    return preset ? preset.label : `Last ${Math.round(sel.seconds / 60)}m`
  }
  return `${formatDateTimeShort(sel.fromMs)} → ${formatDateTimeShort(sel.toMs)}`
}
