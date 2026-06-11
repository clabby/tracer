/*
 * ExportModal — shows the structured JSON export of the displayed trace in a
 * read-only textarea with a copy button. Closes on ×, Escape, or clicking
 * the backdrop.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCheck, faCopy } from '@fortawesome/free-solid-svg-icons'
import type { TraceModel } from '../lib/model'
import { exportTrace } from '../lib/export'
import './ExportModal.css'

export interface ExportModalProps {
  model: TraceModel
  hiddenInstances: ReadonlySet<string>
  onClose: () => void
}

export default function ExportModal({
  model,
  hiddenInstances,
  onClose,
}: ExportModalProps) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const exported = useMemo(
    () => exportTrace(model, hiddenInstances),
    [model, hiddenInstances],
  )
  const json = useMemo(() => JSON.stringify(exported, null, 2), [exported])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = () => {
    void navigator.clipboard?.writeText(json).catch(() => {})
    setCopied(true)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1200)
  }

  const hiddenCount = model.instances.filter((i) => hiddenInstances.has(i.id)).length

  return (
    <div className="xm-backdrop" onClick={onClose}>
      <div
        className="panel xm"
        role="dialog"
        aria-label="trace export"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header xm-header">
          <span className="panel-title">trace export</span>
          <span className="faint xm-meta">
            {Object.keys(exported.services).length} services
            {hiddenCount > 0 && ` (${hiddenCount} hidden excluded)`} ·{' '}
            {(json.length / 1024).toFixed(1)} KiB
          </span>
          <button type="button" className={`btn btn-sm xm-copy${copied ? ' xm-copied' : ''}`} onClick={copy}>
            <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
            {copied ? 'copied' : 'copy'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="close export"
          >
            ×
          </button>
        </div>
        <textarea
          className="xm-text"
          readOnly
          value={json}
          spellCheck={false}
          onFocus={(e) => e.target.select()}
        />
      </div>
    </div>
  )
}
