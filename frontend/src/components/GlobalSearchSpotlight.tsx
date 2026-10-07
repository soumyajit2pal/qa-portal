import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ClearableSearchInput from './ClearableSearchInput'
import { IconSearch } from './Icons'
import { api } from '../api'
import { GlobalSearchSuggestion } from '../globalSearch'
import './GlobalSearchSpotlight.css'

interface GlobalSearchSpotlightProps {
  inputRef: React.RefObject<HTMLInputElement | null>
  value: string
  onChange: (value: string) => void
  onClear: () => void
  onSubmit: (event: React.FormEvent) => void
  onDismiss: () => void
  onSelect: (suggestion: GlobalSearchSuggestion) => void
}

export default function GlobalSearchSpotlight({ inputRef, value, onChange, onClear, onSubmit, onDismiss, onSelect }: GlobalSearchSpotlightProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const query = value.trim().slice(0, 120)
  const [result, setResult] = useState<{ query: string; items: GlobalSearchSuggestion[]; loading: boolean; error: boolean }>({ query: '', items: [], loading: false, error: false })
  const [activeIndex, setActiveIndex] = useState(-1)
  const suggestions = result.query === query ? result.items : []
  const loading = query.length >= 2 && (result.query !== query || result.loading)
  const failed = result.query === query && result.error

  useEffect(() => {
    setActiveIndex(-1)
    if (query.length < 2) {
      setResult({ query, items: [], loading: false, error: false })
      return
    }
    const controller = new AbortController()
    setResult({ query, items: [], loading: true, error: false })
    const timer = window.setTimeout(() => {
      api.searchSuggestions<GlobalSearchSuggestion[]>(query, controller.signal)
        .then(items => { if (!controller.signal.aborted) setResult({ query, items, loading: false, error: false }) })
        .catch(() => { if (!controller.signal.aborted) setResult({ query, items: [], loading: false, error: true }) })
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query])

  useEffect(() => {
    if (activeIndex >= 0) resultsRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // The native modal keeps background controls inert and contains keyboard
    // focus even when search is opened over an existing request drawer.
    dialog?.showModal()
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => {
      dialog?.close()
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [inputRef])

  return createPortal(
    <dialog
      ref={dialogRef}
      className="global-search-spotlight"
      role="dialog"
      aria-label="Global search"
      aria-describedby="global-search-help"
      aria-modal="true"
      onCancel={(event) => { event.preventDefault(); onDismiss() }}
      onClick={(event) => { if (event.target === event.currentTarget) onDismiss() }}
    >
      <div className="spotlight-panel">
        <form className="spotlight-search" role="search" aria-label="Search all requests" onSubmit={onSubmit}>
          <IconSearch aria-hidden="true" />
          <ClearableSearchInput
            ref={inputRef}
            aria-label="Global search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={query.length >= 2}
            aria-controls={query.length >= 2 ? 'global-search-suggestions' : undefined}
            aria-activedescendant={suggestions[activeIndex] ? `global-search-suggestion-${activeIndex}` : undefined}
            placeholder="Search all requests…"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onClear={() => { onClear(); inputRef.current?.focus() }}
            clearLabel="Clear global search"
            wrapperClassName="spotlight-input"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(event) => {
              if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault()
                setActiveIndex(index => index < 0 ? (event.key === 'ArrowDown' ? 0 : suggestions.length - 1)
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
              } else if (event.key === 'Enter' && suggestions[activeIndex]) {
                event.preventDefault()
                onSelect(suggestions[activeIndex])
              }
            }}
          />
          <button type="button" className="spotlight-dismiss" onClick={onDismiss} aria-label="Close global search" title="Close (Escape)">esc</button>
        </form>
        {query && <div className="spotlight-suggestions">
          <div className="spotlight-suggestions-heading"><span>Suggestions</span><span>↑ ↓ to choose · ↵ to open</span></div>
          {query.length < 2 ? <p className="spotlight-search-status" role="status">Type at least 2 characters to see matching records.</p>
            : loading ? <p className="spotlight-search-status" role="status">Searching your workspace…</p>
            : failed ? <p className="spotlight-search-status" role="status">Suggestions are unavailable. Press Enter to search.</p>
            : suggestions.length === 0 ? <p className="spotlight-search-status" role="status">No matching records you can access.</p> : null}
          {query.length >= 2 && <div ref={resultsRef} id="global-search-suggestions" className="spotlight-results" role="listbox" aria-label="Matching records" aria-busy={loading}>
            {suggestions.map((suggestion, index) => (
              <button key={`${suggestion.entity_type}:${suggestion.entity_id}`} id={`global-search-suggestion-${index}`} data-index={index}
                type="button" role="option" aria-selected={index === activeIndex} className="spotlight-result" tabIndex={-1}
                onMouseDown={event => event.preventDefault()} onClick={() => onSelect(suggestion)}>
                <span className="spotlight-result-copy"><strong>{suggestion.reference}</strong><span>{suggestion.title}</span>
                  <small>{suggestion.category}{suggestion.change_reference ? ` · ${suggestion.change_reference}` : ''}</small></span>
                {suggestion.status && <span className="spotlight-result-status">{suggestion.status.replace(/_/g, ' ')}</span>}
                <span className="spotlight-result-open" aria-hidden="true">↗</span>
              </button>
            ))}
          </div>}
          {query.length >= 2 && <button className="spotlight-search-all" type="button" onClick={event => onSubmit(event)}>Search for “{value.trim()}” <span aria-hidden="true">↵</span></button>}
        </div>}
        <div className="spotlight-help" id="global-search-help">
          <span>Search by record ID, application, CR / EPIC / IN number</span>
          <span className="spotlight-enter"><kbd>↵</kbd> Search</span>
        </div>
      </div>
    </dialog>,
    document.body,
  )
}
