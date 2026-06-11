/*
 * RangePicker — the search panel's time-range control.
 *
 *  - A trigger showing the current range ("Last 1 hour" or an absolute span).
 *  - A menu of relative presets, each with a "now − N → now" hint.
 *  - A custom editor: From/To tabs, each a calendar day pick followed by an
 *    HH:MM:SS (24h) time input, committed with "Apply range".
 *
 * Inline (non-portal) so it never clips inside the sidebar; click-outside and
 * Escape close it.
 */

import { useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faClock,
} from '@fortawesome/free-solid-svg-icons'
import type { RangeSelection } from '../lib/model'
import { RANGE_PRESETS, formatDateTimeShort, rangeLabel } from '../lib/range'
import Calendar from './Calendar'
import './RangePicker.css'

export interface RangePickerProps {
  range: RangeSelection
  onChange: (r: RangeSelection) => void
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`)

interface Draft {
  from: number
  to: number
}

function initDraft(range: RangeSelection): Draft {
  const now = Date.now()
  if (range.kind === 'absolute') return { from: range.fromMs, to: range.toMs }
  return { from: now - range.seconds * 1000, to: now }
}

// ---- time-of-day field (one of hours / minutes / seconds) ----

interface TimeFieldProps {
  value: number
  max: number
  label: string
  onChange: (v: number) => void
}

function TimeField({ value, max, label, onChange }: TimeFieldProps) {
  return (
    <input
      className="input rp-time-input"
      inputMode="numeric"
      aria-label={label}
      value={pad2(value)}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(-2)
        onChange(digits === '' ? 0 : Math.min(parseInt(digits, 10), max))
      }}
      onFocus={(e) => e.target.select()}
    />
  )
}

// ---- calendar day + HH:MM:SS for one endpoint ----

interface DateTimePickerProps {
  valueMs: number
  onChange: (ms: number) => void
}

function DateTimePicker({ valueMs, onChange }: DateTimePickerProps) {
  const d = new Date(valueMs)
  const setTime = (h: number, m: number, s: number) => {
    const next = new Date(valueMs)
    next.setHours(h, m, s, 0)
    onChange(next.getTime())
  }
  return (
    <div className="rp-dt">
      <Calendar
        value={d}
        onSelect={(day) => {
          const next = new Date(day)
          next.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), 0)
          onChange(next.getTime())
        }}
      />
      <div className="rp-time">
        <span className="rp-time-label">time (24h)</span>
        <div className="rp-time-fields">
          <TimeField
            value={d.getHours()}
            max={23}
            label="hours"
            onChange={(h) => setTime(h, d.getMinutes(), d.getSeconds())}
          />
          <span className="rp-time-colon">:</span>
          <TimeField
            value={d.getMinutes()}
            max={59}
            label="minutes"
            onChange={(m) => setTime(d.getHours(), m, d.getSeconds())}
          />
          <span className="rp-time-colon">:</span>
          <TimeField
            value={d.getSeconds()}
            max={59}
            label="seconds"
            onChange={(s) => setTime(d.getHours(), d.getMinutes(), s)}
          />
        </div>
      </div>
    </div>
  )
}

export default function RangePicker({ range, onChange }: RangePickerProps) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'presets' | 'custom'>('presets')
  const [edge, setEdge] = useState<'from' | 'to'>('from')
  const [draft, setDraft] = useState<Draft>(() => initDraft(range))
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current
      if (root && e.target instanceof Node && !root.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const openMenu = () => {
    setMode('presets')
    setOpen(true)
  }
  const pickPreset = (seconds: number) => {
    onChange({ kind: 'relative', seconds })
    setOpen(false)
  }
  const startCustom = () => {
    setDraft(initDraft(range))
    setEdge('from')
    setMode('custom')
  }
  const applyCustom = () => {
    const fromMs = Math.min(draft.from, draft.to)
    const toMs = Math.max(draft.from, draft.to)
    onChange({ kind: 'absolute', fromMs, toMs })
    setOpen(false)
  }

  return (
    <div
      className="rp"
      ref={rootRef}
      onKeyDown={(e) => {
        if (!open) return
        if (e.key === 'Escape') {
          e.stopPropagation()
          setOpen(false)
        } else if (e.key === 'Enter' && mode === 'custom') {
          // Apply the draft instead of letting the panel's Enter→search fire.
          e.stopPropagation()
          e.preventDefault()
          applyCustom()
        }
      }}
    >
      <button
        type="button"
        className="input rp-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <FontAwesomeIcon icon={faClock} className="rp-icon" />
        <span className="rp-value">{rangeLabel(range)}</span>
        <FontAwesomeIcon icon={faChevronDown} className="rp-chevron" />
      </button>

      {open && (
        <div className="panel rp-menu">
          {mode === 'presets' ? (
            <>
              {RANGE_PRESETS.map((p) => {
                const active = range.kind === 'relative' && range.seconds === p.seconds
                return (
                  <button
                    key={p.seconds}
                    type="button"
                    className={`rp-preset${active ? ' active' : ''}`}
                    onClick={() => pickPreset(p.seconds)}
                  >
                    <span className="rp-preset-label">{p.label}</span>
                    <span className="rp-preset-hint mono-num">now − {p.short} → now</span>
                  </button>
                )
              })}
              <div className="rp-divider" />
              <button
                type="button"
                className={`rp-preset${range.kind === 'absolute' ? ' active' : ''}`}
                onClick={startCustom}
              >
                <span className="rp-preset-label">Custom range…</span>
                <FontAwesomeIcon icon={faChevronRight} className="rp-preset-arrow" />
              </button>
            </>
          ) : (
            <div className="rp-custom">
              <button
                type="button"
                className="btn btn-ghost btn-sm rp-back"
                onClick={() => setMode('presets')}
              >
                <FontAwesomeIcon icon={faChevronLeft} /> presets
              </button>
              <div className="rp-tabs">
                <button
                  type="button"
                  className={`rp-tab${edge === 'from' ? ' active' : ''}`}
                  onClick={() => setEdge('from')}
                >
                  <span className="rp-tab-label">from</span>
                  <span className="rp-tab-value mono-num">{formatDateTimeShort(draft.from)}</span>
                </button>
                <button
                  type="button"
                  className={`rp-tab${edge === 'to' ? ' active' : ''}`}
                  onClick={() => setEdge('to')}
                >
                  <span className="rp-tab-label">to</span>
                  <span className="rp-tab-value mono-num">{formatDateTimeShort(draft.to)}</span>
                </button>
              </div>
              <DateTimePicker
                valueMs={edge === 'from' ? draft.from : draft.to}
                onChange={(ms) => setDraft((d) => ({ ...d, [edge]: ms }))}
              />
              <button type="button" className="btn btn-primary rp-apply" onClick={applyCustom}>
                Apply range
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
