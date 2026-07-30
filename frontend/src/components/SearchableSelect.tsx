import React, { useEffect, useRef, useState } from 'react'
import { IconSearch } from './Icons'
import { computePanelPos, PanelPos } from './panelPosition'

interface SearchableSelectProps {
  value: string
  onChange: (value: string) => void
  options: string[]
  placeholder?: string
  disabled?: boolean
}

// Single-select dropdown with an inline search box for filtering long,
// fixed option lists (e.g. Department). Reusable anywhere a plain
// <select> would otherwise need dozens of <option>s.
export default function SearchableSelect({ value, onChange, options, placeholder, disabled }: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [panelPos, setPanelPos] = useState<PanelPos>({ top: 0, bottom: 'auto', left: 0, width: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Reported bug: position:fixed (see toggleOpen below) is only computed
  // once, at the moment the panel opens -- so scrolling the page (or any
  // scrollable ancestor) afterward leaves the panel stranded at its
  // original on-screen spot while the trigger itself moves out from under
  // it, instead of following along. Recompute the same rect on every
  // scroll/resize while the panel is open so it stays glued to its trigger.
  // `{ capture: true }` on the scroll listener is required to catch
  // scrolling of a nested scrollable ancestor (e.g. `.table-wrap`) too --
  // scroll events don't bubble, but they do fire during the capture phase.
  useEffect(() => {
    if (!open) return
    function reposition() {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect) setPanelPos(computePanelPos(rect))
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  const filtered = options.filter((o) => o.toLowerCase().includes(query.toLowerCase()))

  function select(opt: string) {
    onChange(opt)
    setOpen(false)
    setQuery('')
  }

  // Reported bug: when this control sits inside a scroll container that
  // clips overflow (e.g. the Admin Users table's own `.table-wrap`, which is
  // `overflow-y: hidden` so its rounded corners stay crisp -- see
  // index.css), the panel's normal `position: absolute` (nested under this
  // trigger) got visually cut off at the container's own edge, hiding most
  // of the option list. Fixed the same way `.th-filter-popover` already
  // solves this identical problem for the table's own column-filter
  // popovers (see index.css's comment there): compute the trigger's own
  // on-screen position via getBoundingClientRect() at open-time and render
  // the panel with `position: fixed` at those exact coordinates instead --
  // that escapes every ancestor's overflow clipping entirely, regardless of
  // where this control is used.
  function toggleOpen() {
    if (open) { setOpen(false); return }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPanelPos(computePanelPos(rect))
    setOpen(true)
  }

  return (
    <div className="searchable-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="searchable-select-trigger"
        disabled={disabled}
        onClick={toggleOpen}
      >
        <span className={value ? '' : 'muted'}>{value || placeholder || 'Select...'}</span>
        <span className="caret">&#9662;</span>
      </button>
      {open && (
        <div
          className="searchable-select-panel searchable-select-panel-fixed"
          style={{ top: panelPos.top, bottom: panelPos.bottom, left: panelPos.left, width: panelPos.width }}
        >
          <div className="searchable-select-search">
            <IconSearch width={13} height={13} />
            <input
              ref={inputRef}
              placeholder="Search..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="searchable-select-list">
            {filtered.length === 0 && <div className="searchable-select-empty">No matches</div>}
            {filtered.map((opt) => (
              <div
                key={opt}
                className={`searchable-select-option ${opt === value ? 'active' : ''}`}
                onClick={() => select(opt)}
              >
                {opt}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
