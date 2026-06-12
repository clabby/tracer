/*
 * Request parsing — the GET query dialect and the POST body both funnel into
 * the same (FilterState, TimeRange) pair the shared TraceQL compiler and
 * Tempo client consume. Invalid input throws a problem+json Response (the
 * dispatcher returns thrown Responses as-is) naming each offending parameter
 * with a corrected example, so agents can self-repair in one round trip.
 */

import {
  DEFAULT_FILTER,
  LEVELS,
  type AttrFilter,
  type FilterState,
  type Level,
  type TimeRange,
} from '../src/lib/model'
import { parseDurationInput } from '../src/lib/format'
import { resolveRange } from '../src/lib/range'
import type { SearchRange } from '../src/lib/apischema'
import { badRequest, type InvalidParam } from './problem'

export const MAX_LIMIT = 1000
const DEFAULT_RANGE_SECONDS = 15 * 60

const ATTR_RE = /^(span|resource|event)\.(.+?)(=~|!~|!=|>=|<=|=|>|<)(.*)$/
const SCOPES = ['span', 'resource', 'event'] as const

// ---------------------------------------------------------------- helpers --

function fail(detail: string, invalidParams: InvalidParam[]): never {
  throw badRequest(detail, invalidParams)
}

function parseBool(
  raw: string,
  name: string,
  errors: InvalidParam[],
  fallback: boolean,
): boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  errors.push({ name, reason: `expected "true" or "false", got "${raw}"`, example: 'true' })
  return fallback
}

function parseLimit(raw: string | null, errors: InvalidParam[]): number {
  if (raw === null) return DEFAULT_FILTER.limit
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    errors.push({
      name: 'limit',
      reason: `expected an integer in 1-${MAX_LIMIT}, got "${raw}"`,
      example: '50',
    })
    return DEFAULT_FILTER.limit
  }
  return n
}

function parseLevels(raw: string[], errors: InvalidParam[]): Level[] {
  const out: Level[] = []
  for (const v of raw) {
    if ((LEVELS as readonly string[]).includes(v)) out.push(v as Level)
    else
      errors.push({
        name: 'level',
        reason: `unknown level "${v}" — one of ${LEVELS.join(', ')}`,
        example: 'error',
      })
  }
  return out
}

function parseAttrs(raw: string[], errors: InvalidParam[]): AttrFilter[] {
  const out: AttrFilter[] = []
  for (const [i, v] of raw.entries()) {
    const m = ATTR_RE.exec(v)
    if (m === null) {
      errors.push({
        name: 'attr',
        reason: `expected <scope>.<key><op><value> with scope in {span, resource, event} and op in {=, !=, =~, !~, >, <, >=, <=}; got "${v}"`,
        example: 'span.view=notarization',
      })
      continue
    }
    out.push({
      id: `q${i}`,
      scope: m[1] as AttrFilter['scope'],
      key: m[2],
      op: m[3] as AttrFilter['op'],
      value: m[4],
    })
  }
  return out
}

function checkDuration(raw: string | null, name: string, errors: InvalidParam[]): string {
  if (raw === null || raw.trim() === '') return ''
  if (parseDurationInput(raw) === null) {
    errors.push({
      name,
      reason: `expected a duration like "150ms", "1.5s", "2m"; got "${raw}"`,
      example: '150ms',
    })
    return ''
  }
  return raw
}

// ------------------------------------------------------------- GET dialect --

export interface ParsedSearch {
  filter: FilterState
  range: TimeRange
}

/**
 * Parse the flat GET query dialect. Recognized: service (repeatable), name,
 * nameRegex, level (repeatable), errorsOnly, minDuration, maxDuration,
 * attr (repeatable), q, limit, since, from, to. Unknown parameters are
 * rejected so typos fail loudly instead of silently matching everything.
 */
export function parseSearchQuery(url: URL, extraParams: readonly string[] = []): ParsedSearch {
  const errors: InvalidParam[] = []
  const known = new Set([
    'service',
    'name',
    'nameRegex',
    'level',
    'errorsOnly',
    'minDuration',
    'maxDuration',
    'attr',
    'q',
    'limit',
    'since',
    'from',
    'to',
    ...extraParams,
  ])
  for (const key of new Set(url.searchParams.keys())) {
    if (!known.has(key)) {
      errors.push({
        name: key,
        reason: `unknown parameter — known: ${[...known].join(', ')}`,
      })
    }
  }

  const p = url.searchParams
  const filter: FilterState = {
    services: p.getAll('service').filter((s) => s !== ''),
    name: p.get('name') ?? '',
    nameIsRegex:
      p.get('nameRegex') !== null
        ? parseBool(p.get('nameRegex') as string, 'nameRegex', errors, true)
        : true,
    levels: parseLevels(p.getAll('level'), errors),
    attrs: parseAttrs(p.getAll('attr'), errors),
    minDuration: checkDuration(p.get('minDuration'), 'minDuration', errors),
    maxDuration: checkDuration(p.get('maxDuration'), 'maxDuration', errors),
    errorsOnly:
      p.get('errorsOnly') !== null
        ? parseBool(p.get('errorsOnly') as string, 'errorsOnly', errors, false)
        : false,
    rawQuery: p.get('q') ?? '',
    limit: parseLimit(p.get('limit'), errors),
  }

  const range = parseRangeParams(p.get('since'), p.get('from'), p.get('to'), errors)
  if (errors.length > 0) fail('One or more query parameters are invalid.', errors)
  return { filter, range }
}

function parseRangeParams(
  since: string | null,
  from: string | null,
  to: string | null,
  errors: InvalidParam[],
): TimeRange {
  const now = Date.now()
  if (since !== null) {
    if (from !== null || to !== null) {
      errors.push({
        name: 'since',
        reason: '`since` is mutually exclusive with `from`/`to`',
        example: 'since=15m',
      })
      return resolveRange({ kind: 'relative', seconds: DEFAULT_RANGE_SECONDS }, now)
    }
    const ns = parseDurationInput(since)
    if (ns === null || ns <= 0) {
      errors.push({
        name: 'since',
        reason: `expected a duration like "15m", "1h"; got "${since}"`,
        example: '15m',
      })
      return resolveRange({ kind: 'relative', seconds: DEFAULT_RANGE_SECONDS }, now)
    }
    return resolveRange({ kind: 'relative', seconds: Math.max(1, Math.round(ns / 1e9)) }, now)
  }
  if (from !== null || to !== null) {
    const f = Number(from)
    const t = Number(to)
    // from === to is a degenerate-but-legal empty window (the UI can produce
    // it via sub-second custom ranges) — it searches nothing, not a 400.
    if (from === null || to === null || !Number.isFinite(f) || !Number.isFinite(t) || f > t) {
      errors.push({
        name: 'from',
        reason: '`from` and `to` must both be set, unix SECONDS, with from <= to',
        example: 'from=1765400000&to=1765403600',
      })
      return resolveRange({ kind: 'relative', seconds: DEFAULT_RANGE_SECONDS }, now)
    }
    return { from: f, to: t }
  }
  return resolveRange({ kind: 'relative', seconds: DEFAULT_RANGE_SECONDS }, now)
}

// -------------------------------------------------------------- POST body --

/** Read and validate a JSON body; throws problem+json on garbage. */
export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw badRequest('Body must be valid JSON.', [
      { name: '(body)', reason: 'unparseable JSON', example: '{"filter": {"errorsOnly": true}}' },
    ])
  }
}

/**
 * Validate a POST search body ({ filter?, range? }) into the same shape the
 * GET dialect produces. Field-by-field checks; unknown keys are rejected.
 */
export function parseSearchBody(body: unknown): ParsedSearch {
  const errors: InvalidParam[] = []
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    fail('Body must be a JSON object: { filter?, range? }.', [
      { name: '(body)', reason: 'not an object', example: '{"filter": {"errorsOnly": true}}' },
    ])
  }
  const o = body as Record<string, unknown>
  for (const key of Object.keys(o)) {
    if (key !== 'filter' && key !== 'range') {
      errors.push({ name: key, reason: 'unknown body field — known: filter, range' })
    }
  }

  const filter = parseFilterObject(o.filter, errors)
  const range = parseRangeObject(o.range, errors)
  if (errors.length > 0) fail('The request body is invalid.', errors)
  return { filter, range }
}

/** Validate a partial FilterState object, filling defaults. */
export function parseFilterObject(raw: unknown, errors: InvalidParam[]): FilterState {
  const filter: FilterState = { ...DEFAULT_FILTER, attrs: [], services: [], levels: [] }
  if (raw === undefined || raw === null) return filter
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ name: 'filter', reason: 'must be an object', example: '{"errorsOnly": true}' })
    return filter
  }
  const f = raw as Record<string, unknown>

  const strArray = (v: unknown, name: string): string[] => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      errors.push({ name, reason: 'must be an array of strings', example: '["node-1"]' })
      return []
    }
    return v as string[]
  }

  for (const [key, value] of Object.entries(f)) {
    switch (key) {
      case 'services':
        filter.services = strArray(value, 'filter.services')
        break
      case 'name':
        if (typeof value === 'string') filter.name = value
        else errors.push({ name: 'filter.name', reason: 'must be a string', example: '"verify"' })
        break
      case 'nameIsRegex':
        if (typeof value === 'boolean') filter.nameIsRegex = value
        else errors.push({ name: 'filter.nameIsRegex', reason: 'must be a boolean', example: 'true' })
        break
      case 'levels': {
        const raws = strArray(value, 'filter.levels')
        filter.levels = parseLevels(raws, errors)
        break
      }
      case 'attrs':
        filter.attrs = parseAttrObjects(value, errors)
        break
      case 'minDuration':
        if (typeof value === 'string') filter.minDuration = checkDuration(value, 'filter.minDuration', errors)
        else errors.push({ name: 'filter.minDuration', reason: 'must be a duration string', example: '"150ms"' })
        break
      case 'maxDuration':
        if (typeof value === 'string') filter.maxDuration = checkDuration(value, 'filter.maxDuration', errors)
        else errors.push({ name: 'filter.maxDuration', reason: 'must be a duration string', example: '"2s"' })
        break
      case 'errorsOnly':
        if (typeof value === 'boolean') filter.errorsOnly = value
        else errors.push({ name: 'filter.errorsOnly', reason: 'must be a boolean', example: 'true' })
        break
      case 'rawQuery':
        if (typeof value === 'string') filter.rawQuery = value
        else errors.push({ name: 'filter.rawQuery', reason: 'must be a TraceQL string', example: '"{ status = error }"' })
        break
      case 'limit':
        if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT) {
          filter.limit = value
        } else {
          errors.push({ name: 'filter.limit', reason: `must be an integer in 1-${MAX_LIMIT}`, example: '50' })
        }
        break
      default:
        errors.push({ name: `filter.${key}`, reason: 'unknown filter field' })
    }
  }
  return filter
}

function parseAttrObjects(raw: unknown, errors: InvalidParam[]): AttrFilter[] {
  if (!Array.isArray(raw)) {
    errors.push({
      name: 'filter.attrs',
      reason: 'must be an array of { scope, key, op, value }',
      example: '[{"scope":"span","key":"view","op":"=","value":"notarization"}]',
    })
    return []
  }
  const out: AttrFilter[] = []
  const KNOWN_ATTR_KEYS = ['id', 'scope', 'key', 'op', 'value']
  for (const [i, entry] of raw.entries()) {
    const name = `filter.attrs[${i}]`
    if (entry === null || typeof entry !== 'object') {
      errors.push({ name, reason: 'must be an object', example: '{"scope":"span","key":"view","op":"=","value":"5"}' })
      continue
    }
    const a = entry as Record<string, unknown>
    for (const k of Object.keys(a)) {
      if (!KNOWN_ATTR_KEYS.includes(k)) {
        errors.push({ name: `${name}.${k}`, reason: `unknown attr field — known: ${KNOWN_ATTR_KEYS.join(', ')}` })
      }
    }
    const scope = a.scope
    const op = a.op
    if (!SCOPES.includes(scope as (typeof SCOPES)[number])) {
      errors.push({ name: `${name}.scope`, reason: 'must be span, resource, or event', example: 'span' })
      continue
    }
    if (typeof a.key !== 'string' || a.key.trim() === '') {
      errors.push({ name: `${name}.key`, reason: 'must be a non-empty string', example: 'view' })
      continue
    }
    const OPS: readonly AttrFilter['op'][] = ['=', '!=', '=~', '!~', '>', '<', '>=', '<=']
    if (!OPS.includes(op as AttrFilter['op'])) {
      errors.push({ name: `${name}.op`, reason: `must be one of ${OPS.join(' ')}`, example: '=' })
      continue
    }
    if (typeof a.value !== 'string') {
      errors.push({ name: `${name}.value`, reason: 'must be a string (numbers/bools as strings)', example: '"5"' })
      continue
    }
    out.push({
      id: typeof a.id === 'string' ? a.id : `b${i}`,
      scope: scope as AttrFilter['scope'],
      key: a.key,
      op: op as AttrFilter['op'],
      value: a.value,
    })
  }
  return out
}

function parseRangeObject(raw: unknown, errors: InvalidParam[]): TimeRange {
  const now = Date.now()
  if (raw === undefined || raw === null) {
    return resolveRange({ kind: 'relative', seconds: DEFAULT_RANGE_SECONDS }, now)
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ name: 'range', reason: 'must be an object', example: '{"lastSeconds": 900}' })
    return resolveRange({ kind: 'relative', seconds: DEFAULT_RANGE_SECONDS }, now)
  }
  const r = raw as Record<string, unknown> & SearchRange
  for (const key of Object.keys(r)) {
    if (key !== 'from' && key !== 'to' && key !== 'lastSeconds') {
      errors.push({ name: `range.${key}`, reason: 'unknown range field — known: from, to, lastSeconds' })
    }
  }
  if (r.lastSeconds !== undefined) {
    if (r.from !== undefined || r.to !== undefined) {
      errors.push({
        name: 'range.lastSeconds',
        reason: 'mutually exclusive with range.from/range.to',
        example: '{"lastSeconds": 900}',
      })
    } else if (typeof r.lastSeconds !== 'number' || !(r.lastSeconds > 0)) {
      errors.push({ name: 'range.lastSeconds', reason: 'must be a positive number of seconds', example: '900' })
    } else {
      return resolveRange({ kind: 'relative', seconds: r.lastSeconds }, now)
    }
    return resolveRange({ kind: 'relative', seconds: DEFAULT_RANGE_SECONDS }, now)
  }
  if (r.from !== undefined || r.to !== undefined) {
    if (
      typeof r.from !== 'number' ||
      typeof r.to !== 'number' ||
      !Number.isFinite(r.from) ||
      !Number.isFinite(r.to) ||
      r.from > r.to
    ) {
      errors.push({
        name: 'range.from',
        reason: 'range.from and range.to must both be unix SECONDS with from <= to',
        example: '{"from": 1765400000, "to": 1765403600}',
      })
      return resolveRange({ kind: 'relative', seconds: DEFAULT_RANGE_SECONDS }, now)
    }
    return { from: r.from, to: r.to }
  }
  return resolveRange({ kind: 'relative', seconds: DEFAULT_RANGE_SECONDS }, now)
}
