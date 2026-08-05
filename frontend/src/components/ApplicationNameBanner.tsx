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
  onDecided: (decision: 'Approved' | 'Rejected') => void
  onRefresh: () => void
}

// Shown inline on the master QA Request gateway's own Overview tab (see
// QARequests/RequestDetail.tsx) when its Application Name is still a
// brand-new, not-yet-approved entry (see backend models.ApplicationMaster) --
// lets whoever holds the checkpoint for the CURRENT tier approve/reject the
// name itself right here. Reported directly: "Request Raised with new
// application name... it must be at master request level, not on individual
// request level of childs" -- this used to render separately on every one of
// the linked Functional/SAST/DAST/Performance requests' own pages instead
// (duplicating the same decision across however many child requests shared
// the name); those pages still show read-only "Pending .../Rejected" badges
// (see applicationNameAwareStatusLabel and each page's own Application Name
// field) and still block SM/Department Head approval while the name isn't
// APPROVED, but the actual Approve/Reject action only lives here now.
// Single-tier (2026-08 v2, reported directly: "only application owner
// approval required, no SM involvement. if application owner approved then
// automatically come to SM for readiness verification and all"):
// PENDING_APP_OWNER -> an Application Owner decides, Approved or Rejected,
// and either outcome is immediately terminal. Approving finalizes the name
// (APPROVED) and, if this request's own child requests hadn't been created
// yet (see routers/qa_requests.py::submit_request's deferred-creation
// branch), creates them now and sends them straight to their assigned SM's
// own normal readiness-verification queue -- no separate Application Name
// decision from that SM exists anymore. Rejecting force-rejects the request
// itself if it's still sitting at SM Approval, since it can't be allowed to
// proceed to Department Head under a name that was just rejected --
// onDecided() below reloads the parent request so its status/badge picks
// that up immediately. (PENDING_SM/isSmTier below is legacy-only, for any
// row that predates this change -- see decide_application_name's own
// docstring; no new name can ever reach it.) Only rendered for whichever
// role owns the CURRENT tier (or Admin); require_same_department is
// enforced server-side regardless, so someone from a different department
// gets a 403 here rather than silently succeeding.
export function ApplicationNameBanner({ applicationMasterId, applicationMasterStatus, applicationName, onDecided, onRefresh }: Props) {
  const { user } = useAuth()
  const [busy, setBusy] = useState<'Approved' | 'Rejected' | null>(null)
  // Reported directly: a reviewer could click Approve/Reject more than once
  // -- this banner kept re-rendering with its stale, pre-decision props
  // (still PENDING_APP_OWNER/PENDING_SM, buttons re-enabled) whenever the
  // parent's own post-decision reload silently failed (see onDecided's own
  // comment above). Tracked locally, independent of whatever the reload
  // does or doesn't manage to do, so the buttons are gone for good the
  // instant the decision itself succeeds -- not "until the next prop
  // update that may never come."
  const [decided, setDecided] = useState<'Approved' | 'Rejected' | null>(null)
  const [error, setError] = useState<unknown>(null)

  const isAppOwnerTier = applicationMasterStatus === 'PENDING_APP_OWNER'
  const isSmTier = applicationMasterStatus === 'PENDING_SM'
  const canDecideHere = (isAppOwnerTier && hasRole(user, 'APPLICATION_OWNER'))
    || (isSmTier && hasRole(user, 'SM'))

  if (!applicationMasterId || (!canDecideHere && !decided)) return null

  const endpoint = isAppOwnerTier ? 'app-owner-decision' : 'decision'
  const tierLabel = isAppOwnerTier ? 'Application Owner' : 'SM'

  async function decide(decision: 'Approved' | 'Rejected') {
    setBusy(decision)
    setError(null)
    try {
      await api.post(`/api/application-names/${applicationMasterId}/${endpoint}`, { decision })
      setDecided(decision)
      // Reported directly (again, after section 175/177): buttons were still
      // showing after a click. AWAITED now (was fire-and-forget) so the
      // parent's own refresh -- or its "returned to requester as Draft, no
      // longer visible" notice, which also closes this drawer -- has
      // actually finished before this click's lifecycle is considered done,
      // instead of leaving a window where a slow/failed reload could leave
      // stale data sitting behind the (already-correct) local `decided`
      // view. Errors from it are swallowed here on purpose: onDecided
      // already turns any reload failure into its own user-facing notice
      // (see reloadAfterApplicationNameDecision's docstring) -- must not
      // also dump that as a second raw error on top of a decision that
      // itself already succeeded.
      try {
        await onDecided(decision)
      } catch {
        /* already handled by the parent -- see comment above */
      }
    } catch (err) {
      setError(err)
      // Deliberately onRefresh here, NOT onDecided -- this decision attempt
      // itself failed, so nothing was actually recorded; onDecided assumes
      // success and would incorrectly fire the "rejected, returned to
      // requester" notice (closing the drawer) over a click that never
      // actually went through. onRefresh makes no such assumption -- it just
      // picks up whatever the real current state already is. See its own
      // docstring above for why this matters (most commonly: someone else
      // already decided this exact name a moment earlier).
      onRefresh()
    } finally {
      setBusy(null)
    }
  }

  if (decided) {
    return (
      <div style={{
        marginBottom: 14, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10,
        padding: '10px 14px', color: '#166534', fontSize: 13,
      }}>
        <strong>Application Name {decided === 'Approved' ? 'approved' : 'rejected'}.</strong>{' '}
        {decided === 'Approved'
          ? 'It is now a selectable option for everyone else, and the linked request has moved on to SM for readiness verification.'
          : 'This decision has been recorded.'}
      </div>
    )
  }

  return (
    <div style={{
      marginBottom: 14, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10,
      padding: '10px 14px', color: '#1e40af', fontSize: 13,
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    }}>
      <span>
        <strong>New Application Name Pending {tierLabel} Approval:</strong> {applicationName || '—'} -- this
        was introduced as a new "Other" entry on the QA Request and needs your decision{isAppOwnerTier
          ? ' before it becomes a selectable option for everyone else and the linked request can move on to SM for readiness verification.'
          : ' before it becomes a selectable option for everyone else.'}
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
