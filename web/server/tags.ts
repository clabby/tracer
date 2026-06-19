/*
 * Tag suggestion handlers — discover the attribute space before building
 * filters. Thin delegation to the shared TempoClient (which handles the
 * Tempo v2 → v1 fallback and dedup/sort/substring-filter).
 */

import type { SearchTarget, TagNameContext, TagScope } from '../src/lib/model'
import type { TagNamesResponse, TagValuesResponse } from '../src/lib/apischema'
import { badRequest } from './problem'
import { json, type Deps } from './router'

const SCOPES: readonly TagScope[] = ['span', 'resource', 'event']
const TARGETS: readonly SearchTarget[] = ['spans', 'events']

function parseScope(raw: string): TagScope {
  if ((SCOPES as readonly string[]).includes(raw)) return raw as TagScope
  throw badRequest('Unknown tag scope.', [
    { name: 'scope', reason: `expected one of ${SCOPES.join(', ')}; got "${raw}"`, example: 'resource' },
  ])
}

function parseBool(raw: string | null, name: string): boolean {
  if (raw === null || raw === 'true') return true
  if (raw === 'false') return false
  throw badRequest('Invalid tag context.', [
    { name, reason: `expected "true" or "false", got "${raw}"`, example: 'true' },
  ])
}

function parseTarget(raw: string | null): SearchTarget {
  if (raw === null) return 'spans'
  if ((TARGETS as readonly string[]).includes(raw)) return raw as SearchTarget
  throw badRequest('Invalid tag context.', [
    { name: 'target', reason: `expected one of ${TARGETS.join(', ')}; got "${raw}"`, example: 'spans' },
  ])
}

/** Optional name scope (`?name=…&nameRegex=…&target=…`) for tag-name discovery. */
function parseNameContext(url: URL): TagNameContext | undefined {
  const name = url.searchParams.get('name') ?? ''
  if (name.trim() === '') return undefined
  return {
    target: parseTarget(url.searchParams.get('target')),
    name,
    nameIsRegex: parseBool(url.searchParams.get('nameRegex'), 'nameRegex'),
  }
}

export async function handleTagNames(
  _req: Request,
  url: URL,
  params: Record<string, string>,
  deps: Deps,
): Promise<Response> {
  const scope = parseScope(params.scope)
  const q = url.searchParams.get('q') ?? undefined
  const body: TagNamesResponse = { scope, names: await deps.tempo.tagNames(scope, q, parseNameContext(url)) }
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
