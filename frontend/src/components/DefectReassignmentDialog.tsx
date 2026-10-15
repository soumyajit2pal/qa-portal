import React, { useEffect, useRef, useState } from 'react'
import { api, HttpError } from '../api'
import { ErrorText, Field, Modal, WarningNotice } from './Common'
import ConfirmModal from './ConfirmModal'
import SearchableSelect from './SearchableSelect'
import UserAssignSelect from './UserAssignSelect'
import type { DefectAssignmentContext } from '../defectReassignment'
import type { DefectOut } from '../types'

export default function DefectReassignmentDialog({ defectId, defectKey, recovery = false, onClose, onChanged }: {
  defectId: number; defectKey: string; recovery?: boolean;
  onClose: () => void; onChanged: (updated: DefectOut) => void | Promise<void>
}) {
  const [context, setContext] = useState<DefectAssignmentContext | null>(null)
  const [department, setDepartment] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [savedDefect, setSavedDefect] = useState<DefectOut | null>(null)
  const generation = useRef(0)
  const submitting = useRef(false)

  async function load(selectedDepartment = '') {
    const requestId = ++generation.current
    setLoading(true); setError(null); setConfirm(false); setOwnerId(''); setContext(null)
    try {
      const query = selectedDepartment ? `?department=${encodeURIComponent(selectedDepartment)}` : ''
      const latest = await api.getFresh<DefectAssignmentContext>(`/api/defects/${defectId}/assignment-context${query}`)
      if (requestId !== generation.current) return
      setContext(latest)
      setDepartment(selectedDepartment || latest.defect.resolver_department || '')
    } catch (err) { if (requestId === generation.current) setError(err) }
    finally { if (requestId === generation.current) setLoading(false) }
  }
  useEffect(() => { void load(); return () => { generation.current += 1 } }, [defectId, recovery])

  const candidates = context ? (recovery ? context.recovery_candidates : context.reassignment_candidates) : []
  const candidate = candidates.find(user => String(user.id) === ownerId)
  const resolverStage = context?.responsibility_kind === 'resolver'
  const allowed = !!context && (recovery ? context.can_recover : context.can_reassign)
  const unchanged = recovery && candidate?.id === context?.defect.assignee_id && department === context?.defect.assigned_team
  const disabled = loading || busy || !!savedDefect || !allowed || !candidate || !reason.trim() || unchanged
    || (recovery ? !context?.recovery_departments.includes(department) : resolverStage && context?.routing_recovery_needed)

  async function save() {
    if (disabled || !context || submitting.current || (recovery && !confirm)) return
    submitting.current = true; setBusy(true); setError(null)
    let updated: DefectOut | null = null
    try {
      updated = await api.post<DefectOut>(`/api/defects/${defectId}/${recovery ? 'recover-routing' : 'reassign'}`, {
        assignee_id: candidate!.id, reason: reason.trim(),
        assigned_team: recovery || resolverStage ? department : null,
        expected_revision: context.defect.workflow_revision || 0,
        expected_owner_id: recovery ? context.defect.assignee_id : context.responsibility_owner_id,
        ...(recovery ? { confirmation: true } : {}),
      })
      setSavedDefect(updated); setConfirm(false); await onChanged(updated)
    } catch (err) {
      setConfirm(false)
      if (updated) setError(new Error('The ownership change was saved, but the view could not refresh. Refresh the defect details to see it.'))
      else {
        setError(err)
        if (err instanceof HttpError && err.status === 409) { setContext(null); setOwnerId('') }
      }
    } finally { submitting.current = false; setBusy(false) }
  }

  return <Modal title={`${recovery ? 'Recover resolver routing for' : 'Reassign'} ${defectKey}`} onClose={onClose} closeDisabled={busy} variant="dialog" preventBackdropClose>
    <WarningNotice title={recovery ? 'Audited resolver routing recovery' : resolverStage ? 'Reassign within the responsible department' : 'Reassign the current stage owner'}>
      {recovery ? 'Correct the resolver and responsible department. The current lifecycle stage, QA/business/release ownership, evidence and retest requirements remain in place.'
        : resolverStage ? 'Select a teammate in the responsible department. Send work to QA through the lifecycle handoff after starting and completing the required work.'
        : 'This changes the responsible owner for the current stage. The resolver and resolution department remain in place.'}
    </WarningNotice>
    {loading ? <p role="status">Loading current ownership and eligible users…</p> : context && <>
      <p>Current stage: <strong>{context.defect.status}</strong></p>
      <p>Currently responsible: <strong>{context.responsibility_owner_name || 'Owner unavailable'}</strong></p>
      {recovery && <p>Current resolver: <strong>{context.defect.assignee_name || 'Owner unavailable'}</strong> ({context.defect.assigned_team || 'Department not recorded'}).</p>}
      <p>Responsible department: <strong>{context.defect.resolver_department || 'Not recorded'}</strong></p>
      {recovery && context.resolver_department_source === 'current' && <WarningNotice title="Original routing was not recorded">Select the correct department after reviewing the defect and its history. Your selection and reason will establish its responsible department.</WarningNotice>}
      {!recovery && resolverStage && context.routing_recovery_needed && <WarningNotice title="Resolver routing needs recovery">Contact an administrator, workspace QA lead or authorized responsible department head to recover routing before reassigning.</WarningNotice>}
      {!allowed && <WarningNotice title="Ownership action unavailable">Your permission or the defect stage changed. Refresh the defect details or contact an authorized lead.</WarningNotice>}
      {recovery && <Field label="Responsible department *"><SearchableSelect value={department} disabled={busy || !!savedDefect} options={context.recovery_departments.map(value => ({ value, label: value }))} onChange={value => { setDepartment(value); void load(value) }} placeholder="Select the responsible department…" /></Field>}
      <Field label={recovery ? 'Resolver *' : 'New responsible owner *'}><UserAssignSelect value={ownerId} onChange={value => { setOwnerId(value); setConfirm(false) }} users={candidates} disabled={busy || !allowed || !!savedDefect} placeholder={recovery || resolverStage ? 'Search department teammates…' : 'Search eligible stage owners…'} /></Field>
      {allowed && candidates.length === 0 && <p role="status">No eligible users are available. Contact an administrator or authorized lead to review department membership and workspace access.</p>}
      <Field label={recovery ? 'Routing recovery reason *' : 'Reassignment reason *'}><textarea rows={3} value={reason} disabled={busy || !!savedDefect} maxLength={4000} onChange={event => { setReason(event.target.value); setConfirm(false) }} /></Field>
    </>}
    <ErrorText error={error} />
    <div className="modal-actions">
      {savedDefect ? <button type="button" className="btn btn-primary" onClick={() => onChanged(savedDefect)}>Show saved defect</button>
        : <><button type="button" className="btn btn-primary" disabled={!!disabled} onClick={() => recovery ? setConfirm(true) : void save()}>{busy ? 'Saving…' : recovery ? 'Review routing recovery' : 'Reassign'}</button>
          <button type="button" className="btn" disabled={loading || busy} onClick={() => void load(department)}>Refresh latest</button></>}
      <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
    </div>
    {confirm && <ConfirmModal title="Recover resolver routing?" tone="warning" busy={busy} confirmLabel="Confirm routing recovery" cancelLabel="Cancel"
      message={<><p>Assign resolver responsibility to <strong>{candidate?.full_name}</strong> in <strong>{department}</strong>.</p><p>The defect will remain <strong>{context?.defect.status}</strong>. The correction and your reason will be recorded in audit history.</p></>}
      onConfirm={() => void save()} onCancel={() => setConfirm(false)} />}
  </Modal>
}
