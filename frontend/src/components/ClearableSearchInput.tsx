import React, { forwardRef, InputHTMLAttributes } from 'react'

interface ClearableSearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value'> {
  value: string
  onClear: () => void
  wrapperClassName?: string
  clearLabel?: string
}

// Shared search field used across page toolbars, searchable dropdowns, and
// request/user pickers. The explicit clear action is consistent across
// browsers (instead of relying on a browser-specific type=search control)
// and remains keyboard/screen-reader accessible.
const ClearableSearchInput = forwardRef<HTMLInputElement, ClearableSearchInputProps>(function ClearableSearchInput(
  { value, onClear, wrapperClassName = '', clearLabel = 'Clear search', className, ...inputProps },
  ref,
) {
  return (
    <span className={`clearable-search-input ${wrapperClassName}`.trim()}>
      <input ref={ref} type="search" value={value} className={className} {...inputProps} />
      {value && (
        <button type="button" className="clearable-search-button" onClick={onClear} aria-label={clearLabel} title={clearLabel}>
          ×
        </button>
      )}
    </span>
  )
})

export default ClearableSearchInput
