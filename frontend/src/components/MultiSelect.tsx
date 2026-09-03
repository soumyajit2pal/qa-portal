import React, { useEffect, useRef, useState } from 'react'
import { computePanelPos, PanelPos } from './panelPosition'
import ClearableSearchInput from './ClearableSearchInput'
import { IconSearch } from './Icons'

interface MultiSelectProps {
  value: string[]
  onChange: (value: string[]) => void
  options: string[]
  placeholder?: string
  itemName?: string
  searchPlaceholder?: string
  disabled?: boolean
  autoOpen?: boolean
  inline?: boolean
  style?: React.CSSProperties
}

// Shared checkbox multi-select. It uses the same fixed, viewport-aware panel
// and trigger styling as SearchableSelect/MultiUserAssignSelect, while keeping
// the Select all/Clear interaction used for compact organisational pickers.
export default function MultiSelect({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  itemName = 'item',
  searchPlaceholder = 'Search...',
  disabled,
  autoOpen = false,
  inline = false,
  style,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [panelPos, setPanelPos] = useState<PanelPos>({ top: 0, bottom: 'auto', left: 0, width: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function closeOnClickAway(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', closeOnClickAway)
    return () => document.removeEventListener('mousedown', closeOnClickAway)
  }, [])

  useEffect(() => {
    if (open || inline) inputRef.current?.focus()
  }, [open, inline])

  useEffect(() => {
    if (!autoOpen || disabled) return
    const frame = window.requestAnimationFrame(() => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect) setPanelPos(computePanelPos(rect, 260))
      setOpen(true)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [autoOpen, disabled])

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

  function toggleOpen() {
    if (disabled) return
    if (open) { setOpen(false); setQuery(''); return }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPanelPos(computePanelPos(rect, 260))
    setOpen(true)
  }

  function toggle(option: string) {
    onChange(value.includes(option)
      ? value.filter((selected) => selected !== option)
      : [...value, option])
  }

  const summary = value.length === 0
    ? placeholder
    : value.length === options.length
      ? `All ${itemName}s (${value.length})`
      : `${value.length} ${itemName}${value.length === 1 ? '' : 's'}`
  const normalizedQuery = query.trim().toLowerCase()
  const filteredOptions = normalizedQuery
    ? options.filter((option) => option.toLowerCase().includes(normalizedQuery))
    : options

  const panelContents = (
    <>
      <div className="searchable-select-search">
        <IconSearch width={13} height={13} />
        <ClearableSearchInput
          ref={inputRef}
          placeholder={searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery('')}
          clearLabel={`Clear ${itemName} search`}
        />
      </div>
      <div className="multi-select-actions">
        <button type="button" disabled={value.length === options.length} onClick={() => onChange([...options])}>Select all</button>
        <button type="button" disabled={value.length === 0} onClick={() => onChange([])}>Clear</button>
      </div>
      <div className="searchable-select-list">
        {filteredOptions.map((option) => (
          <label key={option} className={`searchable-select-option multi-user-option ${value.includes(option) ? 'active' : ''}`}>
            <input type="checkbox" checked={value.includes(option)} onChange={() => toggle(option)} />
            <span>{option}</span>
          </label>
        ))}
        {filteredOptions.length === 0 && (
          <div className="searchable-select-empty">{options.length === 0 ? 'No options available' : 'No matches'}</div>
        )}
      </div>
    </>
  )

  if (inline) {
    return <div className="multi-select-panel multi-select-inline">{panelContents}</div>
  }

  return (
    <div className="multi-user-select" ref={rootRef} style={style}>
      <button
        ref={triggerRef}
        type="button"
        className={`multi-user-select-trigger ${disabled ? 'disabled' : ''}`}
        disabled={disabled}
        onClick={toggleOpen}
        aria-expanded={open}
      >
        <span className={value.length ? '' : 'muted'}>{summary}</span>
        <span className="caret">&#9662;</span>
      </button>
      {open && (
        <div
          className="searchable-select-panel searchable-select-panel-fixed multi-select-panel"
          style={{ top: panelPos.top, bottom: panelPos.bottom, left: panelPos.left, width: panelPos.width }}
        >
          {panelContents}
        </div>
      )}
    </div>
  )
}
