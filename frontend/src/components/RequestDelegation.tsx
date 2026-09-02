import React, { useMemo, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { hasRole } from '../constants'
import { QARequestDelegationOut, UserOut } from '../types'
import { ErrorText, Field, Modal } from './Common'
import UserAssignSelect from './UserAssignSelect'

export type DelegationTarget = 'QA_REQUEST' | 'FUNCTIONAL' | 'SAST' | 'DAST' | 'PERFORMANCE'

export interface DelegatableRequest {
  id: number
  request_id?: string | null
  requester_id?: number | null
  status: string
  qa_request?: { id: number; request_id?: string | null } | null
  active_delegation?: QARequestDelegationOut | null
}

interface RequestDelegationProps<T extends DelegatableRequest> {
  targetType: DelegationTarget
  request: T
  users: UserOut[]
  onChanged: (updated: T) => void | Promise<void>
  onReturned?: () => void | Promise<void>
  disabled?: boolean
  showActiveBadge?: boolean
}

const REQUESTER_STATUSES: Record<DelegationTarget, Set<string>> = {
  QA_REQUEST: new Set(['DRAFT']),
  FUNCTIONAL: new Set([
    'DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED',
    'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_QA_LEAD',
  ]),
  SAST: new Set([
    'DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED',
    'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD', 'WAITING_FOR_FIX',
  ]),
  DAST: new Set([
    'DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED',
    'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_SECURITY_LEAD', 'WAITING_FOR_FIX',
  ]),
  PERFORMANCE: new Set([
    'DRAFT', 'RETURNED_BY_SM', 'SM_REJECTED',
    'RETURNED_BY_DEPARTMENT_HEAD', 'RETURNED_BY_ENGINEER',
  ]),
}

const DETAIL_BASE: Record<DelegationTarget, string> = {
  QA_REQUEST: '/api/qa-requests',
  FUNCTIONAL: '/api/functional-requests',
  SAST: '/api/sast-requests',
  DAST: '/api/dast-requests',
  PERFORMANCE: '/api/performance-requests',
}

export function requestDelegationCapabilities(
  targetType: DelegationTarget,
  request: DelegatableRequest,
  user: UserOut | null | undefined,
) {
  const parentId = targetType === 'QA_REQUEST' ? request.id : request.qa_request?.id
  const active = request.active_delegation?.status === 'ACTIVE' ? request.active_delegation : null
  const canManage = (!user?.roles?.includes('VIEW_ONLY') && request.requester_id === user?.id) || hasRole(user, 'ADMIN')
  return {
    parentId,
    active,
    canAssign: !!parentId && canManage && !active && REQUESTER_STATUSES[targetType].has(request.status),
    canReturn: !!parentId && active?.assigned_to_id === user?.id,
    canRecall: !!parentId && !!active && canManage,
  }
}

/** One delegation workflow for the gateway and every linked request type. */
export default function RequestDelegation<T extends DelegatableRequest>({
  targetType,
  request,
  users,
  onChanged,
  onReturned,
  disabled = false,
  showActiveBadge = true,
}: RequestDelegationProps<T>) {
  const { user } = useAuth()
  const [dialog, setDialog] = useState<'assign' | 'return' | 'recall' | null>(null)
  const [assigneeId, setAssigneeId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const { parentId, active, canAssign, canReturn, canRecall } = requestDelegationCapabilities(targetType, request, user)

  const candidates = useMemo(
    () => users.filter((candidate) => candidate.is_active && candidate.id !== request.requester_id),
    [request.requester_id, users],
  )

  if (!parentId || (!canAssign && !canReturn && !canRecall && !active)) return null

  function closeDialog() {
    if (busy) return
    setDialog(null)
    setAssigneeId('')
    setNote('')
    setError(null)
  }

  async function refresh() {
    const updated = await api.get<T>(`${DETAIL_BASE[targetType]}/${request.id}`)
    await onChanged(updated)
  }

  function mutationRoute(): string {
    return targetType === 'QA_REQUEST'
      ? `/api/qa-requests/${request.id}/delegations`
      : `/api/qa-requests/${parentId}/child-delegations/${targetType}/${request.id}`
  }

  async function submit() {
    const trimmed = note.trim()
    if (!trimmed) {
      setError(new Error(dialog === 'assign' ? 'Assignment reason is required.' : dialog === 'return' ? 'Return comments are required.' : 'Recall reason is required.'))
      return
    }
    if (dialog === 'assign' && !assigneeId) {
      setError(new Error('Select a user to receive this request.'))
      return
    }
    if (!dialog) return

    setBusy(true)
    setError(null)
    try {
      const route = mutationRoute()
      if (dialog === 'assign') {
        await api.post(route, { assigned_to_id: Number(assigneeId), reason: trimmed })
      } else {
        await api.post(`${route}/${dialog}`, { comments: trimmed })
      }
      if (dialog === 'return' && onReturned) {
        await onReturned()
      } else {
        await refresh()
      }
      setDialog(null)
      setAssigneeId('')
      setNote('')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const actionBusy = busy || disabled
  return (
    <>
      {active && showActiveBadge && (
        <span className="badge badge-info" title={active.assignment_reason}>
          Input assigned to {active.assigned_to_name || `user #${active.assigned_to_id}`}
        </span>
      )}
      {canAssign && <button type="button" className="btn btn-primary btn-sm" disabled={actionBusy} onClick={() => setDialog('assign')}>Delegate for Input</button>}
      {canReturn && <button type="button" className="btn btn-primary btn-sm" disabled={actionBusy} onClick={() => setDialog('return')}>Return to Requester</button>}
      {canRecall && <button type="button" className="btn btn-sm" disabled={actionBusy} onClick={() => setDialog('recall')}>Recall Delegation</button>}

      {dialog && (
        <Modal
          title={dialog === 'assign' ? 'Delegate for Input' : dialog === 'return' ? 'Return to Requester' : 'Recall Delegation'}
          onClose={closeDialog}
          variant="dialog"
          preventBackdropClose
        >
          <p className="muted small" style={{ marginTop: 0 }}>
            {dialog === 'assign'
              ? 'Select any active user. Department does not restrict this temporary assignment, and ownership remains with the requester.'
              : dialog === 'return'
              ? 'Confirm what you updated. After return, your edit and upload access will end and the requester can continue the workflow.'
              : 'Recall immediately removes the assigned user’s edit and upload access and returns control to the requester.'}
          </p>
          {dialog === 'assign' && (
            <Field label="Assign to *">
              <UserAssignSelect value={assigneeId} onChange={setAssigneeId} users={candidates} placeholder="Search and select a user..." disabled={busy} />
            </Field>
          )}
          <Field label={dialog === 'assign' ? 'Assignment reason *' : dialog === 'return' ? 'Return comments *' : 'Recall reason *'}>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={dialog === 'assign' ? 'Describe the information or document update required...' : undefined}
              maxLength={1000}
              rows={4}
              disabled={busy}
            />
          </Field>
          <ErrorText error={error} />
          <div className="form-actions">
            <button type="button" className="btn btn-sm" onClick={closeDialog} disabled={busy}>Cancel</button>
            <button
              type="button"
              className={`btn btn-sm ${dialog === 'recall' ? 'btn-danger' : 'btn-primary'}`}
              onClick={submit}
              disabled={busy || !note.trim() || (dialog === 'assign' && !assigneeId)}
            >
              {busy ? (dialog === 'assign' ? 'Assigning...' : dialog === 'return' ? 'Returning...' : 'Recalling...')
                : dialog === 'assign' ? 'Assign for Input' : dialog === 'return' ? 'Return to Requester' : 'Recall Delegation'}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
