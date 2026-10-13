import React, { useState } from 'react'
import { api } from '../../api'
import { ErrorText, Field, Modal } from '../../components/Common'
import type { TestExecutionOut, TestRunDefectOut } from '../../types'

export default function ExternalDefectStatusModal({ executionId, link, onClose, onSaved }: {
  executionId: number
  link: TestRunDefectOut
  onClose: () => void
  onSaved: (execution: TestExecutionOut) => void
}) {
  const [status, setStatus] = useState(link.defect_status || 'Open')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !reason.trim()) return
    setBusy(true); setError(null)
    try {
      const saved = await api.patch<TestExecutionOut>(
        `/api/test-execution/executions/${executionId}/runs/${link.run_id}/defects/${link.id}`,
        { defect_status: status, expected_status: link.defect_status ?? null, reason: reason.trim() })
      onSaved(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return <Modal title={`Update external defect ${link.defect_key}`} onClose={onClose} closeDisabled={busy} preventBackdropClose variant="dialog">
    <form onSubmit={save}>
      <p>Record the status confirmed in the external tracker. Resolved or Closed releases this reference for retesting. Other linked defects must also clear.</p>
      <Field label="External status *"><select required disabled={busy} value={status} onChange={event => setStatus(event.target.value)}>
        {!['Open', 'In Progress', 'Resolved', 'Closed', 'Reopened'].includes(status) && <option value={status}>{status}</option>}
        {['Open', 'In Progress', 'Resolved', 'Closed', 'Reopened'].map(value => <option key={value}>{value}</option>)}
      </select></Field>
      <Field label="Reason / external tracker reference *"><textarea required maxLength={2000} disabled={busy}
        value={reason} onChange={event => setReason(event.target.value)} rows={3} /></Field>
      <ErrorText error={error} />
      <div className="modal-actions"><button className="btn btn-primary" disabled={busy || !reason.trim() || status === link.defect_status}>
        {busy ? 'Saving…' : 'Save status'}</button><button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>
}
