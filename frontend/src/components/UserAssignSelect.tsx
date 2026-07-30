import React, { useEffect, useRef, useState } from 'react'
import { IconSearch } from './Icons'
import { UserOut } from '../types'
import { computePanelPos, PanelPos } from './panelPosition'

interface UserAssignSelectProps {
  value: string
  onChange: (value: string) => void
  users: UserOut[]
  placeholder: string
  disabled?: boolean
  style?: React.CSSProperties
}

// Searchable id-based user picker for "Assign Security Lead / QA Lead /
// Engineer" controls (SAST/DAST, Functional, Performance).
// Replaces a plain <select> for two reasons: first, that candidate list can
// get long with nothing to filter it; second -- and the one that actually
// prompted this -- a native <select>'s open-dropdown highlight renders the
// placeholder option ("Assign Security Lead...") with the exact same
// selected/checkmark treatment as a real choice, which reads as if someone
// had already been assigned when nothing has been picked yet. Reuses the
// same `.searchable-select*` chrome as the Department picker and
// Suppression's Request ID search so this looks like an existing pattern,
// not a bespoke one.
export default function UserAssignSelect({ value, onChange, users, placeholder, disabled, style }: UserAssignSelectProps) {
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

  // Same fix as components/SearchableSelect.tsx -- see that component's own
  // comment for the full reasoning. Without this, the position:fixed panel
  // (computed once in toggleOpen below) stays stranded at its original
  // on-screen spot when the page or an ancestor scroll container scrolls
  // while the panel is open, instead of following its trigger.
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

  const selectedUser = users.find((u) => String(u.id) === value)
  const q = query.trim().toLowerCase()
  const filtered = q
    ? users.filter((u) => u.full_name.toLowerCase().includes(q) || (u.department || '').toLowerCase().includes(q))
    : users

  function select(u: UserOut) {
    onChange(String(u.id))
    setOpen(false)
    setQuery('')
  }

  // Same fix as components/SearchableSelect.tsx -- see that component's own
  // comment for the full reasoning (a plain nested `position: absolute`
  // panel can get visually cut off by any ancestor with clipped overflow,
  // e.g. a table's own scroll wrapper or a tall modal body). Computes the
  // trigger's on-screen position at open-time and renders the panel with
  // `position: fixed` at those exact coordinates instead.
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
        <span className={selectedUser ? '' : 'muted'}>{selectedUser ? selectedUser.full_name : placeholder}</span>
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
              placeholder="Search by name or department..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="searchable-select-list">
            {filtered.length === 0 && <div className="searchable-select-empty">No matches</div>}
            {filtered.map((u) => (
              <div
                key={u.id}
                className={`searchable-select-option ${String(u.id) === value ? 'active' : ''}`}
                onClick={() => select(u)}
              >
                {u.full_name}
                {u.department && <span className="muted small" style={{ marginLeft: 6 }}>({u.department})</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
