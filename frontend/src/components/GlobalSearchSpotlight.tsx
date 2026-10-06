import React, { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import ClearableSearchInput from './ClearableSearchInput'
import { IconSearch } from './Icons'
import './GlobalSearchSpotlight.css'

interface GlobalSearchSpotlightProps {
  inputRef: React.RefObject<HTMLInputElement | null>
  value: string
  onChange: (value: string) => void
  onClear: () => void
  onSubmit: (event: React.FormEvent) => void
  onDismiss: () => void
}

export default function GlobalSearchSpotlight({ inputRef, value, onChange, onClear, onSubmit, onDismiss }: GlobalSearchSpotlightProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

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
            placeholder="Search all requests…"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onClear={() => { onClear(); inputRef.current?.focus() }}
            clearLabel="Clear global search"
            wrapperClassName="spotlight-input"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="spotlight-dismiss" onClick={onDismiss} aria-label="Close global search" title="Close (Escape)">esc</button>
        </form>
        <div className="spotlight-help" id="global-search-help">
          <span>Search by request ID, application, CR or EPIC number</span>
          <span className="spotlight-enter"><kbd>↵</kbd> Search</span>
        </div>
      </div>
    </dialog>,
    document.body,
  )
}
