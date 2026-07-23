import React, { useEffect, useRef, useState } from 'react'
import { IconSearch } from './Icons'

// Single-select dropdown with an inline search box for filtering long,
// fixed option lists (e.g. Department). Reusable anywhere a plain
// <select> would otherwise need dozens of <option>s.
export default function SearchableSelect({ value, onChange, options, placeholder, disabled }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
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

  const filtered = options.filter((o) => o.toLowerCase().includes(query.toLowerCase()))

  function select(opt) {
    onChange(opt)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="searchable-select" ref={rootRef}>
      <button
        type="button"
        className="searchable-select-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={value ? '' : 'muted'}>{value || placeholder || 'Select...'}</span>
        <span className="caret">&#9662;</span>
      </button>
      {open && (
        <div className="searchable-select-panel">
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
