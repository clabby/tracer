import { describe, expect, test } from 'bun:test'
import { buildTraceQL } from './traceql'
import { DEFAULT_FILTER } from './model'
import type { AttrFilter, AttrOp, FilterState } from './model'

function filter(over: Partial<FilterState>): FilterState {
  return { ...DEFAULT_FILTER, ...over }
}

let attrId = 0
function attr(scope: AttrFilter['scope'], key: string, op: AttrOp, value: string): AttrFilter {
  attrId += 1
  return { id: `a${attrId}`, scope, key, op, value }
}

describe('buildTraceQL', () => {
  test('empty filter compiles to {}', () => {
    expect(buildTraceQL(DEFAULT_FILTER)).toBe('{}')
  })

  // ---------------------------------------------------------------- services

  test('single service uses exact match', () => {
    expect(buildTraceQL(filter({ services: ['node-0'] }))).toBe(
      '{ resource.service.name = "node-0" }',
    )
  })

  test('single service escapes quotes and backslashes', () => {
    expect(buildTraceQL(filter({ services: ['no"de\\'] }))).toBe(
      '{ resource.service.name = "no\\"de\\\\" }',
    )
  })

  test('multiple services compile to anchored regex alternation', () => {
    expect(buildTraceQL(filter({ services: ['node-0', 'node-1'] }))).toBe(
      '{ resource.service.name =~ "^(node-0|node-1)$" }',
    )
  })

  test('multi-service alternation regex-escapes metacharacters', () => {
    expect(buildTraceQL(filter({ services: ['a.b*c', 'd|e'] }))).toBe(
      '{ resource.service.name =~ "^(a\\\\.b\\\\*c|d\\\\|e)$" }',
    )
  })

  test('multi-service alternation escapes backslashes through both layers', () => {
    // literal `a\b` → regex `a\\b` → quoted string `a\\\\b`
    expect(buildTraceQL(filter({ services: ['a\\b', 'c'] }))).toBe(
      '{ resource.service.name =~ "^(a\\\\\\\\b|c)$" }',
    )
  })

  test('more regex metachars: ^ $ ( ) [ ] { } + ?', () => {
    expect(buildTraceQL(filter({ services: ['^x$', '(y)[z]{1}+?'] }))).toBe(
      '{ resource.service.name =~ "^(\\\\^x\\\\$|\\\\(y\\\\)\\\\[z\\\\]\\\\{1\\\\}\\\\+\\\\?)$" }',
    )
  })

  test('empty service strings are dropped', () => {
    expect(buildTraceQL(filter({ services: ['', 'node-0', ''] }))).toBe(
      '{ resource.service.name = "node-0" }',
    )
  })

  // -------------------------------------------------------------------- name

  test('exact name match when nameIsRegex is false', () => {
    expect(buildTraceQL(filter({ name: 'verify.signature', nameIsRegex: false }))).toBe(
      '{ name = "verify.signature" }',
    )
  })

  test('exact name escapes embedded quotes', () => {
    expect(buildTraceQL(filter({ name: 'say "hi"', nameIsRegex: false }))).toBe(
      '{ name = "say \\"hi\\"" }',
    )
  })

  // Tempo >= 2.7 anchors `=~` patterns, so the compiler wraps the user
  // pattern in `.*(p).*` to keep substring semantics.
  test('regex name is wrapped for substring matching', () => {
    expect(buildTraceQL(filter({ name: 'commit', nameIsRegex: true }))).toBe(
      '{ name =~ ".*(commit).*" }',
    )
  })

  test('regex name is quote-escaped inside the wrapper', () => {
    // user regex `verify\..*` → quoted string `verify\\..*`
    expect(buildTraceQL(filter({ name: 'verify\\..*', nameIsRegex: true }))).toBe(
      '{ name =~ ".*(verify\\\\..*).*" }',
    )
  })

  test('explicitly anchored regex name still anchors inside the wrapper group', () => {
    expect(buildTraceQL(filter({ name: '^commit$', nameIsRegex: true }))).toBe(
      '{ name =~ ".*(^commit$).*" }',
    )
  })

  test('blank name emits no clause', () => {
    expect(buildTraceQL(filter({ name: '   ' }))).toBe('{}')
  })

  // ------------------------------------------------------------------ levels

  test('single level uses exact match', () => {
    expect(buildTraceQL(filter({ levels: ['warn'] }))).toBe('{ span.level = "warn" }')
  })

  test('multiple levels compile to anchored alternation', () => {
    expect(buildTraceQL(filter({ levels: ['warn', 'error'] }))).toBe(
      '{ span.level =~ "^(warn|error)$" }',
    )
  })

  // ------------------------------------------------------------- errors only

  test('errorsOnly adds status = error', () => {
    expect(buildTraceQL(filter({ errorsOnly: true }))).toBe('{ status = error }')
  })

  // --------------------------------------------------------------- durations

  // Durations are emitted as canonical integer nanoseconds, never the raw
  // user text — Tempo's lexer is stricter than parseDurationInput.
  test('min duration is emitted as canonical nanoseconds', () => {
    expect(buildTraceQL(filter({ minDuration: '150ms' }))).toBe('{ duration > 150000000ns }')
  })

  test('max duration is emitted as canonical nanoseconds', () => {
    expect(buildTraceQL(filter({ maxDuration: '2s' }))).toBe('{ duration < 2000000000ns }')
  })

  test('both duration bounds combine', () => {
    expect(buildTraceQL(filter({ minDuration: '150ms', maxDuration: '2s' }))).toBe(
      '{ duration > 150000000ns && duration < 2000000000ns }',
    )
  })

  test('fractional and padded duration input normalizes', () => {
    expect(buildTraceQL(filter({ minDuration: '  1.5s  ' }))).toBe('{ duration > 1500000000ns }')
  })

  test('uppercase units normalize instead of passing through', () => {
    expect(buildTraceQL(filter({ minDuration: '100MS' }))).toBe('{ duration > 100000000ns }')
  })

  test('internal whitespace normalizes instead of passing through', () => {
    expect(buildTraceQL(filter({ minDuration: '150 ms' }))).toBe('{ duration > 150000000ns }')
  })

  test('micro sign and Greek mu both normalize to nanoseconds', () => {
    expect(buildTraceQL(filter({ minDuration: '100µs' }))).toBe('{ duration > 100000ns }')
    expect(buildTraceQL(filter({ minDuration: '100μs' }))).toBe('{ duration > 100000ns }')
  })

  test('invalid durations are dropped', () => {
    expect(buildTraceQL(filter({ minDuration: 'fast', maxDuration: '10 parsecs' }))).toBe('{}')
  })

  // ------------------------------------------------------------------- attrs

  test('span attribute string equality is quoted', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', 'role', '=', 'leader')] }))).toBe(
      '{ span.role = "leader" }',
    )
  })

  test('resource attribute with != is prefixed and quoted', () => {
    expect(buildTraceQL(filter({ attrs: [attr('resource', 'node.region', '!=', 'us-east')] }))).toBe(
      '{ resource.node.region != "us-east" }',
    )
  })

  test('numeric value with comparison op is unquoted', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', 'height', '>', '100')] }))).toBe(
      '{ span.height > 100 }',
    )
  })

  // = and != with number/bool values match both storage types: attributes
  // emitted by the tracing crate may arrive as strings (u64 fields).
  test('numeric value with = matches int and string storage', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', 'delta', '=', '-1.25')] }))).toBe(
      '{ (span.delta = -1.25 || span.delta = "-1.25") }',
    )
  })

  test('numeric value with != matches int and string storage', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', 'height', '!=', '42')] }))).toBe(
      '{ (span.height != 42 || span.height != "42") }',
    )
  })

  test('boolean value with = matches bool and string storage', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', 'committed', '=', 'true')] }))).toBe(
      '{ (span.committed = true || span.committed = "true") }',
    )
  })

  test('>= and <= pass through', () => {
    const attrs = [attr('span', 'a', '>=', '1'), attr('span', 'b', '<=', '2')]
    expect(buildTraceQL(filter({ attrs }))).toBe('{ span.a >= 1 && span.b <= 2 }')
  })

  test('non-numeric value with comparison op stays quoted', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', 'x', '>', 'abc')] }))).toBe(
      '{ span.x > "abc" }',
    )
  })

  test('=~ quotes even numeric-looking values', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', 'height', '=~', '100')] }))).toBe(
      '{ span.height =~ "100" }',
    )
  })

  test('=~ value passes through as regex but is quote-escaped', () => {
    // user regex `\d+` → quoted string `\\d+`
    expect(buildTraceQL(filter({ attrs: [attr('span', 'height', '=~', '\\d+')] }))).toBe(
      '{ span.height =~ "\\\\d+" }',
    )
  })

  test('!~ quotes the value', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', 'role', '!~', 'lead.*')] }))).toBe(
      '{ span.role !~ "lead.*" }',
    )
  })

  test('attr values escape quotes and backslashes', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', 'msg', '=', 'say "hi"\\')] }))).toBe(
      '{ span.msg = "say \\"hi\\"\\\\" }',
    )
  })

  test('attrs with empty keys are skipped', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', '  ', '=', 'x')] }))).toBe('{}')
  })

  // Keys that are not plain identifiers use TraceQL quoted-attribute syntax.

  test('key with a space is quoted', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', 'attr name', '=', 'x')] }))).toBe(
      '{ span."attr name" = "x" }',
    )
  })

  test('quoted key escapes embedded quotes and backslashes', () => {
    expect(buildTraceQL(filter({ attrs: [attr('resource', 'my"key\\', '=', 'x')] }))).toBe(
      '{ resource."my\\"key\\\\" = "x" }',
    )
  })

  test('key with leading dash is quoted', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', '-flag', '=', 'x')] }))).toBe(
      '{ span."-flag" = "x" }',
    )
  })

  test('plain keys with dots, dashes, and underscores stay bare', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', 'http.status_code-2', '=', 'x')] }))).toBe(
      '{ span.http.status_code-2 = "x" }',
    )
  })

  test('quoted key combines with numeric int-or-string matching', () => {
    expect(buildTraceQL(filter({ attrs: [attr('span', 'my count', '=', '42')] }))).toBe(
      '{ (span."my count" = 42 || span."my count" = "42") }',
    )
  })

  // ------------------------------------------------------------ raw override

  test('rawQuery overrides everything verbatim', () => {
    const raw = '{ .custom = "yes" } | count() > 2'
    const f = filter({
      rawQuery: raw,
      services: ['node-0'],
      name: 'round',
      levels: ['error'],
      errorsOnly: true,
      minDuration: '1ms',
      attrs: [attr('span', 'k', '=', 'v')],
    })
    expect(buildTraceQL(f)).toBe(raw)
  })

  test('whitespace-only rawQuery is ignored', () => {
    expect(buildTraceQL(filter({ rawQuery: '   ', services: ['node-0'] }))).toBe(
      '{ resource.service.name = "node-0" }',
    )
  })

  // ------------------------------------------------------------- combination

  test('all clause types AND together in order', () => {
    const f = filter({
      services: ['node-0'],
      name: 'round',
      nameIsRegex: true,
      levels: ['info'],
      errorsOnly: true,
      minDuration: '1ms',
      maxDuration: '1s',
      attrs: [attr('span', 'height', '>', '10')],
    })
    expect(buildTraceQL(f)).toBe(
      '{ resource.service.name = "node-0" && name =~ ".*(round).*" && span.level = "info" && ' +
        'status = error && duration > 1000000ns && duration < 1000000000ns && span.height > 10 }',
    )
  })

  // ----------------------------------------------------------- events target

  test('events target matches event:name instead of span name', () => {
    expect(buildTraceQL(filter({ name: 'msg' }), 'events')).toBe(
      '{ event:name =~ ".*(msg).*" }',
    )
    expect(buildTraceQL(filter({ name: 'msg.sent', nameIsRegex: false }), 'events')).toBe(
      '{ event:name = "msg.sent" }',
    )
  })

  test('events target with no name still requires an event to exist', () => {
    expect(buildTraceQL(DEFAULT_FILTER, 'events')).toBe('{ event:name =~ ".+" }')
  })

  test('events target levels match event.level case-insensitively', () => {
    expect(buildTraceQL(filter({ levels: ['warn', 'error'] }), 'events')).toBe(
      '{ event:name =~ ".+" && event.level =~ "(?i)^(warn|error)$" }',
    )
  })

  test('event-scoped attributes are prefixed with event.', () => {
    expect(
      buildTraceQL(filter({ attrs: [attr('event', 'from.node', '=', '2')] }), 'events'),
    ).toBe('{ event:name =~ ".+" && (event.from.node = 2 || event.from.node = "2") }')
  })

  test('services and durations still apply for the events target', () => {
    expect(buildTraceQL(filter({ services: ['node-1'], minDuration: '1ms' }), 'events')).toBe(
      '{ resource.service.name = "node-1" && event:name =~ ".+" && duration > 1000000ns }',
    )
  })
})
