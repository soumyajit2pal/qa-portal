import React, { useEffect, useRef, useState } from 'react'
import { api, HttpError } from '../api'
import { ErrorText, Field, Modal, WarningNotice } from './Common'
import SearchableSelect from './SearchableSelect'
import type { DefectOut, DefectLinkableExecutionOut } from '../types'

/** Shared one-step Closed-defect linking from Defects and execution history. */
export default function HistoricalDefectLinkDialog({ defectId, defectKey, executionId, onClose, onLinked }: {
  defectId: number; defectKey: string; executionId?: number;
  onClose: () => void; onLinked: (updated: DefectOut) => void | Promise<void>
}) {
  const [defect, setDefect] = useState<DefectOut | null>(null)
  const [contexts, setContexts] = useState<DefectLinkableExecutionOut[]>([])
  const [selectedExecution, setSelectedExecution] = useState(executionId ? String(executionId) : '')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const generation = useRef(0)
  const saving = useRef(false)
  const context = contexts.find(item => item.execution.id === Number(selectedExecution))
  const linkedIds = new Set([
    ...(defect?.execution_id ? [defect.execution_id] : []),
    ...(defect?.execution_links || []).map(link => link.execution_id),
    ...(defect?.historical_execution_links || []).map(link => link.execution_id),
    ...(defect?.execution_references || []).map(link => link.execution_id),
  ])
  const available = contexts.filter(item => !linkedIds.has(item.execution.id))

  async function load() {
    const current = ++generation.current
    setLoading(true); setError(null); setDefect(null)
    try {
      const latest = await api.getFresh<DefectOut>(`/api/defects/${defectId}`)
      if (current !== generation.current) return
      if (latest.status !== 'Closed') throw new Error('This defect is no longer Closed. Refresh and use active linking for a current issue.')
      const params = new URLSearchParams({ include_references: 'true', application_name: latest.application_name })
      if (executionId) params.set('execution_id', String(executionId))
      const rows = await api.getFresh<DefectLinkableExecutionOut[]>(`/api/test-execution/executions/blocked-or-failed?${params}`)
      if (current !== generation.current) return
      setDefect(latest); setContexts(rows)
    } catch (err) { if (current === generation.current) { setError(err); setContexts([]) } }
    finally { if (current === generation.current) setLoading(false) }
  }
  useEffect(() => {
    setSelectedExecution(executionId ? String(executionId) : '')
    void load()
    return () => { generation.current++ }
  }, [defectId, executionId])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!defect || !context || linkedIds.has(context.execution.id) || loading || saving.current) return
    saving.current = true; setBusy(true); setError(null)
    let saved = false
    try {
      const updated = await api.post<DefectOut>(`/api/defects/${defectId}/link-execution`, {
        execution_id: Number(selectedExecution), link_type: 'HISTORICAL', expected_revision: defect.workflow_revision || 0,
      })
      saved = true; setDefect(updated); await onLinked(updated)
    } catch (err) {
      if (saved) setError(new Error('The link was saved, but the execution view could not refresh. Refresh the execution details to see it.'))
      else {
        setError(err)
        if (err instanceof HttpError && err.status === 409) setDefect(null)
      }
    } finally { saving.current = false; setBusy(false) }
  }

  return <Modal title={`Link defect ${defectKey}`} onClose={onClose} closeDisabled={busy} variant="dialog" compact preventBackdropClose>
    <WarningNotice title="Closed defect reference">The defect stays Closed. Linking preserves results and evidence and does not verify a fix. Retest requirements still apply.</WarningNotice>
    <ErrorText error={error} />
    {loading ? <p>Loading testcase executions…</p> : <form onSubmit={save}>
      <Field label="Test Cycle / Test Case *"><SearchableSelect value={selectedExecution} disabled={busy || !!executionId} onChange={setSelectedExecution} placeholder="Select testcase execution…" options={available.map(item => ({ value:String(item.execution.id), label:`${item.cycle.cycle_key} · ${item.execution.test_case?.test_case_key || item.execution.test_case_id} · Current: ${item.execution.status}` }))} /></Field>
      {linkedIds.has(Number(selectedExecution)) && <p className="muted small">This defect is already linked to the selected execution.</p>}
      {!available.length && <p className="muted small">No unlinked executions are available in your scope. A workspace QA Lead can link references to completed or blocked cycles and inactive projects.</p>}
      <div className="modal-actions"><button className="btn btn-primary" disabled={busy || !defect || !context || linkedIds.has(Number(selectedExecution))}>{busy ? 'Linking…' : 'Link Defect'}</button><button type="button" className="btn" disabled={busy} onClick={() => { void load() }}>Refresh latest</button></div>
    </form>}
  </Modal>
}
