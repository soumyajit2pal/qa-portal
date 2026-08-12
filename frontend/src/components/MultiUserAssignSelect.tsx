import React, { useEffect, useRef, useState } from 'react'
import { IconSearch } from './Icons'
import { UserOut } from '../types'
import { computePanelPos, PanelPos } from './panelPosition'
import ClearableSearchInput from './ClearableSearchInput'
import { userDepartments } from '../constants'

interface MultiUserAssignSelectProps {
  value: string[]
  onChange: (value: string[]) => void
  users: UserOut[]
  placeholder: string
  disabled?: boolean
  style?: React.CSSProperties
}

// Multi-value sibling of UserAssignSelect.tsx -- same searchable-panel
// mechanics (fixed-position panel computed from the trigger's own
// getBoundingClientRect() at open time, click-away to close, flips upward
// near the bottom of the viewport -- see panelPosition.ts), but for
// "Assign Tester(s)", where more than one person can be picked. Replaces a
// bare native `<select multiple>` -- reported directly as "too much basic
// UI" -- which renders as a tall boring listbox with no search, no visual
// separation between selected/unselected, and a control-click-to-multi-select
// interaction most people don't know exists. This instead shows each
// selected tester as a removable chip in the trigger itself, and the
// dropdown panel below marks already-picked names with a check instead of
// hiding them, so adding/removing several people is just repeated clicks
// without the panel closing in between.

export default function MultiUserAssignSelect({ value, onChange, users, placeholder, disabled, style }: MultiUserAssignSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [panelPos, setPanelPos] = useState<PanelPos>({ top: 0, bottom: 'auto', left: 0, width: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
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

  // Same fix as UserAssignSelect/SearchableSelect -- keeps the position:fixed
  // panel following its trigger if the page/an ancestor scrolls while open.
  useEffect(() => {
    if (!open) return
    function reposition() {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect) setPanelPos(computePanelPos(rect, 260))
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  const selected = users.filter((u) => value.includes(String(u.id)))
  const q = query.trim().toLowerCase()
  const filtered = q
    ? users.filter((u) => u.full_name.toLowerCase().includes(q)
      || userDepartments(u).some((d) => d.toLowerCase().includes(q)))
    : users

  function toggle(u: UserOut) {
    const id = String(u.id)
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  }

  function remove(id: string) {
    onChange(value.filter((v) => v !== id))
  }

  function toggleOpen() {
    if (disabled) return
    if (open) { setOpen(false); return }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPanelPos(computePanelPos(rect, 260))
    setOpen(true)
  }

  return (
    <div className="multi-user-select" ref={rootRef} style={style}>
      <div
        ref={triggerRef}
        className={`multi-user-select-trigger ${disabled ? 'disabled' : ''}`}
        onClick={toggleOpen}
      >
        <div className="multi-user-select-chips">
          {selected.length === 0 && <span className="muted">{placeholder}</span>}
          {selected.map((u) => (
            <span key={u.id} className="multi-user-chip">
              {u.full_name}
              <button
                type="button"
                className="multi-user-chip-remove"
                disabled={disabled}
                onClick={(e) => { e.stopPropagation(); remove(String(u.id)) }}
                aria-label={`Remove ${u.full_name}`}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
        <span className="caret">&#9662;</span>
      </div>
      {open && (
        <div
          className="searchable-select-panel searchable-select-panel-fixed"
          style={{ top: panelPos.top, bottom: panelPos.bottom, left: panelPos.left, width: panelPos.width }}
        >
          <div className="searchable-select-search">
            <IconSearch width={13} height={13} />
            <ClearableSearchInput
              ref={inputRef}
              placeholder="Search by name or department..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery('')}
              clearLabel="Clear user search"
            />
          </div>
          <div className="searchable-select-list">
            {filtered.length === 0 && <div className="searchable-select-empty">No matches</div>}
            {filtered.map((u) => {
              const checked = value.includes(String(u.id))
              return (
                <div
                  key={u.id}
                  className={`searchable-select-option multi-user-option ${checked ? 'active' : ''}`}
                  onClick={() => toggle(u)}
                >
                  <span className={`multi-user-checkbox ${checked ? 'checked' : ''}`}>{checked && '✓'}</span>
                  {u.full_name}
                  {userDepartments(u).length > 0 && <span className="muted small" style={{ marginLeft: 6 }}>({userDepartments(u).join(', ')})</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
