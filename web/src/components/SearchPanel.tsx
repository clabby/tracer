/*
 * SearchPanel — left sidebar of stacked filter sections driving a
 * FilterState. Every mutation flows through onChange({...filter, ...});
 * Enter in any input triggers onSearch (Cmd/Ctrl+Enter in the raw textarea).
 */

import { useMemo, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import type { AttrFilter, AttrOp, FilterState, Level, SearchPanelProps } from '../lib/model'
import { LEVELS, colorIndexForService, instanceColorVar } from '../lib/model'
import { clamp, isValidDurationInput, uid } from '../lib/format'
import { buildTraceQL } from '../lib/traceql'
import Combobox from './Combobox'
import RangePicker from './RangePicker'
import './SearchPanel.css'

const OPS: readonly AttrOp[] = ['=', '!=', '=~', '!~', '>', '<', '>=', '<=']

export default function SearchPanel({
  filter,
  onChange,
  target,
  range,
  onRangeChange,
  onSearch,
  onCompare,
  searching,
  client,
}: SearchPanelProps) {
  const [providerQuery, setProviderQuery] = useState('')
  const [editingRaw, setEditingRaw] = useState(false)

  const compiled = useMemo(() => buildTraceQL(filter, target), [filter, target])
  const rawActive = filter.rawQuery.trim() !== ''

  function set(patch: Partial<FilterState>) {
    onChange({ ...filter, ...patch })
  }

  // ------------------------------------------------------------- providers --

  function addService(v: string) {
    const s = v.trim()
    if (s && !filter.services.includes(s)) set({ services: [...filter.services, s] })
    setProviderQuery('')
  }

  function removeService(s: string) {
    set({ services: filter.services.filter((x) => x !== s) })
  }

  // ---------------------------------------------------------------- levels --

  function toggleLevel(level: Level) {
    set({
      levels: filter.levels.includes(level)
        ? filter.levels.filter((l) => l !== level)
        : [...filter.levels, level],
    })
  }

  // ------------------------------------------------------------ attributes --

  function addAttr() {
    set({ attrs: [...filter.attrs, { id: uid(), scope: 'span', key: '', op: '=', value: '' }] })
  }

  function updateAttr(id: string, patch: Partial<AttrFilter>) {
    set({ attrs: filter.attrs.map((a) => (a.id === id ? { ...a, ...patch } : a)) })
  }

  function removeAttr(id: string) {
    set({ attrs: filter.attrs.filter((a) => a.id !== id) })
  }

  // --------------------------------------------------------------- options --

  function onLimitChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.value === '') return
    const n = Number(e.target.value)
    if (Number.isFinite(n)) set({ limit: clamp(Math.round(n), 1, 1000) })
  }

  // ----------------------------------------------------------------- query --

  function toggleRawEditor() {
    setEditingRaw(!editingRaw)
  }

  function clearRaw() {
    set({ rawQuery: '' })
    setEditingRaw(false)
  }

  // ---------------------------------------------------------------- search --

  function onPanelKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Enter' || e.defaultPrevented) return
    const target = e.target
    if (target instanceof HTMLTextAreaElement) {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault()
        onSearch()
      }
      return
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) onSearch()
  }

  return (
    <div className="panel sp" onKeyDown={onPanelKeyDown}>
      <div className="sp-body">
        <section className="sp-section">
          <span className="label">time range</span>
          <RangePicker range={range} onChange={onRangeChange} />
        </section>

        <section className="sp-section">
          <span className="label">providers</span>
          <Combobox
            value={providerQuery}
            onChange={setProviderQuery}
            onCommit={addService}
            placeholder="service.name"
            fetchOptions={(q) =>
              client
                .tagValues('service.name', 'resource', q)
                .then((vs) => vs.filter((v) => !filter.services.includes(v)))
            }
          />
          {filter.services.length > 0 && (
            <div className="sp-chips">
              {filter.services.map((s) => (
                <span key={s} className="chip sp-service-chip">
                  <span
                    className="swatch"
                    style={{ background: instanceColorVar(colorIndexForService(s)) }}
                  />
                  {s}
                  <button
                    type="button"
                    className="sp-chip-x chip-x"
                    aria-label={`remove ${s}`}
                    onClick={() => removeService(s)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="sp-section">
          <span className="label">{target === 'events' ? 'event name' : 'span name'}</span>
          <div className="sp-row">
            <Combobox
              className="sp-grow"
              value={filter.name}
              onChange={(v) => set({ name: v })}
              placeholder={filter.nameIsRegex ? 'name regex' : 'name'}
              fetchOptions={(q) =>
                client.tagValues('name', target === 'events' ? 'event' : 'span', q)
              }
            />
            <button
              type="button"
              className={`chip sp-regex${filter.nameIsRegex ? ' active' : ''}`}
              title="treat name as a regex"
              aria-pressed={filter.nameIsRegex}
              onClick={() => set({ nameIsRegex: !filter.nameIsRegex })}
            >
              .*
            </button>
          </div>
        </section>

        <section className="sp-section">
          <span className="label">levels</span>
          <div className="sp-chips sp-levels">
            {LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                className={`chip sp-level-chip level-${level}${
                  filter.levels.includes(level) ? ' active' : ''
                }`}
                aria-pressed={filter.levels.includes(level)}
                onClick={() => toggleLevel(level)}
              >
                {level}
              </button>
            ))}
          </div>
        </section>

        <section className="sp-section">
          <span className="label">duration</span>
          <div className="sp-row">
            <input
              className="input sp-grow"
              value={filter.minDuration}
              placeholder="min (150ms)"
              spellCheck={false}
              aria-invalid={!isValidDurationInput(filter.minDuration) || undefined}
              onChange={(e) => set({ minDuration: e.target.value })}
            />
            <input
              className="input sp-grow"
              value={filter.maxDuration}
              placeholder="max (2s)"
              spellCheck={false}
              aria-invalid={!isValidDurationInput(filter.maxDuration) || undefined}
              onChange={(e) => set({ maxDuration: e.target.value })}
            />
          </div>
        </section>

        <section className="sp-section">
          <span className="label">attributes</span>
          {filter.attrs.length > 0 && (
            <div className="sp-attrs">
              {filter.attrs.map((a) => (
                <div key={a.id} className="sp-attr">
                  <select
                    className="input sp-select"
                    value={a.scope}
                    aria-label="attribute scope"
                    onChange={(e) =>
                      updateAttr(a.id, { scope: e.target.value as AttrFilter['scope'] })
                    }
                  >
                    <option value="span">span</option>
                    <option value="resource">resource</option>
                    <option value="event">event</option>
                  </select>
                  <Combobox
                    value={a.key}
                    onChange={(v) => updateAttr(a.id, { key: v })}
                    placeholder="key"
                    fetchOptions={(q) => client.tagNames(a.scope, q)}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm sp-attr-x"
                    aria-label="remove attribute"
                    onClick={() => removeAttr(a.id)}
                  >
                    ×
                  </button>
                  <select
                    className="input sp-select"
                    value={a.op}
                    aria-label="attribute operator"
                    onChange={(e) => updateAttr(a.id, { op: e.target.value as AttrOp })}
                  >
                    {OPS.map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </select>
                  <Combobox
                    value={a.value}
                    onChange={(v) => updateAttr(a.id, { value: v })}
                    placeholder="value"
                    fetchOptions={(q) =>
                      a.key ? client.tagValues(a.key, a.scope, q) : Promise.resolve([])
                    }
                  />
                  <span />
                </div>
              ))}
            </div>
          )}
          <button type="button" className="btn btn-ghost btn-sm sp-add-attr" onClick={addAttr}>
            + attribute
          </button>
        </section>

        <div className="sp-row sp-options">
          <label className="sp-limit">
            <span className="faint">limit</span>
            <input
              className="input sp-limit-input"
              type="number"
              min={1}
              max={1000}
              value={filter.limit}
              onChange={onLimitChange}
            />
          </label>
        </div>

        <section className="sp-section">
          <div className="sp-section-head">
            <span className="label">query</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={toggleRawEditor}>
              {editingRaw ? 'hide raw' : 'edit raw'}
            </button>
          </div>
          {editingRaw ? (
            // Display the live-compiled query until the user actually edits;
            // only then does rawQuery become the active override. Clearing the
            // textarea reverts to the compiled display.
            <textarea
              className="input sp-raw"
              value={rawActive ? filter.rawQuery : compiled}
              spellCheck={false}
              aria-label="raw TraceQL query"
              onChange={(e) => set({ rawQuery: e.target.value })}
            />
          ) : (
            <code className="sp-query">{compiled}</code>
          )}
          {rawActive && (
            <span className="chip sp-raw-warn">
              raw override active
              <button
                type="button"
                className="sp-chip-x chip-x"
                aria-label="clear raw query"
                onClick={clearRaw}
              >
                ×
              </button>
            </span>
          )}
        </section>
      </div>

      <div className="sp-footer">
        <button
          type="button"
          className="btn btn-primary sp-search"
          disabled={searching}
          onClick={onSearch}
        >
          {searching && <span className="spinner" aria-hidden="true" />}
          {searching ? 'searching…' : 'Search'}
        </button>
        <button
          type="button"
          className="btn btn-ghost sp-compare"
          disabled={filter.name.trim() === '' && filter.rawQuery.trim() === ''}
          title="assemble the matching span across every node into one comparison view"
          onClick={onCompare}
        >
          Compare
        </button>
      </div>
    </div>
  )
}
