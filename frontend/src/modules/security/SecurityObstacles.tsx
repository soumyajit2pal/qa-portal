import React, { useState } from 'react'
import { api } from '../../api'
import { ErrorText, Field, Modal } from '../../components/Common'
import UserAssignSelect from '../../components/UserAssignSelect'
import SastRepositoryDetails, { SAST_COMPONENT_FIELDS, type SastRepositoryRow } from '../../components/SastRepositoryDetails'
import { initialCorrectionRows, sastCorrectionPayload, sastCorrectionError } from './sastCorrection'
import { formatDateTimeIST } from '../../time'
import { SAST_DAST_STATUS_LABELS, POST_SIT_ENVIRONMENTS } from '../../constants'
import type { DASTOut, SASTOut, SecurityObstacleOut, UserOption } from '../../types'

export const OBSTACLE_ACTIVE_STAGES = ['PLANNING', 'CONFIGURATION', 'SCANNING', 'FINDING_VALIDATION', 'REMEDIATION', 'ASSIGNED_TO_REQUESTER', 'WAITING_FOR_FIX', 'ASSIGNED_TO_LEAD', 'RESCAN']

type Request = SASTOut | DASTOut
type Scope = { id: number; label: string; values: Record<string, string> }
const SAST_INPUTS = Object.fromEntries(SAST_COMPONENT_FIELDS.map(field => [field.key, field.label]))
const DAST_INPUTS = { application_url: 'Application URL', environment: 'Environment', authentication_required: 'Authentication required', commit_id: 'Deployed code / artifact hash' }

export function isStaleObstacleError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  return ('code' in error && error.code === 'STALE_SECURITY_OBSTACLE') || ('status' in error && error.status === 408)
}

export function obstaclePermissions(row: SecurityObstacleOut, userId: number | undefined, inputOwnerId: number | null | undefined, canReview: boolean, canApprove: boolean) {
  return {
    submit: userId !== undefined && row.status === 'OPEN' && userId === (row.kind === 'REQUESTER' ? inputOwnerId : row.owner_id),
    review: userId !== undefined && row.status === 'QA_REVIEW_PENDING' && canReview && userId !== row.submitted_by_id,
    approve: userId !== undefined && row.status === 'SCOPE_APPROVAL_PENDING' && canApprove && userId !== row.submitted_by_id,
  }
}

export function correctionPayload(scope: Scope[], drafts: Record<number, Record<string, string>>, selected: number[], credentialUpdates: number[]) {
  return scope.filter(target => selected.includes(target.id)).flatMap(target => {
    const changes = Object.fromEntries(Object.entries(drafts[target.id] || {}).filter(([field, value]) => field === 'test_credentials' ? credentialUpdates.includes(target.id) : value !== (target.values[field] || '')))
    return Object.keys(changes).length ? [{ target_id: target.id, ...changes }] : []
  })
}

export default function SecurityObstacles({ kind, req, userId, canManage, inputOwnerId, canApprove, ownerOptions, users, onChanged }: {
  kind: 'SAST' | 'DAST'; req: Request; userId?: number; canManage: boolean; inputOwnerId?: number | null; canApprove: boolean;
  ownerOptions: UserOption[]; users: UserOption[]; onChanged: (updated: Request) => Promise<void>
}) {
  const [dialog, setDialog] = useState<{ mode: 'REQUESTER' | 'INTERNAL' | 'submit' | 'review' | 'approve' | 'permission' | 'route'; row?: SecurityObstacleOut } | null>(null)
  const rows = req.obstacles || []
  const activeRow = dialog?.row ? rows.find(row => row.id === dialog.row!.id) || dialog.row : undefined
  const scope: Scope[] = kind === 'SAST'
    ? (req as SASTOut).components.map(target => ({ id: target.id, label: target.repository_url || `Repository ${target.id}`, values: Object.fromEntries(Object.keys(SAST_INPUTS).map(field => [field, String(target[field as keyof typeof target] || '')])) }))
    : (req as DASTOut).targets.map(target => ({ id: target.id, label: target.application_url, values: Object.fromEntries(Object.keys(DAST_INPUTS).map(field => [field, String(target[field as keyof typeof target] || '')])) }))
  const name = (id?: number | null) => users.find(user => user.id === id)?.full_name || (id ? `User ${id}` : 'Not assigned')
  return <section className="card" aria-label="Security obstacles" style={{ margin: '16px 0', padding: 16 }}>
    <strong>Obstacles and requester actions</strong>
    <p className="muted small">Approvals, checklist evidence and analyst ownership are retained. Affected scope stays blocked until fresh QA review; other repositories or targets can continue.</p>
    {canManage && OBSTACLE_ACTIVE_STAGES.includes(req.status) && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button className="btn btn-sm" onClick={() => setDialog({ mode: 'REQUESTER' })}>Return to requester — action required</button>
      <button className="btn btn-sm" onClick={() => setDialog({ mode: 'INTERNAL' })}>Put on hold — internal blocker</button>
    </div>}
    {rows.length === 0 && <p className="muted small">No obstacles recorded.</p>}
    {rows.map(row => {
      const permissions = obstaclePermissions(row, userId, inputOwnerId, canManage, canApprove)
      const state = row.status === 'OPEN' ? row.kind === 'REQUESTER' ? 'Awaiting requester action' : 'Internal hold' : row.status === 'RESOLVED' ? 'Reviewed and resumed' : SAST_DAST_STATUS_LABELS[row.status]
      return <article key={row.id} style={{ padding: '12px 0', borderTop: '1px solid var(--border)', marginTop: 12 }}>
        <strong>#{row.id} · {row.category} · {state}</strong>
        <p>{row.reason}</p><p><strong>Required correction:</strong> {row.requested_correction}</p>
        <p className="small"><strong>Affected scope:</strong> {row.target_ids.length ? scope.filter(target => row.target_ids.includes(target.id)).map(target => target.label).join(', ') : 'Whole request'}<br />
          <strong>Action owner:</strong> {name(row.kind === 'REQUESTER' ? inputOwnerId : row.owner_id)} · <strong>Resume stage:</strong> {SAST_DAST_STATUS_LABELS[row.resume_stage] || row.resume_stage}</p>
        {row.resolution && <p><strong>Submitted update:</strong> {row.resolution}</p>}
        {row.changed_fields.length > 0 && <p className="small">Changed inputs: {row.changed_fields.join(', ')}. Current scan coverage must be re-established.</p>}
        {!!row.added_target_ids?.length && <p className="small">Repositories added in this correction: {row.added_target_ids.length}. Each requires its own approved scope and current scan coverage.</p>}
        {row.submitted_at && <p className="muted small">Submitted by {name(row.submitted_by_id)} · {formatDateTimeIST(row.submitted_at)}</p>}
        {row.reviewed_at && <p className="muted small">Reviewed by {name(row.reviewed_by_id)} · {formatDateTimeIST(row.reviewed_at)}. See Activity for every return and decision.</p>}
        {row.status === 'QA_REVIEW_PENDING' && row.submitted_by_id === userId && <p className="muted small">A different QA user must review your submission.</p>}
        {permissions.submit && <button className="btn btn-sm btn-primary" onClick={() => setDialog({ mode: 'submit', row })}>Submit correction for review</button>}
        {permissions.review && <button className="btn btn-sm btn-primary" onClick={() => setDialog({ mode: 'review', row })}>Review correction</button>}
        {permissions.approve && <button className="btn btn-sm btn-primary" onClick={() => setDialog({ mode: 'approve', row })}>Review changed scope</button>}
        {canManage && row.status === 'OPEN' && <button className="btn btn-sm" onClick={() => setDialog({ mode: 'route', row })}>Change action owner / routing</button>}
        {kind === 'SAST' && canManage && row.kind === 'REQUESTER' && row.status === 'OPEN' && row.target_ids.length > 0 && <button className="btn btn-sm" onClick={() => setDialog({ mode: 'permission', row })}>Manage repository additions</button>}
      </article>
    })}
    {dialog && <ObstacleDialog key={`${req.id}:${dialog.mode}:${activeRow?.id}:${activeRow?.revision}`} kind={kind} req={req} scope={scope} mode={dialog.mode} row={activeRow} ownerOptions={ownerOptions} onClose={() => setDialog(null)} onChanged={async updated => { await onChanged(updated); setDialog(null) }} />}
  </section>
}

function ObstacleDialog({ kind, req, scope, mode, row, ownerOptions, onClose, onChanged }: {
  kind: 'SAST' | 'DAST'; req: Request; scope: Scope[]; mode: 'REQUESTER' | 'INTERNAL' | 'submit' | 'review' | 'approve' | 'permission' | 'route'; row?: SecurityObstacleOut;
  ownerOptions: UserOption[]; onClose: () => void; onChanged: (updated: Request) => Promise<void>
}) {
  const creating = mode === 'REQUESTER' || mode === 'INTERNAL'
  const [whole, setWhole] = useState(true)
  const [selected, setSelected] = useState<number[]>([])
  const [category, setCategory] = useState('Access / connectivity')
  const [reason, setReason] = useState('')
  const [correction, setCorrection] = useState('')
  const [ownerId, setOwnerId] = useState(row?.kind === 'INTERNAL' && row.owner_id ? String(row.owner_id) : req.security_analyst_id ? String(req.security_analyst_id) : '')
  const [routingKind, setRoutingKind] = useState<'REQUESTER' | 'INTERNAL'>(row?.kind || 'REQUESTER')
  const [reapproval, setReapproval] = useState(false)
  const [allowScopeAdditions, setAllowScopeAdditions] = useState(Boolean(row?.allow_scope_additions))
  const [scopeReason, setScopeReason] = useState('')
  const [repositoryRows, setRepositoryRows] = useState<SastRepositoryRow[]>(() => initialCorrectionRows(scope))
  const [notes, setNotes] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [readiness, setReadiness] = useState(false)
  const [credentialUpdates, setCredentialUpdates] = useState<number[]>([])
  const [drafts, setDrafts] = useState<Record<number, Record<string, string>>>(() => Object.fromEntries(scope.map(target => [target.id, { ...target.values, ...(kind === 'DAST' ? { test_credentials: '' } : {}) }])))
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const covered = row?.target_ids.length ? scope.filter(target => row.target_ids.includes(target.id)) : scope
  const editableIds = covered.map(target => target.id)
  const canAddRepositories = row?.kind === 'REQUESTER' && (!row.target_ids.length || row.allow_scope_additions === true)
  const hasNewRepositories = repositoryRows.some(repository => !repository._target_id)
  const repositoryError = kind === 'SAST' && mode === 'submit' && row?.kind === 'REQUESTER'
    ? sastCorrectionError(scope, repositoryRows, editableIds, !!canAddRepositories, scopeReason) : null
  const blocked = new Set((req.obstacles || []).filter(item => item.status !== 'RESOLVED').flatMap(item => item.target_ids.length ? item.target_ids : scope.map(target => target.id)))
  const toggle = (id: number) => setSelected(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id])
  async function save(decision?: 'Resume' | 'Return' | 'Approve') {
    setBusy(true); setError(null)
    try {
      const base = `/api/${kind.toLowerCase()}-requests/${req.id}/obstacles`
      const path = creating ? base : `${base}/${row!.id}/${mode === 'submit' ? 'submit' : mode === 'review' ? 'review' : mode === 'permission' ? 'scope-permission' : mode === 'route' ? 'route' : 'scope-decision'}`
      const payload = creating ? {
        kind: mode, category, reason, requested_correction: correction, target_ids: whole ? [] : selected,
        ...(mode === 'INTERNAL' ? { owner_id: ownerId ? Number(ownerId) : null } : {}), require_dept_head_reapproval: reapproval,
        ...(kind === 'SAST' && mode === 'REQUESTER' ? { allow_scope_additions: !whole && allowScopeAdditions } : {}),
      } : mode === 'submit' ? {
        revision: row!.revision, resolution: notes || null,
        ...(row!.kind === 'REQUESTER' && kind === 'SAST' ? { ...sastCorrectionPayload(scope, repositoryRows, editableIds), scope_change_reason: hasNewRepositories ? scopeReason.trim() : null }
          : { corrections: row!.kind === 'REQUESTER' ? correctionPayload(covered, drafts, selected, credentialUpdates) : [] }),
      } : mode === 'permission' ? { revision: row!.revision, allow_scope_additions: allowScopeAdditions, reason: scopeReason.trim() }
        : mode === 'route' ? { revision: row!.revision, kind: routingKind, ...(routingKind === 'INTERNAL' ? { owner_id: ownerId ? Number(ownerId) : null } : {}), reason: reason.trim() }
        : { revision: row!.revision, decision, comments: notes || null, ...(mode === 'review' ? { verification_confirmed: confirmed, readiness_confirmed: readiness } : {}) }
      await onChanged(await api.post<Request>(path, payload))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  async function refreshLatest() {
    setBusy(true); setError(null)
    try { await onChanged(await api.getFresh<Request>(`/api/${kind.toLowerCase()}-requests/${req.id}`)) }
    catch (err) { setError(err) } finally { setBusy(false) }
  }
  return <Modal title={creating ? mode === 'REQUESTER' ? 'Return to requester — action required' : 'Put on hold — internal blocker' : mode === 'submit' ? 'Submit correction for review' : mode === 'review' ? 'Fresh QA review' : mode === 'permission' ? 'Manage repository additions' : mode === 'route' ? 'Change action owner / routing' : 'Changed scope approval'} onClose={() => { if (!busy) onClose() }} wide variant="dialog" preventBackdropClose>
    <ErrorText error={error} />
    {isStaleObstacleError(error) && <div><p className="muted small">Reload the saved request before continuing. Unsaved edits in this dialog will be discarded.</p><button className="btn" disabled={busy} onClick={refreshLatest}>Refresh latest request</button></div>}
    {creating ? <>
      <Field label="Category *"><select value={category} onChange={e => setCategory(e.target.value)}>{['Access / connectivity', 'Incorrect inputs', 'Source / build dependencies', 'Environment unavailable', 'Scanner / tool issue', 'Scope clarification', 'Other'].map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Obstacle reason *"><textarea value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} /></Field>
      <Field label="Required correction / action *"><textarea value={correction} maxLength={2000} onChange={e => setCorrection(e.target.value)} /></Field>
      <label><input type="checkbox" checked={whole} disabled={blocked.size > 0} onChange={e => setWhole(e.target.checked)} /> Whole request</label>
      {blocked.size > 0 && whole && <p className="muted small">An obstacle already covers part of this request. Select unaffected scope below.</p>}
      {(!whole || blocked.size > 0) && <fieldset><legend>Affected {kind === 'SAST' ? 'repositories' : 'targets'} *</legend>{scope.map(target => <label key={target.id} style={{ display: 'block' }}><input type="checkbox" checked={selected.includes(target.id)} disabled={blocked.has(target.id)} onChange={() => { setWhole(false); toggle(target.id) }} /> {target.label}{blocked.has(target.id) ? ' (already blocked)' : ''}</label>)}</fieldset>}
      {mode === 'INTERNAL' && <Field label="Internal action owner *"><UserAssignSelect value={ownerId} onChange={setOwnerId} users={ownerOptions} placeholder="Select accountable internal owner…" /></Field>}
      {kind === 'SAST' && mode === 'REQUESTER' && !whole && <label><input type="checkbox" checked={allowScopeAdditions} onChange={e => setAllowScopeAdditions(e.target.checked)} /> Permit adding repositories during this correction</label>}
      <label><input type="checkbox" checked={reapproval} onChange={e => setReapproval(e.target.checked)} /> Require Department Head reapproval before resuming</label>
      <p className="muted small">Completed approvals and evidence are retained. Material scope changes automatically require scope reapproval and fresh readiness review.</p>
      <button className="btn btn-primary" disabled={busy || !reason.trim() || !correction.trim() || (!whole && !selected.length) || (whole && blocked.size > 0) || (mode === 'INTERNAL' && !ownerId)} onClick={() => save()}>{busy ? 'Saving…' : mode === 'REQUESTER' ? 'Return to requester' : 'Open internal hold'}</button>
    </> : mode === 'route' ? <>
      <p>Recover an unavailable owner or correct where this obstacle should be handled. Affected scope, approvals, evidence and analyst ownership are preserved. Fresh submission and QA review are still required.</p>
      <Field label="Action needed from *"><select value={routingKind} onChange={e => setRoutingKind(e.target.value as 'REQUESTER' | 'INTERNAL')}><option value="REQUESTER">Requester / active delegate</option><option value="INTERNAL">Internal action owner</option></select></Field>
      {routingKind === 'INTERNAL' && <Field label="Internal action owner *"><UserAssignSelect value={ownerId} onChange={setOwnerId} users={ownerOptions} placeholder="Select accountable internal owner…" /></Field>}
      <Field label="Reason for changing owner / routing *"><textarea maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <button className="btn btn-primary" disabled={busy || !reason.trim() || (routingKind === 'INTERNAL' && !ownerId) || (routingKind === row!.kind && (routingKind === 'REQUESTER' || Number(ownerId) === row!.owner_id))} onClick={() => save()}>Save routing</button>
    </> : mode === 'permission' ? <>
      <p>Permit the requester or active delegate to add repositories to this return. Additions still require scope approval and fresh QA review.</p>
      <label><input type="checkbox" checked={allowScopeAdditions} onChange={e => setAllowScopeAdditions(e.target.checked)} /> Permit adding repositories during this correction</label>
      <Field label="Reason for changing scope permission *"><textarea maxLength={2000} value={scopeReason} onChange={e => setScopeReason(e.target.value)} /></Field>
      <button className="btn btn-primary" disabled={busy || !scopeReason.trim() || allowScopeAdditions === Boolean(row!.allow_scope_additions)} onClick={() => save()}>Save permission</button>
    </> : <>
      <p><strong>Required action:</strong> {row!.requested_correction}</p>
      {(mode === 'review' || mode === 'approve') && <>
        {row!.resolution && <p><strong>Submitted update:</strong> {row!.resolution}</p>}
        <details open><summary>Latest inputs for affected scope</summary>
          {covered.map(target => <fieldset key={target.id}><legend>{target.label}</legend>
            {Object.entries(kind === 'SAST' ? SAST_INPUTS : DAST_INPUTS).map(([field, label]) => <p key={field}><strong>{label}:</strong> {target.values[field] || 'Not provided'}</p>)}
            {row!.changed_fields.includes(`Target ${target.id}: test_credentials`) && <p className="muted small">Test credentials were updated through the protected field. Verify authenticated access before resuming.</p>}
          </fieldset>)}
        </details>
      </>}
      {mode === 'submit' && row!.kind === 'REQUESTER' && kind === 'SAST' && <>
        <SastRepositoryDetails rows={repositoryRows} onChange={setRepositoryRows} hashValue={(req as SASTOut).hash_value || ''} onHashChange={() => {}} showHash={false}
          allowAdd={!!canAddRepositories}
          isReadOnlyRow={index => !!repositoryRows[index]?._target_id && !editableIds.includes(Number(repositoryRows[index]._target_id))}
          canRemoveRow={index => !repositoryRows[index]?._target_id}
          rowKey={index => repositoryRows[index]?._target_id || `new-${index}`}
          rowStatus={index => {
            const repository = repositoryRows[index]
            if (!repository?._target_id) return 'New — pending review'
            const id = Number(repository._target_id)
            if (!editableIds.includes(id)) return 'Unchanged — read only'
            if (row!.added_target_ids?.includes(id)) return 'Added in this correction'
            const original = scope.find(target => target.id === id)
            return SAST_COMPONENT_FIELDS.some(field => (repository[field.key] || '').trim() !== (original?.values[field.key] || '').trim()) ? 'Modified — pending review' : 'Returned for correction'
          }} />
        {!canAddRepositories && <p className="muted small">This return covers selected repositories. QA can permit additions if more repositories are needed.</p>}
        {hasNewRepositories && <Field label="Reason for adding repositories *"><textarea maxLength={2000} value={scopeReason} onChange={e => setScopeReason(e.target.value)} /></Field>}
        {repositoryError && <p className="muted small" role="status">{repositoryError}</p>}
        {hasNewRepositories && <p className="muted small">New repositories require Department Head scope approval, fresh QA readiness review and their own scan before clearance.</p>}
      </>}
      {mode === 'submit' && row!.kind === 'REQUESTER' && kind === 'DAST' && covered.map(target => <fieldset key={target.id}>
        <legend><label><input type="checkbox" checked={selected.includes(target.id)} onChange={() => toggle(target.id)} /> Update inputs for {target.label}</label></legend>
        {selected.includes(target.id) && Object.entries(DAST_INPUTS).map(([field, label]) => <Field key={field} label={label}>
          {field === 'environment' ? <select value={drafts[target.id][field]} onChange={e => setDrafts(values => ({ ...values, [target.id]: { ...values[target.id], [field]: e.target.value } }))}><option value="">Select environment…</option>{POST_SIT_ENVIRONMENTS.map(value => <option key={value}>{value}</option>)}</select>
            : field === 'authentication_required' ? <select value={drafts[target.id][field]} onChange={e => setDrafts(values => ({ ...values, [target.id]: { ...values[target.id], [field]: e.target.value } }))}><option value="No">No</option><option value="Yes">Yes</option></select>
            : <input value={drafts[target.id][field]} onChange={e => setDrafts(values => ({ ...values, [target.id]: { ...values[target.id], [field]: e.target.value } }))} />}
        </Field>)}
        {kind === 'DAST' && selected.includes(target.id) && <>
          <label><input type="checkbox" checked={credentialUpdates.includes(target.id)} onChange={e => setCredentialUpdates(values => e.target.checked ? [...values, target.id] : values.filter(id => id !== target.id))} /> Update test credentials</label>
          {credentialUpdates.includes(target.id) && <Field label={drafts[target.id].authentication_required === 'Yes' ? 'New test credentials *' : 'Test credentials (leave blank to clear)'}><input type="password" autoComplete="new-password" value={drafts[target.id].test_credentials} onChange={e => setDrafts(values => ({ ...values, [target.id]: { ...values[target.id], test_credentials: e.target.value } }))} /></Field>}
        </>}
      </fieldset>)}
      <Field label={mode === 'submit' ? 'Correction notes (optional)' : 'Notes / supporting details (optional; required when returning)'}><textarea maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      {kind === 'DAST' && <p className="muted small">Enter credentials only in the protected credential field.</p>}
      <p className="muted small">Existing checklist evidence and scan history remain available.</p>
      {mode === 'review' && <>
        <label style={{ display: 'block' }}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I freshly verified this obstacle's latest correction.</label>
        {row!.readiness_required && <label style={{ display: 'block' }}><input type="checkbox" checked={readiness} onChange={e => setReadiness(e.target.checked)} /> I rechecked readiness for the affected changed scope.</label>}
      </>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {mode === 'submit' ? <button className="btn btn-primary" disabled={busy || !!repositoryError || credentialUpdates.some(id => selected.includes(id) && drafts[id].authentication_required === 'Yes' && !drafts[id].test_credentials.trim())} onClick={() => save()}>Submit for review</button>
          : <><button className="btn btn-primary" disabled={busy || (mode === 'review' && (!confirmed || (row!.readiness_required && !readiness)))} onClick={() => save(mode === 'review' ? 'Resume' : 'Approve')}>{mode === 'review' ? 'Confirm review and resume' : 'Approve changed scope'}</button><button className="btn" disabled={busy || !notes.trim()} onClick={() => save('Return')}>Return for correction</button></>}
      </div>
    </>}
  </Modal>
}
