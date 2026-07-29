import React, { useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { hasRole } from '../constants'
import { ErrorText } from './Common'

interface Props {
  applicationMasterId?: number | null
  applicationMasterStatus?: string | null
  applicationName?: string | null
  department?: string | null
  // Reloads the parent request after a decision so application_master_status
  // flips away from PENDING and this banner disappears on its own.
  onDecided: () => void
}

// Shown inline on a request's own SM Approval screen (Functional/SAST/DAST/
// Performance) when its Application Name is still a brand-new,
// not-yet-approved entry (see backend models.ApplicationMaster) -- lets the
// SM approve/reject the name itself right here. Approving the name never
// touches the request's own status. Rejecting it does: the backend
// (routers/applications.py::decide_application_name) also force-rejects the
// request itself if it's still sitting at SM Approval, since it can't be
// allowed to proceed to Department Head under a name that was just
// rejected -- onDecided() below reloads the parent request so its status/
// badge picks that up immediately. Only rendered for an SM (or Admin);
// require_same_department is enforced server-side regardless, so an SM from
// a different department gets a 403 here rather than silently succeeding.
export function ApplicationNameBanner({ applicationMasterId, applicationMasterStatus, applicationName, onDecided }: Props) {
  const { user } = useAuth()
  const [busy, setBusy] = useState<'Approved' | 'Rejected' | null>(null)
  const [error, setError] = useState<unknown>(null)

  if (applicationMasterStatus !== 'PENDING' || !applicationMasterId || !hasRole(user, 'SM')) return null

  async function decide(decision: 'Approved' | 'Rejected') {
    setBusy(decision)
    setError(null)
    try {
      await api.post(`/api/application-names/${applicationMasterId}/decision`, { decision })
      onDecided()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{
      marginBottom: 14, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10,
      padding: '10px 14px', color: '#1e40af', fontSize: 13,
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    }}>
      <span>
        <strong>New Application Name Pending Approval:</strong> {applicationName || '—'} -- this
        was introduced as a new "Other" entry on the QA Request and needs your decision before it
        becomes a selectable option for everyone else.
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => decide('Approved')}>
          {busy === 'Approved' ? 'Approving...' : 'Approve Name'}
        </button>
        <button type="button" className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => decide('Rejected')}>
          {busy === 'Rejected' ? 'Rejecting...' : 'Reject Name'}
        </button>
      </div>
      <ErrorText error={error} />
    </div>
  )
}
