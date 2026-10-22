import React, { useEffect, useId, useRef, useState } from 'react'
import { TestCycleFolderOut } from '../types'
import { cycleFolderIsRestricted, cycleFolderPathLabel } from '../cycleFolders'
import { IconFolder, IconLock, IconPlus } from './Icons'

export default function CycleFolderTree({ folders, selectedFolder, collapsed, onToggle, onSelect, cycles,
  canExecute, canDelete, projectIsActive, onAdd, onAccess, onRename, onDelete }: {
  folders: TestCycleFolderOut[]; selectedFolder: number | string; collapsed: number[]
  onToggle: (id: number) => void; onSelect: (id: number) => void; cycles: React.ReactNode
  canExecute: boolean; canDelete: boolean; projectIsActive: boolean
  onAdd: (folder: TestCycleFolderOut) => void; onAccess: (folder: TestCycleFolderOut) => void
  onRename: (folder: TestCycleFolderOut) => void; onDelete: (folder: TestCycleFolderOut) => void
}) {
  const [menu, setMenu] = useState<number | null>(null)
  const rootRef = useRef<HTMLUListElement>(null)
  const menuPrefix = useId()
  useEffect(() => {
    if (menu === null) return
    const controls = rootRef.current?.querySelector<HTMLElement>(`[data-folder-controls="${menu}"]`)
    controls?.querySelector<HTMLButtonElement>('.tm-cycle-folder-menu button')?.focus()
    function dismiss(event: MouseEvent) {
      if (!controls?.contains(event.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [menu])
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const children = new Map<number | null, TestCycleFolderOut[]>()
  for (const folder of folders) {
    const parent = folder.parent_id && byId.has(folder.parent_id) ? folder.parent_id : null
    children.set(parent, [...(children.get(parent) || []), folder])
  }
  function rows(parent: number | null, ancestors = new Set<number>()): React.ReactNode {
    return (children.get(parent) || []).filter(folder => !ancestors.has(folder.id)).map(folder => {
      const path = cycleFolderPathLabel(folders, folder)
      const hasContents = children.has(folder.id) || folder.cycle_count > 0 || selectedFolder === folder.id
      const expanded = !collapsed.includes(folder.id)
      const restricted = cycleFolderIsRestricted(folders, folder)
      return <li key={folder.id}>
        <div className="tm-folder-row">
          {hasContents ? <button type="button" className="tm-folder-toggle"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${path}`} aria-expanded={expanded}
            onClick={() => onToggle(folder.id)}>{expanded ? '▾' : '▸'}</button>
            : <span className="tm-folder-toggle tm-folder-toggle-leaf" aria-hidden="true">└</span>}
          <button type="button" className={`link-btn ${selectedFolder === folder.id ? 'active' : ''}`}
            aria-label={`Open folder ${path}`} aria-current={selectedFolder === folder.id ? 'true' : undefined}
            title={`${path} · ${folder.cycle_count} cycles in this folder${restricted ? ' · Access restricted' : ''}`}
            onClick={() => onSelect(folder.id)}>
            {restricted ? <IconLock className="restricted" aria-hidden="true" /> : <IconFolder aria-hidden="true" />}
            <span className="tm-cycle-link-label">{folder.name}</span><em>{folder.cycle_count}</em>
          </button>
          {canExecute && folder.workspace_writable && projectIsActive && <div className="tm-cycle-folder-controls" data-folder-controls={folder.id}>
            <button type="button" className="tm-folder-action" title="Add subfolder" aria-label={`Add subfolder to ${path}`} onClick={() => onAdd(folder)}><IconPlus aria-hidden="true" /></button>
            <button type="button" id={`${menuPrefix}-${folder.id}`} className="tm-folder-action" title="Folder actions" aria-label={`Folder actions for ${path}`}
              aria-expanded={menu === folder.id} aria-controls={menu === folder.id ? `${menuPrefix}-${folder.id}-actions` : undefined}
              onClick={() => setMenu(current => current === folder.id ? null : folder.id)}>⋯</button>
            {menu === folder.id && <div id={`${menuPrefix}-${folder.id}-actions`} className="tm-cycle-folder-menu" role="group" aria-label={`Actions for ${path}`}
              onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); document.getElementById(`${menuPrefix}-${folder.id}`)?.focus() } }}>
              <button type="button" aria-label={`Manage access for ${path}`} onClick={() => { setMenu(null); onAccess(folder) }}>Manage access</button>
              <button type="button" aria-label={`Rename ${path}`} onClick={() => { setMenu(null); onRename(folder) }}>Rename folder</button>
              {canDelete && <button type="button" className="danger" aria-label={`Delete ${path}`} onClick={() => { setMenu(null); onDelete(folder) }}>Delete folder</button>}
            </div>}
          </div>}
        </div>
        {expanded && selectedFolder === folder.id && cycles}
        {expanded && children.has(folder.id) && <ul className="plain-list tm-cycle-folder-children">
          {rows(folder.id, new Set([...ancestors, folder.id]))}
        </ul>}
      </li>
    })
  }
  return <ul ref={rootRef} className="plain-list tm-cycle-folder-list" aria-label="Test cycle folders">{rows(null)}</ul>
}
