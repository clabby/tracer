/*
 * Combobox — generic single-value suggestion input.
 *
 * Debounced (150ms) option fetch on focus + input, portal-free dropdown
 * positioned absolutely under the input, keyboard navigation (ArrowUp/Down,
 * Enter commits highlighted suggestion or free text, Escape closes),
 * click-outside closes, inline loading spinner, matched-substring highlight.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react'
import './Combobox.css'

export interface ComboboxProps {
  value: string
  onChange: (v: string) => void
  /** Called when the user picks a suggestion or presses Enter on free text. */
  onCommit?: (v: string) => void
  placeholder?: string
  fetchOptions: (q: string) => Promise<string[]>
  invalid?: boolean
  className?: string
}

const DEBOUNCE_MS = 150

function renderMatch(option: string, query: string): ReactNode {
  if (!query) return option
  const at = option.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return option
  return (
    <>
      {option.slice(0, at)}
      <span className="cb-match">{option.slice(at, at + query.length)}</span>
      {option.slice(at + query.length)}
    </>
  )
}

export default function Combobox({
  value,
  onChange,
  onCommit,
  placeholder,
  fetchOptions,
  invalid,
  className,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [highlight, setHighlight] = useState(-1)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const seqRef = useRef(0)
  // Always call the latest fetchOptions, even from a stale debounce closure.
  const fetchRef = useRef(fetchOptions)
  fetchRef.current = fetchOptions

  const query = value.trim()
  const visible = useMemo(() => {
    const q = query.toLowerCase()
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options
  }, [options, query])
  const active = highlight >= 0 && highlight < visible.length ? highlight : -1

  function scheduleFetch(q: string) {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const seq = ++seqRef.current
      setLoading(true)
      fetchRef.current(q.trim()).then(
        (opts) => {
          if (seq !== seqRef.current) return
          setLoading(false)
          setOptions([...new Set(opts)])
        },
        () => {
          if (seq !== seqRef.current) return
          setLoading(false)
          setOptions([])
        },
      )
    }, DEBOUNCE_MS)
  }

  function close() {
    setOpen(false)
    setHighlight(-1)
  }

  function pick(option: string) {
    onChange(option)
    onCommit?.(option)
    close()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        if (!open) {
          setOpen(true)
          scheduleFetch(value)
          break
        }
        if (visible.length > 0) setHighlight(active < visible.length - 1 ? active + 1 : 0)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        if (visible.length > 0) setHighlight(active <= 0 ? visible.length - 1 : active - 1)
        break
      }
      case 'Enter': {
        if (open && active >= 0) {
          // Consume the event so the parent's Enter→search handler skips it.
          e.preventDefault()
          e.stopPropagation()
          pick(visible[active])
        } else {
          close()
          onCommit?.(value)
        }
        break
      }
      case 'Escape': {
        if (open) {
          e.stopPropagation()
          close()
        }
        break
      }
    }
  }

  function onBlur(e: FocusEvent<HTMLInputElement>) {
    const next = e.relatedTarget
    if (rootRef.current && next instanceof Node && rootRef.current.contains(next)) return
    close()
  }

  // Close when clicking anywhere outside the component.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      const root = rootRef.current
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        setOpen(false)
        setHighlight(-1)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Cancel any in-flight debounce/fetch on unmount.
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      seqRef.current += 1
    },
    [],
  )

  const showMenu = open && visible.length > 0

  return (
    <div ref={rootRef} className={className ? `cb ${className}` : 'cb'}>
      <input
        className="input cb-input"
        role="combobox"
        aria-expanded={showMenu}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value)
          setHighlight(-1)
          setOpen(true)
          scheduleFetch(e.target.value)
        }}
        onFocus={() => {
          setOpen(true)
          scheduleFetch(value)
        }}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      {loading && <span className="spinner cb-spinner" aria-hidden="true" />}
      {showMenu && (
        <ul
          className="panel cb-menu"
          role="listbox"
          // Keep focus on the input so option clicks land before any blur.
          onMouseDown={(e) => e.preventDefault()}
        >
          {visible.map((option, i) => (
            <li
              key={option}
              ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'cb-option active' : 'cb-option'}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => pick(option)}
            >
              {renderMatch(option, query)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
