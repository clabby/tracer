/*
 * FilterState → TraceQL compiler.
 *
 * `buildTraceQL` turns the structured search filter into a single TraceQL
 * expression `{ a && b && ... }`. When `rawQuery` is non-empty it wins and is
 * returned verbatim. An empty filter compiles to `{}`.
 */

import type { FilterState, SearchTarget } from './model'
import { parseDurationInput } from './format'

/** Escape `"` and `\` so a value can sit inside a quoted TraceQL string. */
function escapeQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Render a TraceQL string literal. */
function quote(value: string): string {
  return `"${escapeQuoted(value)}"`
}

/** Escape regex metacharacters so a literal value matches itself. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Quoted `^(a|b|c)$` alternation over literal (regex-escaped) values. */
function alternation(values: readonly string[]): string {
  return quote(`^(${values.map(escapeRegex).join('|')})$`)
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/

/** May the value be emitted unquoted (TraceQL number/bool literal)? */
function isBareValue(value: string): boolean {
  return NUMBER_RE.test(value) || value === 'true' || value === 'false'
}

/** Attribute keys that may sit bare after `span.` / `resource.`. */
const BARE_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/**
 * Render an attribute key. Plain identifiers stay bare; anything else (spaces,
 * quotes, TraceQL terminal characters…) uses the quoted form `span."my key"`.
 */
function attrKey(key: string): string {
  return BARE_KEY_RE.test(key) ? key : quote(key)
}

/**
 * Compile a `FilterState` into a TraceQL query string.
 *
 * `target` decides what the name/level sections mean: for 'spans' they match
 * the span name and `span.level`; for 'events' they match `event:name` and
 * `event.level` (the tracing bridge records event levels uppercase, so event
 * levels match case-insensitively).
 */
export function buildTraceQL(filter: FilterState, target: SearchTarget = 'spans'): string {
  if (filter.rawQuery.trim() !== '') return filter.rawQuery

  const clauses: string[] = []
  const forEvents = target === 'events'

  const services = filter.services.filter((s) => s !== '')
  if (services.length === 1) {
    clauses.push(`resource.service.name = ${quote(services[0])}`)
  } else if (services.length > 1) {
    clauses.push(`resource.service.name =~ ${alternation(services)}`)
  }

  const name = filter.name.trim()
  const nameLhs = forEvents ? 'event:name' : 'name'
  if (name !== '') {
    // Tempo >= 2.7 fully anchors `=~` (treats `p` as `^p$`), so a bare
    // pattern would silently degenerate to exact match. Wrap it in
    // `.*(p).*` to restore substring semantics; RE2 still honors `^`/`$`
    // inside the group, so explicitly anchored patterns keep working. The
    // service/level alternations below are NOT wrapped — they are
    // intentionally exact `^(a|b)$` matches.
    clauses.push(
      filter.nameIsRegex
        ? `${nameLhs} =~ ${quote(`.*(${name}).*`)}`
        : `${nameLhs} = ${quote(name)}`,
    )
  } else if (forEvents) {
    // Event searches must only match spans that actually contain events.
    clauses.push(`event:name =~ ${quote('.+')}`)
  }

  if (filter.levels.length > 0) {
    if (forEvents) {
      // Event level attributes arrive uppercase ("INFO") from the tracing
      // bridge; match case-insensitively.
      const alts = filter.levels.join('|')
      clauses.push(`event.level =~ ${quote(`(?i)^(${alts})$`)}`)
    } else if (filter.levels.length === 1) {
      clauses.push(`span.level = ${quote(filter.levels[0])}`)
    } else {
      clauses.push(`span.level =~ ${alternation(filter.levels)}`)
    }
  }

  if (filter.errorsOnly) clauses.push('status = error')

  // Durations are re-emitted as canonical integer nanoseconds rather than
  // echoing the user text: `parseDurationInput` is more lenient than Tempo's
  // lexer (uppercase units, internal spaces, Greek µ), and `<n>ns` is always
  // a valid TraceQL duration literal.
  const minNs = parseDurationInput(filter.minDuration)
  if (minNs !== null) clauses.push(`duration > ${Math.round(minNs)}ns`)
  const maxNs = parseDurationInput(filter.maxDuration)
  if (maxNs !== null) clauses.push(`duration < ${Math.round(maxNs)}ns`)

  for (const attr of filter.attrs) {
    const key = attr.key.trim()
    if (key === '') continue
    const value = attr.value.trim()
    const lhs = `${attr.scope}.${attrKey(key)}`
    const isRegexOp = attr.op === '=~' || attr.op === '!~'
    if (!isRegexOp && isBareValue(value)) {
      if (attr.op === '=' || attr.op === '!=') {
        // Numeric-looking values may be stored as ints OR strings (e.g. the
        // tracing crate exports u64 fields as strings). Match either; a
        // type-mismatched comparison is simply false in TraceQL, so the OR
        // form is correct for both = and !=.
        clauses.push(`(${lhs} ${attr.op} ${value} || ${lhs} ${attr.op} ${quote(value)})`)
      } else {
        clauses.push(`${lhs} ${attr.op} ${value}`)
      }
    } else {
      clauses.push(`${lhs} ${attr.op} ${quote(value)}`)
    }
  }

  return clauses.length === 0 ? '{}' : `{ ${clauses.join(' && ')} }`
}
