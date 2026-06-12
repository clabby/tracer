import { describe, expect, test } from 'bun:test'
import { loadConfig, normalizeTempoUrl, redactTempoUrl } from './config'

describe('normalizeTempoUrl', () => {
  test('host:port gets an http scheme (the Caddy contract)', () => {
    expect(normalizeTempoUrl('tempo:3200')).toBe('http://tempo:3200')
  })

  test('full URLs pass through, trailing slashes stripped', () => {
    expect(normalizeTempoUrl('https://tempo.example.com/')).toBe('https://tempo.example.com')
    expect(normalizeTempoUrl('http://localhost:3200//')).toBe('http://localhost:3200')
  })
})

describe('loadConfig', () => {
  test('fails fast without TEMPO_URL', () => {
    expect(() => loadConfig({})).toThrow(/TEMPO_URL is required/)
    expect(() => loadConfig({ TEMPO_URL: '  ' })).toThrow(/TEMPO_URL is required/)
  })

  test('rejects junk ports', () => {
    expect(() => loadConfig({ TEMPO_URL: 'tempo:3200', PORT: 'nope' })).toThrow(/PORT/)
    expect(() => loadConfig({ TEMPO_URL: 'tempo:3200', PORT: '0' })).toThrow(/PORT/)
  })

  test('defaults: port 8080, normalized tempo url', () => {
    const c = loadConfig({ TEMPO_URL: 'tempo:3200' })
    expect(c.port).toBe(8080)
    expect(c.tempoUrl).toBe('http://tempo:3200')
    expect(c.staticDir).not.toBeNull()
  })
})

describe('redactTempoUrl', () => {
  test('strips every occurrence of the endpoint', () => {
    const msg = 'GET http://tempo:3200/api/search failed; retry http://tempo:3200/api/echo'
    expect(redactTempoUrl(msg, 'http://tempo:3200')).toBe(
      'GET $TEMPO_URL/api/search failed; retry $TEMPO_URL/api/echo',
    )
  })
})
