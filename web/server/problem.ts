/*
 * RFC 9457 problem details — every non-2xx response from the API uses this
 * one shape, content-type `application/problem+json` (schema: `problemSchema`
 * in lib/apischema.ts). Helpers below cover the statuses the API emits.
 */

import type { ApiProblem } from '../src/lib/apischema'

export type InvalidParam = NonNullable<ApiProblem['invalidParams']>[number]

const HINT_INDEX = 'GET /api/v1 describes every route, parameter, and schema.'

export interface ProblemInit {
  status: number
  title: string
  detail: string
  hint?: string
  invalidParams?: InvalidParam[]
}

export function problem(init: ProblemInit): Response {
  const body: ApiProblem = {
    type: 'about:blank',
    title: init.title,
    status: init.status,
    detail: init.detail,
    ...(init.hint !== undefined ? { hint: init.hint } : {}),
    ...(init.invalidParams !== undefined ? { invalidParams: init.invalidParams } : {}),
  }
  return new Response(JSON.stringify(body, null, 2), {
    status: init.status,
    headers: { 'content-type': 'application/problem+json' },
  })
}

/** 400 with per-field failures; agents self-repair from `invalidParams`. */
export function badRequest(detail: string, invalidParams?: InvalidParam[]): Response {
  return problem({ status: 400, title: 'Bad Request', detail, hint: HINT_INDEX, invalidParams })
}

export function notFound(detail: string, hint: string = HINT_INDEX): Response {
  return problem({ status: 404, title: 'Not Found', detail, hint })
}

export function methodNotAllowed(method: string, path: string, allowed: string[]): Response {
  return problem({
    status: 405,
    title: 'Method Not Allowed',
    detail: `${method} is not supported on ${path}.`,
    hint: `Allowed: ${allowed.join(', ')}. ${HINT_INDEX}`,
  })
}

/** 502 — Tempo answered with an error (its message already redacted). */
export function badGateway(detail: string): Response {
  return problem({ status: 502, title: 'Tempo Request Failed', detail })
}

/** 504 — Tempo did not answer within the server's upstream budget. */
export function gatewayTimeout(detail: string): Response {
  return problem({ status: 504, title: 'Tempo Timed Out', detail })
}

export function internal(detail: string): Response {
  return problem({ status: 500, title: 'Internal Server Error', detail })
}
