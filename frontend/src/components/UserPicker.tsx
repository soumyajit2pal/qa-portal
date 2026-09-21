import React, { useEffect, useRef, useState } from 'react'
import { isSelectableUser, ROLE_LABELS, userDepartments } from '../constants'
import ClearableSearchInput from './ClearableSearchInput'
import { IconSearch } from './Icons'
import { computePanelPos, PanelPos } from './panelPosition'
import { isKeyboardActivationKey } from '../keyboard'

const WORKSPACE_ACCESS_ROLES = new Set([
  'WORKSPACE_MEMBER', 'WORKSPACE_VIEWER', 'PARENT_WORKSPACE_VIEWER', 'PARENT_WORKSPACE_ADMIN',
])

export interface UserPickerProps {
  value: string | string[]
  onChange: (value: string | string[]) => void
  users: PickerUser[]
  placeholder: string
  multiple?: boolean
  disabled?: boolean
  style?: React.CSSProperties
  showRoles?: boolean
  searchPlaceholder?: string
  clearable?: boolean
  clearLabel?: string
}

export interface PickerUser {
  id: number
  username?: string
  full_name: string
  department?: string | null
  departments?: string[]
  roles?: string[]
  is_active?: boolean
  show_in_user_dropdowns?: boolean
}

export function userRoleLabels(user: PickerUser): string[] {
  return (user.roles || [])
    .filter((role) => !WORKSPACE_ACCESS_ROLES.has(role))
    .map((role) => ROLE_LABELS[role] || role)
}

function UserDetails({ user, showRoles }: { user: PickerUser; showRoles: boolean }) {
  const roles = userRoleLabels(user)
  const departments = userDepartments(user)
  if (!showRoles || !user.roles) {
    return departments.length > 0
      ? <small>({departments.join(', ')})</small>
      : null
  }
  return <small><strong>{roles.join(' · ') || 'No role assigned'}</strong>{departments.length > 0 && <> · {departments.join(', ')}</>}</small>
}

/**
 * Shared searchable user picker. Callers provide the already-authorized user
 * list; this component owns filtering, identity rendering, selection, and the
 * viewport-aware panel for both single and multi assignment.
 */
export default function UserPicker({
  value, onChange, users, placeholder, multiple = false, disabled, style,
  showRoles = true, searchPlaceholder, clearable = false, clearLabel = 'Unassigned',
}: UserPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [panelPos, setPanelPos] = useState<PanelPos>({ top: 0, bottom: 'auto', left: 0, width: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selectedIds = multiple
    ? new Set(Array.isArray(value) ? value : [])
    : new Set(typeof value === 'string' && value ? [value] : [])
  const candidates = users.filter(isSelectableUser)
  const selectedUsers = users.filter((user) => selectedIds.has(String(user.id)))
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = normalizedQuery
    ? candidates.filter((user) => user.full_name.toLowerCase().includes(normalizedQuery)
      || (user.username || '').toLowerCase().includes(normalizedQuery)
      || userDepartments(user).some((department) => department.toLowerCase().includes(normalizedQuery))
      || userRoleLabels(user).some((role) => role.toLowerCase().includes(normalizedQuery)))
    : candidates
  const showClearOption = !multiple && clearable
    && (!normalizedQuery || clearLabel.toLowerCase().includes(normalizedQuery))

  function close() { setOpen(false); setQuery('') }

  function reposition() {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPanelPos(computePanelPos(rect, multiple ? 260 : undefined))
  }

  function toggleOpen() {
    if (disabled) return
    if (open) { close(); return }
    reposition()
    setOpen(true)
  }

  function select(user: PickerUser) {
    const id = String(user.id)
    if (multiple) {
      const next = new Set(selectedIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      onChange([...next])
    } else {
      onChange(id)
      close()
    }
  }

  function remove(id: string) {
    onChange([...selectedIds].filter((selectedId) => selectedId !== id))
  }

  useEffect(() => {
    function closeOnClickAway(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close()
    }
    document.addEventListener('mousedown', closeOnClickAway)
    return () => document.removeEventListener('mousedown', closeOnClickAway)
  }, [])

  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  useEffect(() => {
    if (!open) return
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, multiple])

  const panel = open && <div className="searchable-select-panel searchable-select-panel-fixed" style={{ top: panelPos.top, bottom: panelPos.bottom, left: panelPos.left, width: panelPos.width }}>
    <div className="searchable-select-search">
      <IconSearch width={13} height={13} />
      <ClearableSearchInput ref={inputRef} placeholder={searchPlaceholder || 'Search users...'} value={query} onChange={(event) => setQuery(event.target.value)} onClear={() => setQuery('')} clearLabel="Clear user search" />
    </div>
    <div className="searchable-select-list" role="listbox" aria-label={placeholder} aria-multiselectable={multiple || undefined}>
      {showClearOption && (
        <div className={`searchable-select-option ${selectedIds.size === 0 ? 'active' : ''}`} role="option" aria-selected={selectedIds.size === 0} tabIndex={0} onClick={() => { onChange(''); close() }} onKeyDown={(event) => { if (isKeyboardActivationKey(event.key)) { event.preventDefault(); onChange(''); close() } }}>{clearLabel}</div>
      )}
      {filtered.length === 0 && !showClearOption && <div className="searchable-select-empty">{candidates.length ? 'No matching users' : 'No eligible users'}</div>}
      {filtered.map((user) => {
        const checked = selectedIds.has(String(user.id))
        return <div key={user.id} className={`searchable-select-option ${multiple ? 'multi-user-option' : 'user-assign-option'} ${checked ? 'active' : ''}`} role="option" aria-selected={checked} tabIndex={0} onClick={() => select(user)} onKeyDown={(event) => { if (isKeyboardActivationKey(event.key)) { event.preventDefault(); select(user) } }}>
          {multiple && <span className={`multi-user-checkbox ${checked ? 'checked' : ''}`}>{checked && '✓'}</span>}
          {multiple
            ? <div className="multi-user-identity"><span>{user.full_name}</span><UserDetails user={user} showRoles={showRoles} /></div>
            : <><span>{user.full_name}</span><UserDetails user={user} showRoles={showRoles} /></>}
        </div>
      })}
    </div>
  </div>

  if (multiple) {
    return <div className="multi-user-select" ref={rootRef} style={style}>
      <div ref={(element) => { triggerRef.current = element }} className={`multi-user-select-trigger ${disabled ? 'disabled' : ''}`} onClick={toggleOpen} role="button" aria-expanded={open} aria-disabled={disabled} tabIndex={disabled ? -1 : 0} onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleOpen() }
        if (event.key === 'Escape') close()
      }}>
        <div className="multi-user-select-chips">
          {selectedUsers.length === 0 && <span className="muted">{placeholder}</span>}
          {selectedUsers.map((user) => <span key={user.id} className="multi-user-chip">{user.full_name}<button type="button" className="multi-user-chip-remove" disabled={disabled} onClick={(event) => { event.stopPropagation(); remove(String(user.id)) }} aria-label={`Remove ${user.full_name}`}>×</button></span>)}
        </div>
        <span className="caret">&#9662;</span>
      </div>
      {panel}
    </div>
  }

  const selectedUser = selectedUsers[0]
  return <div className="searchable-select" ref={rootRef} style={style}>
    <button ref={(element) => { triggerRef.current = element }} type="button" className="searchable-select-trigger" disabled={disabled} aria-expanded={open} onClick={toggleOpen}>
      <span className={selectedUser ? 'user-assign-selected' : 'muted'}>
        <span>{selectedUser ? selectedUser.full_name : placeholder}</span>
        {selectedUser && showRoles && selectedUser.roles && <small>{userRoleLabels(selectedUser).join(' · ') || 'No role assigned'}</small>}
      </span>
      <span className="caret">&#9662;</span>
    </button>
    {panel}
  </div>
}
