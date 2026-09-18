import React, { useEffect, useId, useRef, useState } from 'react'
import type { WorkspaceAccessEntry } from '../constants'
import { IconFolder, IconSearch, IconCheckCircle } from './Icons'

const nameOf = (row: WorkspaceAccessEntry) => row.workspace_name || row.workspace_key || `Workspace ${row.workspace_id}`

export default function WorkspaceSwitcher({ options, value, onChange, disabled }: {
  options: WorkspaceAccessEntry[]
  value: number
  onChange: (id: number) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const panelId = useId()
  const rows = [...new Map(options.map(row => [row.workspace_id, row])).values()]
  const byId = new Map(rows.map(row => [row.workspace_id, row]))
  const selected = byId.get(value)

  function ancestors(row: WorkspaceAccessEntry) {
    const result: WorkspaceAccessEntry[] = []
    const seen = new Set([row.workspace_id])
    let parent = byId.get(row.parent_workspace_id || 0)
    while (parent && !seen.has(parent.workspace_id)) {
      result.unshift(parent)
      seen.add(parent.workspace_id)
      parent = byId.get(parent.parent_workspace_id || 0)
    }
    return result
  }
  function pathOf(row: WorkspaceAccessEntry) {
    const parents = ancestors(row).map(nameOf)
    if (!parents.length && row.parent_workspace_name) parents.push(row.parent_workspace_name)
    return [...parents, nameOf(row)].join(' / ')
  }
  const term = query.trim().toLowerCase()
  const matches = new Set(rows.filter(row => `${pathOf(row)} ${row.workspace_key || ''}`.toLowerCase().includes(term)).map(row => row.workspace_id))
  const visible = new Set(matches)
  if (term) rows.filter(row => matches.has(row.workspace_id)).forEach(row => ancestors(row).forEach(parent => visible.add(parent.workspace_id)))
  const roots = rows.filter(row => !byId.has(row.parent_workspace_id || 0))
  // Recover malformed cycles as roots so no accessible workspace disappears.
  const reachable = new Set<number>()
  function visit(row: WorkspaceAccessEntry) {
    if (reachable.has(row.workspace_id)) return
    reachable.add(row.workspace_id)
    rows.filter(child => child.parent_workspace_id === row.workspace_id).forEach(visit)
  }
  roots.forEach(visit)
  rows.forEach(row => { if (!reachable.has(row.workspace_id)) { roots.push(row); visit(row) } })

  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  function toggle() {
    if (!open) {
      setQuery('')
      setExpanded(new Set(selected ? ancestors(selected).map(row => row.workspace_id) : []))
    }
    setOpen(!open)
  }
  function renderBranch(row: WorkspaceAccessEntry, lineage: number[] = []): React.ReactNode {
    if (lineage.includes(row.workspace_id) || (term && !visible.has(row.workspace_id))) return null
    const children = rows.filter(child => child.parent_workspace_id === row.workspace_id && ![...lineage, row.workspace_id].includes(child.workspace_id))
    const isExpanded = !!term || expanded.has(row.workspace_id)
    const active = row.workspace_id === value
    return <li key={row.workspace_id}>
      <div className={`workspace-tree-row${active ? ' is-current' : ''}`}>
        {children.length ? <button type="button" className="workspace-branch-toggle" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${nameOf(row)}`} aria-expanded={isExpanded} onClick={() => setExpanded(previous => {
          const next = new Set(previous)
          next.has(row.workspace_id) ? next.delete(row.workspace_id) : next.add(row.workspace_id)
          return next
        })}>{isExpanded ? '⌄' : '›'}</button> : <span className="workspace-branch-spacer" />}
        <button type="button" className="workspace-tree-choice" aria-current={active ? 'true' : undefined} disabled={disabled} title={pathOf(row)} onClick={() => {
          setOpen(false)
          trigger.current?.focus()
          if (!active) onChange(row.workspace_id)
        }}>
          <IconFolder width={16} height={16} aria-hidden="true" />
          <span className="workspace-tree-name">{nameOf(row)}{!lineage.length && row.parent_workspace_name && !byId.has(row.parent_workspace_id || 0) && <small>{row.parent_workspace_name}</small>}</span>
          {active ? <span className="workspace-current-mark"><IconCheckCircle width={15} height={15} /> <span>Current</span></span> : children.length > 0 && <span className="workspace-child-count">{children.length}</span>}
        </button>
      </div>
      {children.length > 0 && isExpanded && <ul>{children.map(child => renderBranch(child, [...lineage, row.workspace_id]))}</ul>}
    </li>
  }

  return <div className="workspace-picker" ref={container} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false)
  }} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() }
  }}>
    <button type="button" ref={trigger} className="workspace-picker-trigger" aria-expanded={open} aria-controls={panelId} disabled={disabled} onClick={toggle} title={selected ? pathOf(selected) : 'Choose workspace'}>
      <IconFolder width={18} height={18} aria-hidden="true" />
      <span><small>{disabled ? 'Switching workspace…' : 'Workspace'}</small><strong>{selected ? nameOf(selected) : 'Choose workspace'}</strong></span>
      <span aria-hidden="true">⌄</span>
    </button>
    {open && <section id={panelId} className="workspace-picker-panel" aria-label="Choose workspace">
      <header><div><strong>Switch workspace</strong><p>Browse teams and their workspaces</p></div><span>{rows.length}</span></header>
      <div className="workspace-picker-search"><IconSearch width={16} height={16} aria-hidden="true" /><input ref={search} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search workspaces…" aria-label="Search workspaces" />{query && <button type="button" aria-label="Clear workspace search" onClick={() => { setQuery(''); search.current?.focus() }}>×</button>}</div>
      <div className="workspace-tree-scroll">
        {matches.size ? <ul className="workspace-tree" aria-label="Workspace hierarchy">{roots.map(row => renderBranch(row))}</ul> : <p className="workspace-picker-empty" role="status">No workspaces match “{query}”.</p>}
      </div>
      <footer>{selected ? <><span>Current location</span><strong title={pathOf(selected)}>{pathOf(selected)}</strong></> : 'Select a workspace to continue'}</footer>
    </section>}
  </div>
}
