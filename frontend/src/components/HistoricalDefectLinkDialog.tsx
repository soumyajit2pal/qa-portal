import React, { useEffect, useState } from 'react'
import { api, HttpError } from '../api'
import { ErrorText, Field, Modal, WarningNotice } from './Common'
import ConfirmModal from './ConfirmModal'
import SearchableSelect from './SearchableSelect'
import { formatDateTimeIST } from '../time'
import type { DefectOut, DefectLinkableExecutionOut } from '../types'

export default function HistoricalDefectLinkDialog({ defectId, defectKey, executionId, initialRunId, onClose, onLinked }: {
  defectId: number; defectKey: string; executionId?: number; initialRunId?: number;
  onClose: () => void; onLinked: (updated: DefectOut) => void | Promise<void>
}) {
  const [defect, setDefect] = useState<DefectOut | null>(null)
  const [contexts, setContexts] = useState<DefectLinkableExecutionOut[]>([])
  const [selectedExecution, setSelectedExecution] = useState(executionId ? String(executionId) : '')
  const [runId, setRunId] = useState(initialRunId ? String(initialRunId) : '')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [confirm, setConfirm] = useState(false)
  const context = contexts.find(item => item.execution.id === Number(selectedExecution))
  const alreadyLinked = new Set((defect?.historical_execution_links || []).map(item => item.run_id))
  const attempts = (context?.execution.runs || []).filter(run => ['Fail', 'Blocked'].includes(run.status)
    && !alreadyLinked.has(run.id) && !(run.defects || []).some(link => link.defect_key === defectKey)
    && (!defect?.closed_at || !run.executed_at || Date.parse(run.executed_at) <= Date.parse(defect.closed_at)))
  const selectedRun = attempts.find(run => run.id === Number(runId))

  async function load() {
    setLoading(true); setError(null); setConfirm(false)
    try {
      const latest = await api.getFresh<DefectOut>(`/api/defects/${defectId}`)
      setDefect(latest)
      if (latest.status !== 'Closed') throw new Error('This defect is no longer Closed. Refresh the defect and use active linking for a current issue.')
      const params = new URLSearchParams({ include_history: 'true', application_name: latest.application_name })
      if (executionId) params.set('execution_id', String(executionId))
      setContexts(await api.getFresh<DefectLinkableExecutionOut[]>(`/api/test-execution/executions/blocked-or-failed?${params}`))
    } catch (err) { setError(err); setContexts([]) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [defectId, executionId])

  async function save() {
    if (!defect || !selectedRun || !reason.trim() || !confirm) return
    setBusy(true); setError(null)
    let saved = false
    try {
      const updated = await api.post<DefectOut>(`/api/defects/${defectId}/link-execution`, {
        execution_id: Number(selectedExecution), run_id: selectedRun.id, link_type: 'HISTORICAL',
        reason: reason.trim(), expected_revision: defect.workflow_revision || 0, confirmation: true,
      })
      saved = true; setDefect(updated); setConfirm(false); await onLinked(updated)
    } catch (err) {
      setConfirm(false)
      if (saved) setError(new Error('The historical link was saved, but the execution view could not refresh. Refresh the execution details to see it.'))
      else {
        setError(err)
        if (err instanceof HttpError && err.status === 409) setDefect(null)
      }
    } finally { setBusy(false) }
  }

  return <Modal title={`Link Closed defect ${defectKey} for history`} onClose={onClose} closeDisabled={busy} variant="dialog" compact preventBackdropClose>
    <WarningNotice title="Historical reference only">This adds traceability to the original failed or blocked attempt. It preserves defect closure, evidence, ownership and testcase results. A recurring issue needs an active or reopened defect; passing still requires a fresh retest.</WarningNotice>
    <ErrorText error={error} />
    {loading ? <p>Loading eligible historical attempts…</p> : <>
      <Field label="Test Cycle / Test Case *"><SearchableSelect value={selectedExecution} disabled={busy || !!executionId} onChange={value => { setSelectedExecution(value); setRunId(''); setConfirm(false) }} placeholder="Select execution with a Failed or Blocked attempt…" options={contexts.map(item => ({ value:String(item.execution.id), label:`${item.cycle.cycle_key} · ${item.execution.test_case?.test_case_key || item.execution.test_case_id} · Current: ${item.execution.status}` }))} /></Field>
      <Field label="Original execution attempt *"><SearchableSelect value={runId} disabled={busy} onChange={value => { setRunId(value); setConfirm(false) }} placeholder="Select original Failed or Blocked attempt…" options={attempts.map(run => ({ value:String(run.id), label:`Attempt #${run.attempt_no} · ${run.status} · ${run.executed_at ? formatDateTimeIST(run.executed_at) : 'Date not recorded'}` }))} /></Field>
      {context && !attempts.length && <p className="muted small">No unlinked Failed or Blocked attempts from before this defect's closure are available.</p>}
      {!contexts.length && <p className="muted small">No eligible execution history is available. A workspace QA Lead must add history to completed or blocked cycles and inactive projects.</p>}
      <Field label="Reason for late linking *"><textarea rows={3} maxLength={2000} disabled={busy} value={reason} onChange={event => { setReason(event.target.value); setConfirm(false) }} placeholder="Explain the missed original association" /></Field>
      <div className="modal-actions"><button type="button" className="btn btn-primary" disabled={busy || !defect || !selectedRun || !reason.trim()} onClick={() => setConfirm(true)}>Link for history</button><button type="button" className="btn" disabled={busy} onClick={() => { setRunId(''); void load() }}>Refresh latest</button></div>
    </>}
    {confirm && <ConfirmModal title="Link Closed defect for history?" tone="warning" busy={busy}
      message={<p>This defect is Closed. Link <strong>{defectKey}</strong> to <strong>Attempt #{selectedRun?.attempt_no}</strong> for historical traceability only. This will not reopen the defect or change the testcase result.</p>}
      confirmLabel="Confirm historical link" cancelLabel="Cancel" onConfirm={() => { void save() }} onCancel={() => setConfirm(false)} />}
  </Modal>
}
