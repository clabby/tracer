/*
 * Server configuration from the environment. TEMPO_URL is required — the
 * server refuses to start without it (the same fail-fast contract
 * entrypoint.sh enforced for Caddy).
 */

export interface ServerConfig {
  /** Listen port (PORT, default 8080). */
  port: number
  /** Normalized Tempo API base, e.g. `http://tempo:3200` (no trailing slash). */
  tempoUrl: string
  /** Directory of the built SPA, or null to serve the API only. */
  staticDir: string | null
}

/**
 * Accept the same TEMPO_URL forms the Caddy deployment did: a host:port
 * (assumed http, e.g. `tempo:3200`) or a full http(s) URL.
 */
export function normalizeTempoUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export function defaultStaticDir(): string {
  return `${import.meta.dir}/../dist`
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const rawTempo = env.TEMPO_URL
  if (rawTempo === undefined || rawTempo.trim() === '') {
    throw new Error(
      'TEMPO_URL is required — set it to the Tempo API endpoint, ' +
        'e.g. TEMPO_URL=tempo:3200 or TEMPO_URL=https://tempo.example.com',
    )
  }

  const port = Number(env.PORT ?? '8080')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer in 1-65535, got "${env.PORT}"`)
  }

  return {
    port,
    tempoUrl: normalizeTempoUrl(rawTempo),
    staticDir: env.STATIC_DIR ?? defaultStaticDir(),
  }
}

/**
 * Strip the Tempo endpoint from text destined for response bodies — error
 * excerpts must not leak the upstream address to API consumers.
 */
export function redactTempoUrl(message: string, tempoUrl: string): string {
  if (tempoUrl === '') return message
  return message.replaceAll(tempoUrl, '$TEMPO_URL')
}
