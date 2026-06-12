/*
 * Tag suggestion handlers — discover the attribute space before building
 * filters. Thin delegation to the shared TempoClient (which handles the
 * Tempo v2 → v1 fallback and dedup/sort/substring-filter).
 */

import type { TagScope } from '../src/lib/model'
import type { TagNamesResponse, TagValuesResponse } from '../src/lib/apischema'
import { badRequest } from './problem'
import { json, type Deps } from './router'

const SCOPES: readonly TagScope[] = ['span', 'resource', 'event']

function parseScope(raw: string): TagScope {
  if ((SCOPES as readonly string[]).includes(raw)) return raw as TagScope
  throw badRequest('Unknown tag scope.', [
    { name: 'scope', reason: `expected one of ${SCOPES.join(', ')}; got "${raw}"`, example: 'resource' },
  ])
}

export async function handleTagNames(
  _req: Request,
  url: URL,
  params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  const scope = parseScope(params.scope)
  const q = url.searchParams.get('q') ?? undefined
  const body: TagNamesResponse = { scope, names: await deps.tempo.tagNames(scope, q) }
  return json(body)
}

export async function handleTagValues(
  _req: Request,
  url: URL,
  params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  const scope = parseScope(params.scope)
  const q = url.searchParams.get('q') ?? undefined
  const body: TagValuesResponse = {
    tag: params.tag,
    scope,
    values: await deps.tempo.tagValues(params.tag, scope, q),
  }
  return json(body)
}
