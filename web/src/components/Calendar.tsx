/*
 * Calendar — a clean month grid for picking a single day. Controlled by a
 * selected Date; emits a midnight Date for the chosen day (the caller keeps
 * the time-of-day separately). Month navigation is local-only state.
 */

import { useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons'
import './Calendar.css'

export interface CalendarProps {
  /** Currently selected day (time component ignored for highlighting). */
  value: Date
  onSelect: (day: Date) => void
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

export default function Calendar({ value, onSelect }: CalendarProps) {
  // First-of-month currently shown; seeded from the selected day.
  const [view, setView] = useState(() => new Date(value.getFullYear(), value.getMonth(), 1))
  const today = new Date()

  const year = view.getFullYear()
  const month = view.getMonth()
  const startDow = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const cells: Array<number | null> = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  const step = (delta: number) => setView(new Date(year, month + delta, 1))

  return (
    <div className="cal">
      <div className="cal-head">
        <button
          type="button"
          className="btn btn-ghost btn-sm cal-nav"
          aria-label="previous month"
          onClick={() => step(-1)}
        >
          <FontAwesomeIcon icon={faChevronLeft} />
        </button>
        <span className="cal-title">
          {MONTHS[month]} {year}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm cal-nav"
          aria-label="next month"
          onClick={() => step(1)}
        >
          <FontAwesomeIcon icon={faChevronRight} />
        </button>
      </div>
      <div className="cal-grid cal-dow">
        {WEEKDAYS.map((w) => (
          <span key={w} className="cal-dow-cell">
            {w}
          </span>
        ))}
      </div>
      <div className="cal-grid">
        {cells.map((d, i) => {
          if (d === null) return <span key={`b${i}`} className="cal-cell cal-blank" />
          const day = new Date(year, month, d)
          const selected = sameDay(day, value)
          const isToday = sameDay(day, today)
          return (
            <button
              key={d}
              type="button"
              className={`cal-cell cal-day${selected ? ' selected' : ''}${
                isToday ? ' today' : ''
              }`}
              aria-pressed={selected}
              onClick={() => onSelect(day)}
            >
              {d}
            </button>
          )
        })}
      </div>
    </div>
  )
}
