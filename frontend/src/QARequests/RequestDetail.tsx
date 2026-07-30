import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, DetailField, DetailSection, ErrorText, Modal, Table } from '../components/Common'
import InfoModal from '../components/InfoModal'
import {
  GATEWAY_CANCELLABLE_STATUSES, GATEWAY_EDITABLE_STATUSES, GATEWAY_STATUS_LABELS,
  DEFAULT_SAST_CHECKLIST_ITEMS, DEFAULT_DAST_CHECKLIST_ITEMS,
  hasRole,
} from '../constants'
import { QARequestOut, UserOut, QARequestDocumentOut, ApprovalActionOut } from '../types'
import { GatewayPreview, gatewayStageIndex } from './GatewayPreview'
import { classificationSummary, linkedSections, userName } from './format'
import { NewRequestModal } from './NewRequestModal'
import { AddDocuments } from './AddDocuments'

interface RequestDetailProps {
  req: QARequestOut
  onClose: () => void
  onChanged: (req: QARequestOut) => void
  users: UserOut[]
}

// The "view an existing QA Request" modal -- Overview / Documents / History
// tabs, plus the gateway-level actions (Submit, Cancel, Edit) and the "Edit
// Request" wizard (reuses NewRequestModal in its `editing` mode).
export function RequestDetail({ req, onClose, onChanged, users }: RequestDetailProps) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [tab, setTab] = useState('overview')
  const [documents, setDocuments] = useState<QARequestDocumentOut[]>([])
  const [history, setHistory] = useState<ApprovalActionOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [editingReq, setEditingReq] = useState(false)
  // Shown after saving edits to a request that's still sitting in Draft --
  // same "nothing has actually been submitted yet" reminder as the one shown
  // right after creating a brand-new request (see ./index.tsx).
  const [draftNotice, setDraftNotice] = useState(false)
  // Shown right after "Submit / Raise" succeeds -- holds the just-raised
  // request so its linked_*_requests can be read to tell the person exactly
  // which section(s) to go review/submit next (see format.ts::linkedSections).
  const [raisedNotice, setRaisedNotice] = useState<QARequestOut | null>(null)

  const load = useCallback(async () => {
    try {
      const [docs, hist] = await Promise.all([
        api.get<QARequestDocumentOut[]>(`/api/qa-requests/${req.id}/documents`),
        api.get<ApprovalActionOut[]>(`/api/qa-requests/${req.id}/history`),
      ])
      setDocuments(docs); setHistory(hist)
    } catch (err) { setError(err) }
  }, [req.id])

  useEffect(() => { load() }, [load])

  async function act(action: string) {
    setError(null)
    setBusyAction(action)
    try {
      const updated = await api.post<QARequestOut>(`/api/qa-requests/${req.id}/${action}`, {})
      onChanged(updated)
      load()
      if (action === 'submit') setRaisedNotice(updated)
    } catch (err) { setError(err) } finally { setBusyAction(null) }
  }

  const isAdmin = hasRole(user, 'ADMIN')
  const isRequester = (req.requester_id === user?.id) || isAdmin
  const status = req.status

  // Mirrors the backend's own gate on POST .../submit (see routers/
  // qa_requests.py::submit_request) -- surfaced here too so the requester
  // sees exactly what's missing before even clicking the button, instead of
  // only finding out from the error after the fact. Scoped to SAST/DAST
  // only, same as the backend -- Functional/Performance have no
  // submission-time mandatory-checklist gate.
  const requestTypeList = (req.request_types || '').split(',').map((t) => t.trim())
  const pendingMandatory: string[] = []
  if (requestTypeList.includes('SAST')) {
    const checkedSet = new Set(req.draft_sast_checked_items || [])
    pendingMandatory.push(...DEFAULT_SAST_CHECKLIST_ITEMS
      .filter((c) => c.is_mandatory && !checkedSet.has(c.item))
      .map((c) => c.item))
  }
  if (requestTypeList.includes('DAST')) {
    const checkedSet = new Set(req.draft_dast_checked_items || [])
    pendingMandatory.push(...DEFAULT_DAST_CHECKLIST_ITEMS
      .filter((c) => c.is_mandatory && !checkedSet.has(c.item))
      .map((c) => c.item))
  }

  const canSubmit = isRequester && status === 'DRAFT'
  // Mirrors backend GATEWAY_CANCELLABLE_STATUSES -- the gateway can only be
  // cancelled while still Draft (i.e. before it's ever been raised).
  const canCancel = isRequester && GATEWAY_CANCELLABLE_STATUSES.includes(status)
  // Mirrors backend GATEWAY_EDITABLE_STATUSES.
  const canEditRequest = isRequester && GATEWAY_EDITABLE_STATUSES.includes(status)

  const hasLinked = (req.linked_functional_requests?.length > 0) || (req.linked_sast_requests?.length > 0)
    || (req.linked_dast_requests?.length > 0)
    || (req.linked_performance_requests?.length > 0)

  // One row per linked request across all four request types, feeding the
  // "Linked Requests" table below. `path` is that type's own module page --
  // clicking a row closes this gateway modal and navigates there with
  // `?open=<request_id>` so the module page can auto-open that specific
  // request's own detail view (see Functional.tsx/SAST.tsx/DAST.tsx/
  // Performance.tsx's matching `useSearchParams`-based deep-link effect).
  interface LinkedRow { key: string; type: string; request_id: string; status?: string | null; path: string }
  const linkedRows: LinkedRow[] = [
    ...(req.linked_functional_requests || []).map((f) => ({
      key: `func-${f.id}`, type: 'Functional QA', request_id: f.request_id, status: f.status, path: '/functional-requests',
    })),
    ...(req.linked_sast_requests || []).map((s) => ({
      key: `sast-${s.id}`, type: 'SAST', request_id: s.request_id, status: s.status, path: '/sast',
    })),
    ...(req.linked_dast_requests || []).map((d) => ({
      key: `dast-${d.id}`, type: 'DAST', request_id: d.request_id, status: d.status, path: '/dast',
    })),
    ...(req.linked_performance_requests || []).map((p) => ({
      key: `perf-${p.id}`, type: 'Performance', request_id: p.request_id, status: p.status, path: '/performance',
    })),
  ]

  function openLinked(row: LinkedRow) {
    onClose()
    navigate(`${row.path}?open=${encodeURIComponent(row.request_id)}`)
  }

  return (
    <Modal title={`${req.request_id} — ${req.application_name}`} onClose={onClose} wide>
      <div className="tabs">
        {['overview', 'documents', 'history'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <ErrorText error={error} />

      {tab === 'overview' && (
        <div>
          <GatewayPreview activeIndex={gatewayStageIndex(req.status)} />

          <DetailSection title="Status">
            <DetailField label="Status"><Badge status={req.status} /></DetailField>
            <DetailField label="Priority / Risk (per type)">{classificationSummary(req)}</DetailField>
            <DetailField label="Request Type(s)">{req.request_types || '—'}{req.request_type_other ? ` (${req.request_type_other})` : ''}</DetailField>
            <DetailField label="Created">{new Date(req.created_at).toLocaleString()}</DetailField>
            <DetailField label="Last Updated">{new Date(req.updated_at).toLocaleString()}</DetailField>
          </DetailSection>

          <DetailSection title="Application & Change">
            <DetailField label="Application Name">
              {req.application_name || '—'}
              {req.application_master_status === 'PENDING' && (
                <span className="badge badge-yellow" style={{ marginLeft: 8 }}>Pending Approval</span>
              )}
              {req.application_master_status === 'REJECTED' && (
                <span className="badge badge-red" style={{ marginLeft: 8 }}>Rejected — pick a different name</span>
              )}
            </DetailField>
            <DetailField label="Department">{req.department || '—'}</DetailField>
            <DetailField label="Change Request ID(s)">{req.cr_number || '—'}</DetailField>
            <DetailField label="Epic Number">{req.epic_number || '—'}</DetailField>
            <DetailField label="Change Type">{req.change_type || '—'}</DetailField>
            <DetailField label="Vendor / SI Partner">{req.vendor_si_partner || '—'}</DetailField>
            <DetailField label="Technology Stack">{req.technology_stack || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="Environment & Release">
            <DetailField label="Deployment Environment">{req.environment || '—'}</DetailField>
            <DetailField label="Target Promotion Environment">{req.target_promotion_environment || '—'}</DetailField>
            <DetailField label="Release Version / Hash Value">{req.release_version || '—'}</DetailField>
            <DetailField label="Build Number / Hash Value">{req.build_number || '—'}</DetailField>
            <DetailField label="Target Release Date">{req.target_release_date || '—'}</DetailField>
          </DetailSection>

          <DetailSection title="People">
            <DetailField label="Requester">{userName(users, req.requester_id) || '—'}</DetailField>
          </DetailSection>

          {hasLinked && (
            <div style={{ marginTop: 8 }}>
              <div className="section-title">Linked Requests</div>
              <Table
                rowKey="key"
                onRowClick={openLinked}
                columns={[
                  { key: 'type', header: 'Request Type' },
                  { key: 'request_id', header: 'Request Id' },
                  { key: 'status', header: 'Current Status', render: (r) => <Badge status={r.status} /> },
                ]}
                rows={linkedRows}
              />
            </div>
          )}
          {status === 'DRAFT' && (
            <p className="muted small">
              Submitting will raise whichever linked request(s) your selected types call for — nothing shows here
              until then.
            </p>
          )}
          {canSubmit && pendingMandatory.length > 0 && (
            <div style={{
              marginTop: 8, background: '#fffaeb', border: '1px solid #fde68a', borderRadius: 10,
              padding: '10px 14px', color: '#92400e', fontSize: 13,
            }}>
              <strong>Cannot Submit / Raise yet</strong> — the following mandatory Security Readiness checklist
              item(s) must be self-declared ready first (Edit Request):
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {pendingMandatory.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          )}
          {req.remarks && <p><strong>Remarks:</strong> {req.remarks}</p>}

          <div className="actions-panel">
            <div className="section-title" style={{ marginTop: 0 }}>Gateway Actions</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn btn-sm" onClick={() => api.downloadFile(`/api/qa-requests/${req.id}/export`, `${req.request_id}.pdf`)}>
                Export PDF
              </button>
              {canEditRequest && (
                <button className="btn btn-sm" disabled={!!busyAction} onClick={() => setEditingReq(true)}>Edit Request</button>
              )}
              {canSubmit && (
                <button className="btn btn-primary btn-sm" disabled={!!busyAction || pendingMandatory.length > 0}
                        title={pendingMandatory.length > 0 ? 'Complete the mandatory Security Readiness checklist item(s) below first' : undefined}
                        onClick={() => act('submit')}>
                  Submit / Raise
                </button>
              )}
              {canCancel && (
                <button className="btn btn-danger btn-sm" disabled={!!busyAction} onClick={() => act('cancel')}>Cancel Request</button>
              )}
              {!canEditRequest && !canSubmit && !canCancel && (
                <span className="muted small">
                  No gateway actions available — this request has been {(GATEWAY_STATUS_LABELS[status] || status).toLowerCase()}.
                  {hasLinked && ' Manage progress on each linked request\'s own page from here.'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'documents' && (
        <div>
          <Table
            rowKey="id"
            columns={[
              { key: 'file_name', header: 'File' },
              { key: 'file_size', header: 'Size', render: (d) => d.file_size ? `${(d.file_size / 1024).toFixed(1)} KB` : '—' },
              { key: 'uploaded_at', header: 'Uploaded', render: (d) => new Date(d.uploaded_at).toLocaleString() },
              {
                key: 'download', header: '', filterable: false, render: (d) => (
                  <button className="btn btn-sm" onClick={() =>
                    api.downloadFile(`/api/qa-requests/${req.id}/documents/${d.id}/download`, d.file_name)}>
                    Download
                  </button>
                ),
              },
            ]}
            rows={documents}
          />
          <AddDocuments reqId={req.id} onAdded={load} />
        </div>
      )}

      {tab === 'history' && (
        <Table
          rowKey="id"
          columns={[
            { key: 'step_name', header: 'Step' },
            { key: 'decision', header: 'Decision' },
            { key: 'actor_id', header: 'Actor', render: (r) => userName(users, r.actor_id) || '—', filterValue: (r) => userName(users, r.actor_id) || '' },
            { key: 'actor_role', header: 'Role' },
            { key: 'comments', header: 'Comments' },
            { key: 'created_at', header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
          ]}
          rows={history}
        />
      )}

      {editingReq && (
        <NewRequestModal
          editing={req}
          onClose={() => setEditingReq(false)}
          onCreated={(updated) => {
            setEditingReq(false)
            onChanged(updated)
            load()
            if (updated.status === 'DRAFT') setDraftNotice(true)
          }}
        />
      )}

      {draftNotice && (
        <InfoModal title="Saved as Draft" onClose={() => setDraftNotice(false)}>
          <p style={{ marginTop: -4 }}>
            Your changes have been saved — this request is still a <strong>Draft</strong> and has{' '}
            <strong>not</strong> been raised yet.
          </p>
          <p className="muted small">
            Nothing happens on any Functional/SAST/DAST/Performance request until you click
            "Submit / Raise".
          </p>
        </InfoModal>
      )}

      {raisedNotice && (
        <InfoModal title="Request Raised" onClose={() => setRaisedNotice(null)}>
          <p style={{ marginTop: -4 }}>
            <strong>{raisedNotice.request_id}</strong> has been raised. Each selected request type now has
            its own independent request and workflow — go to the respective section(s) below, review the
            details, and submit each one:
          </p>
          <ul style={{ margin: '10px 0 0', paddingLeft: 20 }}>
            {linkedSections(raisedNotice).map((s) => (
              <li key={s.path} style={{ padding: '3px 0' }}>
                <Link to={s.path} onClick={() => setRaisedNotice(null)}>{s.label}</Link>
              </li>
            ))}
          </ul>
        </InfoModal>
      )}
    </Modal>
  )
}
