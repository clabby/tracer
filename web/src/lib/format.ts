/* Formatting and parsing helpers shared across the UI. */

/** Format a nanosecond duration for humans: 812ns, 4.21µs, 13.4ms, 2.04s. */
export function formatNs(ns: number): string {
  if (!Number.isFinite(ns)) return '—'
  const abs = Math.abs(ns)
  if (abs < 1e3) return `${Math.round(ns)}ns`
  if (abs < 1e6) return `${trim(ns / 1e3)}µs`
  if (abs < 1e9) return `${trim(ns / 1e6)}ms`
  if (abs < 60e9) return `${trim(ns / 1e9)}s`
  const totalSec = ns / 1e9
  const m = Math.floor(totalSec / 60)
  const s = Math.round(totalSec % 60)
  return `${m}m${s.toString().padStart(2, '0')}s`
}

function trim(v: number): string {
  const fixed = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ns|us|µs|μs|ms|s|m|h)\s*$/i

const UNIT_NS: Record<string, number> = {
  ns: 1,
  us: 1e3,
  'µs': 1e3,
  'μs': 1e3,
  ms: 1e6,
  s: 1e9,
  m: 60e9,
  h: 3600e9,
}

/**
 * Parse a human duration ("150ms", "1.5s", "2m") to nanoseconds.
 * Returns null when the input is not a valid duration.
 */
export function parseDurationInput(input: string): number | null {
  const m = DURATION_RE.exec(input)
  if (!m) return null
  const unit = UNIT_NS[m[2].toLowerCase()] ?? UNIT_NS[m[2]]
  if (unit === undefined) return null
  return parseFloat(m[1]) * unit
}

/** Is the input parseable by `parseDurationInput` (or empty)? */
export function isValidDurationInput(input: string): boolean {
  return input.trim() === '' || parseDurationInput(input) !== null
}

/** "14:03:21.482" — local wall-clock with millis. */
export function formatClock(unixMs: number): string {
  const d = new Date(unixMs)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  const ms = d.getMilliseconds().toString().padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

/** "2026-06-10 14:03:21.482" */
export function formatDateTime(unixMs: number): string {
  const d = new Date(unixMs)
  const y = d.getFullYear()
  const mo = (d.getMonth() + 1).toString().padStart(2, '0')
  const da = d.getDate().toString().padStart(2, '0')
  return `${y}-${mo}-${da} ${formatClock(unixMs)}`
}

/** "12s ago", "4m ago", "2h ago". */
export function formatAgo(unixMs: number, now: number = Date.now()): string {
  const sec = Math.max(0, Math.round((now - unixMs) / 1000))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Short hex preview of an id: first 8 chars. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

let uidCounter = 0
/** Cheap unique id for React list keys. */
export function uid(): string {
  uidCounter += 1
  return `u${uidCounter.toString(36)}`
}
