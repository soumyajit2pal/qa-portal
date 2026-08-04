import React, { useEffect, useRef, useState } from 'react'
import { IconSearch } from './Icons'
import { computePanelPos, PanelPos } from './panelPosition'

export interface SearchableSelectOption {
  value: string
  label: string
}

interface SearchableSelectProps {
  value: string
  onChange: (value: string) => void
  // Either a flat list of strings (value and label are the same -- e.g.
  // Department) or {value, label} pairs for anything id-keyed (e.g. a
  // Test Project/Folder picker, where the option's real value is a numeric
  // id but the label shown/searched is its name) or that needs a sentinel
  // entry alongside real rows (e.g. "-- Top level --" / "No change" at
  // value ''/'unchanged', same as a plain <option value="..."> would be).
  options: string[] | SearchableSelectOption[]
  placeholder?: string
  disabled?: boolean
  // Passed through to the root wrapper -- e.g. a toolbar dropdown that
  // isn't already inside a width-constraining Field wrapper (native
  // <select>s in the same spot would otherwise just size to content too,
  // but this component's trigger is `width: 100%` of its own wrapper, which
  // has no intrinsic width of its own in a plain flex row).
  style?: React.CSSProperties
}

function normalize(options: string[] | SearchableSelectOption[]): SearchableSelectOption[] {
  return options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
}

// Single-select dropdown with an inline search box for filtering long,
// growing option lists (Application Name, Department, Test Project/Folder
// pickers, etc.) -- reusable anywhere a plain <select> would otherwise need
// dozens of <option>s that only get harder to scan as more get added.
// Deliberately NOT used for short, fixed-size enums (Priority, Risk,
// Status, Environment and the like) -- a search box adds a click with no
// payoff on a 3-6 option list; those stay plain <select>s.
export default function SearchableSelect({ value, onChange, options, placeholder, disabled, style }: SearchableSelectProps) {
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

  const opts = normalize(options)
  const current = opts.find((o) => o.value === value)
  const filtered = opts.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))

  function select(opt: SearchableSelectOption) {
    onChange(opt.value)
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
    <div className="searchable-select" ref={rootRef} style={style}>
      <button
        ref={triggerRef}
        type="button"
        className="searchable-select-trigger"
        disabled={disabled}
        onClick={toggleOpen}
      >
        <span className={current ? '' : 'muted'}>{current ? current.label : (placeholder || 'Select...')}</span>
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
                key={opt.value}
                className={`searchable-select-option ${opt.value === value ? 'active' : ''}`}
                onClick={() => select(opt)}
              >
                {opt.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
