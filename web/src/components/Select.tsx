/*
 * Select — design-language dropdown replacing the native <select>.
 *
 * Button trigger styled like an .input, a panel-styled popover menu (matching
 * Combobox), keyboard navigation (ArrowUp/Down, Home/End, Enter/Space commit,
 * Escape closes), and click-outside dismissal. Portal-free; the menu is
 * positioned absolutely under the trigger.
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import './Select.css'

export interface SelectOption<T extends string | number> {
  value: T
  label: string
}

export interface SelectProps<T extends string | number> {
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onChange: (value: T) => void
  /** Accessible name for the trigger button. */
  label?: string
  className?: string
}

export default function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()

  const selectedIndex = options.findIndex((o) => o.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  function openMenu() {
    setHighlight(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }

  function close() {
    setOpen(false)
    setHighlight(-1)
  }

  function pick(i: number) {
    const opt = options[i]
    if (opt) onChange(opt.value)
    close()
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (!open) openMenu()
        else setHighlight((h) => (h < options.length - 1 ? h + 1 : 0))
        break
      case 'ArrowUp':
        e.preventDefault()
        if (!open) openMenu()
        else setHighlight((h) => (h <= 0 ? options.length - 1 : h - 1))
        break
      case 'Home':
        if (open) {
          e.preventDefault()
          setHighlight(0)
        }
        break
      case 'End':
        if (open) {
          e.preventDefault()
          setHighlight(options.length - 1)
        }
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (open && highlight >= 0) pick(highlight)
        else openMenu()
        break
      case 'Escape':
        if (open) {
          e.stopPropagation()
          close()
        }
        break
    }
  }

  // Close when clicking anywhere outside the component.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      const root = rootRef.current
      if (root && e.target instanceof Node && !root.contains(e.target)) close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div ref={rootRef} className={className ? `sel ${className}` : 'sel'}>
      <button
        type="button"
        className="input sel-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="sel-value">{selected ? selected.label : ''}</span>
        <FontAwesomeIcon icon={faChevronDown} className="sel-chevron" />
      </button>
      {open && (
        <ul
          className="panel sel-menu"
          role="listbox"
          id={menuId}
          // Keep the click on the option from blurring the trigger first.
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((opt, i) => (
            <li
              key={opt.value}
              ref={
                i === highlight
                  ? (el) => el?.scrollIntoView({ block: 'nearest' })
                  : undefined
              }
              role="option"
              aria-selected={opt.value === value}
              className={`sel-option${i === highlight ? ' active' : ''}${
                opt.value === value ? ' selected' : ''
              }`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => pick(i)}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
