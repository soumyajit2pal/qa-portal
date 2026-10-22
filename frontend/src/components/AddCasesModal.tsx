import { WorkSession, useWorkState, useWorkView } from './WorkViews'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, waitForJob } from '../api'
import { formatDateTimeIST } from '../time'
import { TEST_CASE_PRIORITIES } from '../constants'
import { UserOption } from '../types'
import { Table, Modal, Field, ErrorText } from './Common'
import UserAssignSelect from './UserAssignSelect'
import { IconFolder, IconGrid, IconInbox } from './Icons'
import { folderBreadcrumb, repositoryFolderRows, CandidateFolder } from '../cycleCandidateFolders'

interface Candidate {
  id: number; test_case_key: string; folder_id?: number | null; test_scenario?: string | null
  test_type?: string | null; priority?: string | null; module_name?: string | null; version: string
  created_at: string; created_by_id?: number | null; created_by_name?: string | null
}
interface CandidatePage {
  items: Candidate[]; total: number; next_cursor?: number | null; has_more: boolean
  already_added_count?: number; unavailable_ids?: number[]
}
interface FolderDirectory { project_name: string; folders: CandidateFolder[]; total: number; unfiled_count: number }
const EMPTY_PAGE: CandidatePage = { items: [], total: 0, has_more: false }

export default function AddCasesModal(props: React.ComponentProps<typeof AddCasesContent>) {
  return <WorkSession target={{ kind: 'add-cases', id: props.cycleId }}><AddCasesContent {...props} /></WorkSession>
}

function AddCasesContent({ cycleId, canAssign, requiresScopeChangeReason, runnerCandidates, onClose, onAdded }: {
  cycleId: number; canAssign: boolean; requiresScopeChangeReason: boolean; runnerCandidates: UserOption[]
  onClose: () => void; onAdded: (createdCount: number) => void
}) {
  const work = useWorkView()
  const pageSize = 25
  const [candidatePage, setCandidatePage] = useState<CandidatePage>(EMPTY_PAGE)
  const [candidateLoading, setCandidateLoading] = useState(true)
  const [loadedKey, setLoadedKey] = useState('')
  const [directory, setDirectory] = useState<FolderDirectory>({ project_name: '', folders: [], total: 0, unfiled_count: 0 })
  const [directoryLoading, setDirectoryLoading] = useState(true)
  const [directoryError, setDirectoryError] = useState<unknown>(null)
  const [directoryReload, setDirectoryReload] = useState(0)
  const [search, setSearch] = useWorkState('add.search', '')
  const [debouncedSearch, setDebouncedSearch] = useWorkState('add.debouncedSearch', '')
  const [priority, setPriority] = useWorkState('add.priority', '')
  const [createdById, setCreatedById] = useWorkState('add.createdById', '')
  const [authors, setAuthors] = useState<Array<{ id: number; name: string }>>([])
  const [sortOrder, setSortOrder] = useWorkState<'newest' | 'oldest'>('add.sortOrder', 'newest')
  const [folder, setFolder] = useWorkState<number | 'unfiled' | ''>('add.folder', '')
  const [includeSubfolders, setIncludeSubfolders] = useWorkState('add.includeSubfolders', true)
  const [collapsed, setCollapsed] = useWorkState<Set<number>>('add.collapsed', new Set())
  const [showFolders, setShowFolders] = useWorkState('add.showFolders', true)
  const [reviewSelected, setReviewSelected] = useWorkState('add.reviewSelected', false)
  const [selected, setSelected] = useWorkState<Set<number>>('add.selected', new Set())
  const [visibleCandidates, setVisibleCandidates] = useState<Candidate[]>([])
  const rememberVisible = useCallback((rows: Candidate[]) => setVisibleCandidates(previous => previous.length === rows.length && previous.every((row, index) => row.id === rows[index].id) ? previous : rows), [])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [assignedTo, setAssignedTo] = useWorkState('add.assignedTo', '')
  const [scopeChangeReason, setScopeChangeReason] = useWorkState('add.scopeChangeReason', '')
  const submittingRef = useRef(false)
  const bulkRef = useRef(false)
  const requestRef = useRef(0)
  const jobController = useRef<AbortController | null>(null)
  const selectedKey = reviewSelected ? JSON.stringify([...selected].sort((a, b) => a - b)) : ''
  const filterKey = JSON.stringify([cycleId, reviewSelected, selectedKey, reviewSelected ? '' : [folder, includeSubfolders, debouncedSearch, priority, createdById], sortOrder])
  const [pagination, setPagination] = useWorkState<{ key: string; cursors: Array<number | null> }>('add.pagination', { key: filterKey, cursors: [null] })
  const cursors = pagination.key === filterKey ? pagination.cursors : [null]
  const cursor = cursors[cursors.length - 1]
  const requestKey = JSON.stringify([filterKey, cursor])
  const loading = candidateLoading || loadedKey !== requestKey
  const locked = busy || selecting
  const searchPending = search.trim() !== debouncedSearch
  const setCursorStack = (update: (current: Array<number | null>) => Array<number | null>) => {
    setPagination(current => ({ key: filterKey, cursors: update(current.key === filterKey ? current.cursors : [null]) }))
  }
  useEffect(() => () => { jobController.current?.abort() }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])
  useEffect(() => {
    let active = true
    api.get<Array<{ id: number; name: string }>>(`/api/test-execution/cycles/${cycleId}/candidate-authors`)
      .then(rows => { if (active) setAuthors(rows) }).catch(err => { if (active) setError(err) })
    return () => { active = false }
  }, [cycleId])
  useEffect(() => {
    let active = true
    setDirectoryLoading(true); setDirectoryError(null)
    const qs = new URLSearchParams()
    if (debouncedSearch) qs.set('search', debouncedSearch)
    if (priority) qs.set('priority', priority)
    if (createdById) qs.set('created_by_id', createdById)
    api.getFresh<FolderDirectory>(`/api/test-execution/cycles/${cycleId}/candidate-folders?${qs}`)
      .then(value => { if (active) setDirectory(value) })
      .catch(err => { if (active) setDirectoryError(err) })
      .finally(() => { if (active) setDirectoryLoading(false) })
    return () => { active = false }
  }, [cycleId, debouncedSearch, priority, createdById, directoryReload])
  useEffect(() => {
    const requestId = ++requestRef.current
    setCandidateLoading(true)
    const qs = new URLSearchParams({ page_size: String(pageSize), sort_order: sortOrder })
    if (cursor != null) qs.set('cursor', String(cursor))
    if (folder !== '') qs.set('folder_id', String(folder))
    qs.set('include_subfolders', String(includeSubfolders))
    if (debouncedSearch) qs.set('search', debouncedSearch)
    if (priority) qs.set('priority', priority)
    if (createdById) qs.set('created_by_id', createdById)
    const request = reviewSelected
      ? api.post<CandidatePage>(`/api/test-execution/cycles/${cycleId}/candidate-review`, { test_case_ids: [...selected], cursor, page_size: pageSize, sort_order: sortOrder })
      : api.getFresh<CandidatePage>(`/api/test-execution/cycles/${cycleId}/candidate-test-cases?${qs}`)
    request.then(result => { if (requestId === requestRef.current) { setCandidatePage(result); setLoadedKey(requestKey); setError(null) } })
      .catch(err => { if (requestId === requestRef.current) { setError(err); setCandidatePage(EMPTY_PAGE); setLoadedKey(requestKey) } })
      .finally(() => { if (requestId === requestRef.current) setCandidateLoading(false) })
    return () => { if (requestId === requestRef.current) ++requestRef.current }
  }, [cycleId, folder, includeSubfolders, cursor, debouncedSearch, priority, createdById, sortOrder, reviewSelected, selectedKey, directoryReload])

  const candidates = candidatePage.items
  const allVisibleSelected = visibleCandidates.length > 0 && visibleCandidates.every(row => selected.has(row.id))
  const someVisibleSelected = visibleCandidates.some(row => selected.has(row.id))
  const folderRows = repositoryFolderRows(directory.folders, collapsed)
  const path = folderBreadcrumb(directory.folders, folder)
  function browse(value: number | 'unfiled' | '') { if (!locked) { setFolder(value); setReviewSelected(false) } }
  function toggle(id: number) {
    if (locked) return
    setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function toggleVisible() {
    if (locked) return
    setSelected(previous => { const next = new Set(previous); for (const row of visibleCandidates) { if (allVisibleSelected) next.delete(row.id); else next.add(row.id) } return next })
  }
  async function selectFolder() {
    if (bulkRef.current || locked || loading || searchPending) return
    bulkRef.current = true; setSelecting(true); setError(null)
    try {
      const ids = await api.post<number[]>(`/api/test-execution/cycles/${cycleId}/candidate-test-case-ids`, {
        folder_id: folder === '' ? null : String(folder), include_subfolders: includeSubfolders,
        search: debouncedSearch || null, priority: priority || null, created_by_id: createdById ? Number(createdById) : null,
      })
      setSelected(previous => new Set([...previous, ...ids]))
    } catch (err) { setError(err) } finally { bulkRef.current = false; setSelecting(false) }
  }
  async function submit() {
    if (submittingRef.current || bulkRef.current || selected.size === 0) return
    if (requiresScopeChangeReason && scopeChangeReason.trim().length < 10) { setError(new Error('Enter a scope expansion reason of at least 10 characters.')); return }
    submittingRef.current = true; setBusy(true); setError(null)
    try {
      let result = await api.post<{ created_count: number; skipped_count: number; job_id?: string | null; status?: string | null }>(`/api/test-execution/cycles/${cycleId}/executions/from-selection`, {
        selection_mode: 'ids', test_case_ids: [...selected], assigned_to_id: assignedTo ? Number(assignedTo) : null,
        reason: requiresScopeChangeReason ? scopeChangeReason.trim() : null,
      }, 180_000)
      if (result.job_id && result.status !== 'COMPLETED') {
        const controller = new AbortController(); jobController.current = controller
        const job = await waitForJob<{ created_count: number; skipped_count: number }>(result.job_id, { signal: controller.signal })
        result = { ...result, ...job.result, status: job.status }
      }
      work?.clear()
      onAdded(result.created_count)
    } catch (err) { if (!(err instanceof Error && err.name === 'AbortError')) setError(err) }
    finally { submittingRef.current = false; jobController.current = null; setBusy(false) }
  }
  const unavailable = candidatePage.unavailable_ids || []
  return <Modal title="Add Test Cases to Cycle" onClose={() => { if (!locked) onClose() }} closeDisabled={locked} workView wide className="tm-folder-add-dialog">
    <div className="tm-add-cases-modal" aria-busy={locked}>
      {busy && <div className="tm-add-cases-loading-overlay" role="status" aria-live="assertive"><div className="tm-add-cases-loading-card"><span className="tm-add-cases-loading-spinner" aria-hidden="true" /><strong>Adding {selected.size.toLocaleString()} testcases to this cycle</strong><span>Validating approved versions and creating execution records. Large selections may take a moment.</span><small>Please keep this window open.</small></div></div>}
      <div className="tm-add-cases-layout">
        <aside className="tm-add-folder-panel">
          <div className="tm-add-folder-heading"><div><small>{directory.project_name || 'Test Repository'}</small><strong>Repository folders</strong></div><button type="button" className="btn btn-sm" aria-expanded={showFolders} onClick={() => setShowFolders(value => !value)}>{showFolders ? 'Hide' : 'Show'}</button></div>
          {showFolders && <nav aria-label="Repository folders">
            {directoryLoading && <p className="tm-add-folder-note" role="status">Updating available counts…</p>}
            {!!directoryError && <div className="tm-add-folder-note" role="alert">Couldn’t load repository folders. <button type="button" className="link-btn" disabled={locked} onClick={() => setDirectoryReload(value => value + 1)}>Retry folders</button></div>}
            <ul className="tm-add-folder-list">
              <li><button type="button" className={folder === '' && !reviewSelected ? 'is-current' : ''} aria-current={folder === '' && !reviewSelected ? 'page' : undefined} disabled={locked} onClick={() => browse('')}><IconGrid aria-hidden="true" /><span>All available</span><em>{directoryLoading ? '…' : directory.total}</em></button></li>
              <li><button type="button" className={folder === 'unfiled' && !reviewSelected ? 'is-current' : ''} aria-current={folder === 'unfiled' && !reviewSelected ? 'page' : undefined} disabled={locked} onClick={() => browse('unfiled')}><IconInbox aria-hidden="true" /><span>Unfiled</span><em>{directoryLoading ? '…' : directory.unfiled_count}</em></button></li>
              {folderRows.map(({ folder: item, depth, hasChildren }) => <li key={item.id} style={{ paddingLeft: depth * 14 }}><div className="tm-add-folder-row">
                {hasChildren ? <button type="button" className="tm-add-folder-toggle" disabled={locked} aria-label={`${collapsed.has(item.id) ? 'Expand' : 'Collapse'} ${item.name}`} aria-expanded={!collapsed.has(item.id)} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })}>{collapsed.has(item.id) ? '▸' : '▾'}</button> : <span className="tm-add-folder-spacer" />}
                <button type="button" className={folder === item.id && !reviewSelected ? 'is-current' : ''} aria-current={folder === item.id && !reviewSelected ? 'page' : undefined} aria-label={`Open folder ${folderBreadcrumb(directory.folders, item.id).map(part => part.name).join(' / ')}`} disabled={locked} onClick={() => browse(item.id)}><IconFolder aria-hidden="true" /><span>{item.name}</span><em>{directoryLoading ? '…' : includeSubfolders ? item.available_count : item.direct_count}</em></button>
              </div></li>)}
            </ul>
            <p className="tm-add-folder-note">Counts show approved cases available to add, using the search and filters.</p>
          </nav>}
        </aside>
        <section className="tm-add-cases-main" aria-label="Available testcases">
          {requiresScopeChangeReason && <div className="info-banner"><strong>Execution has started.</strong><span>New cases start as Not Executed. Existing attempts and evidence are retained.</span><Field label="Scope expansion reason (required)"><textarea rows={2} maxLength={2000} value={scopeChangeReason} disabled={locked} onChange={event => setScopeChangeReason(event.target.value)} placeholder="Explain why these cases are being added after execution started" /></Field></div>}
          {canAssign && <div className="tm-add-cases-runner"><div><strong>Assign selected testcases</strong><span>Optional · applies to all selected cases</span></div><UserAssignSelect value={assignedTo} onChange={setAssignedTo} users={runnerCandidates} placeholder="Leave unassigned…" disabled={locked} /></div>}
          <div className="tm-add-cases-scope"><div><nav aria-label="Selected repository path">{reviewSelected ? 'Selected testcases · all folders' : <><button type="button" disabled={locked} onClick={() => browse('')}>Repository</button>{path.map(part => <React.Fragment key={part.id}><span aria-hidden="true"> / </span><button type="button" disabled={locked} onClick={() => browse(part.id)}>{part.name}</button></React.Fragment>)}</>}</nav><h3>{reviewSelected ? 'Review selected testcases' : folder === '' ? 'All available testcases' : path.at(-1)?.name || 'Selected folder'}</h3></div>
            {!reviewSelected && <label className="tm-add-subfolders"><input type="checkbox" checked={includeSubfolders} disabled={locked || typeof folder !== 'number'} onChange={event => setIncludeSubfolders(event.target.checked)} /> Include subfolders</label>}
          </div>
          {!reviewSelected && <div className="tm-add-cases-discovery">
            <Field label="Search testcases"><input type="search" aria-label="Search testcases" value={search} onChange={event => setSearch(event.target.value)} placeholder="ID, scenario, module or type…" disabled={locked} /></Field>
            <Field label="Priority"><select aria-label="Priority" value={priority} onChange={event => setPriority(event.target.value)} disabled={locked}><option value="">All priorities</option>{TEST_CASE_PRIORITIES.map(value => <option key={value}>{value}</option>)}</select></Field>
            <Field label="Created by"><select aria-label="Created by" value={createdById} onChange={event => setCreatedById(event.target.value)} disabled={locked}><option value="">All creators</option>{authors.map(author => <option key={author.id} value={author.id}>{author.name}</option>)}</select></Field>
          </div>}
          <div className="tm-add-cases-selection-bar"><div><strong>{loading || searchPending ? 'Loading testcases…' : `${candidatePage.total.toLocaleString()} ${reviewSelected ? 'selected cases available' : 'approved cases available'}`}</strong><span>{reviewSelected ? 'Selections from every folder are shown here.' : typeof folder === 'number' ? includeSubfolders ? 'This folder and all its subfolders' : 'This folder only' : folder === 'unfiled' ? 'Cases without a repository folder' : 'All folders and unfiled cases'}</span></div>
            {!reviewSelected && <button type="button" className="btn btn-sm" onClick={selectFolder} disabled={locked || loading || searchPending || candidatePage.total === 0}>{selecting ? 'Selecting…' : `${folder === '' ? 'Select all matching' : folder === 'unfiled' ? 'Select all unfiled' : 'Select all in folder'} (${loading ? '…' : candidatePage.total.toLocaleString()})`}</button>}
            <button type="button" className="btn btn-sm" disabled={locked} onClick={() => setDirectoryReload(value => value + 1)}>Refresh cases</button><label className="tm-add-sort">Sort <select aria-label="Sort testcases" value={sortOrder} onChange={event => setSortOrder(event.target.value as 'newest' | 'oldest')} disabled={locked}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
          </div>
          {reviewSelected && unavailable.length > 0 && <div className="info-banner" role="status"><strong>{unavailable.length} selected cases are no longer available.</strong><span>They may have been added to the cycle, archived, or moved.</span><button type="button" className="btn btn-sm" disabled={locked} onClick={() => setSelected(previous => new Set([...previous].filter(id => !unavailable.includes(id))))}>Remove unavailable cases</button></div>}
          {loading || searchPending ? <p className="tm-add-empty" role="status">Loading approved testcases…</p> : candidates.length === 0 ? <div className="tm-add-empty"><strong>{reviewSelected ? 'No selected testcases available' : candidatePage.already_added_count ? 'All approved testcases in this scope are already in the cycle.' : 'No approved testcases available in this scope.'}</strong><span>{reviewSelected ? 'Choose a repository folder to select more cases.' : 'Choose another folder, change the filters, or approve testcases in Test Repository.'}</span></div> :
            <Table<Candidate> tableId="folder-add-testcases-to-cycle" rowKey="id" rows={candidates} onRowClick={row => toggle(row.id)} onVisibleRowsChange={rememberVisible} defaultHiddenColumnKeys={['module_name', 'created_by_name', 'created_at']} columns={[
              { key: 'selection', header: <input type="checkbox" aria-label="Select all testcases on this page" ref={input => { if (input) input.indeterminate = someVisibleSelected && !allVisibleSelected }} checked={allVisibleSelected} disabled={locked} onChange={toggleVisible} onClick={event => event.stopPropagation()} />, render: row => <input type="checkbox" aria-label={`Select ${row.test_case_key}`} checked={selected.has(row.id)} disabled={locked} onChange={() => toggle(row.id)} onClick={event => event.stopPropagation()} /> },
              { key: 'test_case_key', header: 'Test Case ID' }, { key: 'test_scenario', header: 'Scenario', render: row => <>{row.test_scenario}{reviewSelected && <small className="tm-add-case-path">{folderBreadcrumb(directory.folders, row.folder_id ?? 'unfiled').map(part => part.name).join(' / ')}</small>}</> }, { key: 'test_type', header: 'Type' }, { key: 'priority', header: 'Priority' }, { key: 'version', header: 'Version' },
              { key: 'module_name', header: 'Module' }, { key: 'created_by_name', header: 'Created by' }, { key: 'created_at', header: 'Created date', render: row => formatDateTimeIST(row.created_at) },
            ].map(column => ({ ...column, filterable: false }))} server={{ page: cursors.length, pageSize, total: candidatePage.total, totalPages: Math.max(1, Math.ceil(candidatePage.total / pageSize)), hasNext: candidatePage.has_more, hasPrevious: cursors.length > 1, loading: loading || locked, onPageChange: page => { if (locked) return; if (page > cursors.length && candidatePage.next_cursor != null) setCursorStack(current => [...current, candidatePage.next_cursor!]); if (page < cursors.length) setCursorStack(current => current.slice(0, -1)) } }} />}
          <ErrorText error={error} />
        </section>
      </div>
      <footer className="tm-add-cases-footer"><div><strong role="status">{selected.size.toLocaleString()} selected</strong><small>Selections are kept across folders, filters and pages.</small></div><div className="tm-add-footer-actions"><button type="button" className="btn btn-sm" disabled={locked || (!reviewSelected && selected.size === 0)} onClick={() => setReviewSelected(value => !value)}>{reviewSelected ? 'Back to folders' : 'Review selected'}</button><button type="button" className="btn btn-sm" disabled={locked || selected.size === 0} onClick={() => { setSelected(new Set()); setReviewSelected(false) }}>Clear selection</button><button type="button" className="btn" disabled={locked} onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={locked || selected.size === 0 || (reviewSelected && unavailable.length > 0) || (requiresScopeChangeReason && scopeChangeReason.trim().length < 10)} onClick={submit}>{busy ? 'Adding…' : `Add ${selected.size.toLocaleString()} testcases`}</button></div></footer>
    </div>
  </Modal>
}
