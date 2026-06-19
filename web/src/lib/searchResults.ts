import type { TraceSummary } from './model'

function nameSummary(names: string[]): string {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts.entries()].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(', ')
}

export function groupTraceSummaries(traces: readonly TraceSummary[]): TraceSummary | null {
  if (traces.length === 0) return null

  const services = new Set<string>()
  const spanIds = new Set<string>()
  const names: string[] = []
  let startUnixMs = Infinity
  let endUnixMs = 0
  let spanCount = 0

  for (const trace of traces) {
    startUnixMs = Math.min(startUnixMs, trace.startUnixMs)
    endUnixMs = Math.max(endUnixMs, trace.startUnixMs + trace.durationMs)
    spanCount += trace.spanCount
    for (const service of trace.services) services.add(service)
    for (const spanId of trace.matchedSpanIds) spanIds.add(spanId)
    names.push(...(trace.matchedSpanNames.length > 0 ? trace.matchedSpanNames : [trace.rootTraceName]))
  }

  return {
    traceId: 'compare',
    rootServiceName: '',
    rootTraceName: nameSummary(names.filter((name) => name !== '')),
    startUnixMs,
    durationMs: Math.max(0, endUnixMs - startUnixMs),
    spanCount,
    services: [...services].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    matchedSpanIds: [...spanIds],
    matchedSpanNames: [],
  }
}
