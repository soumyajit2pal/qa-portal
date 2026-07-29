import React, { useEffect, useRef, useState } from 'react'
import { IconSearch } from './Icons'
import { UserOut } from '../types'

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
  const rootRef = useRef<HTMLDivElement>(null)
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

  return (
    <div className="searchable-select" ref={rootRef} style={style}>
      <button
        type="button"
        className="searchable-select-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={selectedUser ? '' : 'muted'}>{selectedUser ? selectedUser.full_name : placeholder}</span>
        <span className="caret">&#9662;</span>
      </button>
      {open && (
        <div className="searchable-select-panel">
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
