/*
 * Health — server liveness plus Tempo reachability and detected API
 * generation. Returns HTTP 200 when Tempo is reachable, 503 otherwise (same
 * body shape), so status-code-only monitors see outages too.
 */

import type { HealthResponse } from '../src/lib/apischema'
import { json, type Deps } from './router'

const VERSION_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 5_000

let versionCache: { value: HealthResponse['tempo']['apiVersion']; at: number } | null = null

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return res.ok
  } catch {
    return false
  }
}

/** Detect whether Tempo speaks the v2 search API; cached for a minute. */
async function detectApiVersion(tempoUrl: string): Promise<HealthResponse['tempo']['apiVersion']> {
  if (versionCache !== null && Date.now() - versionCache.at < VERSION_TTL_MS) {
    return versionCache.value
  }
  let value: HealthResponse['tempo']['apiVersion'] = 'unknown'
  if (await probe(`${tempoUrl}/api/v2/search/tags?scope=span`)) value = 'v2'
  else if (await probe(`${tempoUrl}/api/search/tags`)) value = 'v1'
  versionCache = { value, at: Date.now() }
  return value
}

export async function handleHealth(
  _req: Request,
  _url: URL,
  _params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  const reachable = await deps.tempo.ping()
  const body: HealthResponse = {
    ok: true,
    tempo: {
      reachable,
      apiVersion: reachable ? await detectApiVersion(deps.config.tempoUrl) : 'unknown',
    },
  }
  return json(body, reachable ? 200 : 503)
}
