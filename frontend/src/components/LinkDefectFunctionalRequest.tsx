import React, { useState } from 'react'
import { api } from '../api'
import { DefectOut } from '../types'
import { ErrorText, Field, Modal, WarningNotice } from './Common'
import ConfirmModal from './ConfirmModal'
import FunctionalRequestSelect from './FunctionalRequestSelect'

export default function LinkDefectFunctionalRequest({ defect, onChanged }: { defect: DefectOut; onChanged: (defect: DefectOut) => void }) {
  const [open, setOpen] = useState(false)
  const [requestId, setRequestId] = useState('')
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const duplicate = (defect.functional_requests || []).some(request => String(request.id) === requestId)
  async function save() {
    if (!requestId || !reason.trim() || duplicate || busy) return
    setBusy(true); setError(null)
    try {
      const saved = await api.post<DefectOut>(`/api/defects/${defect.id}/link-functional-request`, {
        functional_request_id: Number(requestId), reason: reason.trim(), revision: defect.workflow_revision || 0, confirmation: true,
      })
      setConfirm(false); setOpen(false); onChanged(saved)
    } catch (err) { setConfirm(false); setError(err) } finally { setBusy(false) }
  }
  return <><button type="button" className="btn btn-sm" onClick={() => { setRequestId(''); setReason(''); setError(null); setOpen(true) }}>Link Functional Request</button>
    {open && <Modal title="Link Functional Request" onClose={() => { if (!busy) { setConfirm(false); setOpen(false) } }}>
      <WarningNotice title="Traceability link">This records which Functional Request the defect belongs to. Execution evidence and fresh retest checks are still required. Closure, ownership and issued certificates remain unchanged.</WarningNotice>
      <Field label="Functional Request *"><FunctionalRequestSelect value={requestId} onChange={value => { setRequestId(value); setConfirm(false) }} defectId={defect.id} disabled={busy} /></Field>
      {duplicate && <WarningNotice title="Already linked" compact>This request is already linked directly or through an execution.</WarningNotice>}
      <Field label="Reason for linking *"><textarea value={reason} maxLength={2000} disabled={busy} onChange={e => { setReason(e.target.value); setConfirm(false) }} /></Field>
      <ErrorText error={error} />
      <button type="button" className="btn btn-primary" disabled={busy || !requestId || !reason.trim() || duplicate} onClick={() => setConfirm(true)}>Review link</button>
      {confirm && <ConfirmModal title="Confirm Functional Request link" tone="warning" busy={busy}
        message={<p>Link {defect.defect_key} to the selected Functional Request? The reason and your name will be retained in both audit histories. The defect keeps its lifecycle and retest requirements.</p>}
        confirmLabel={busy ? 'Linking…' : 'Confirm link'} cancelLabel="Cancel" onConfirm={() => { void save() }} onCancel={() => { if (!busy) setConfirm(false) }} />}
    </Modal>}
  </>
}
