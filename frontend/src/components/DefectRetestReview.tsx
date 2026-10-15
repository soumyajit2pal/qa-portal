import React, { useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { DefectOut, TestExecutionOut } from '../types'
import { ErrorText } from './Common'
import SearchableSelect from './SearchableSelect'
import ExecutionRetest from './ExecutionRetest'

/** The defect reviewer uses the same evidence and confirmation as the runner. */
export default function DefectRetestReview({ defect, onChanged }: { defect: DefectOut; onChanged: (defect: DefectOut) => void }) {
  const { user } = useAuth()
  const ids = [...new Set([defect.execution_id, ...defect.execution_links.map(link => link.execution_id)].filter((id): id is number => !!id))]
  const [selected, setSelected] = useState('')
  const [execution, setExecution] = useState<TestExecutionOut | null>(null)
  const [launch, setLaunch] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  if (!ids.length) return null
  async function open() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const saved = await api.getFresh<TestExecutionOut>(`/api/test-execution/executions/${selected || ids[0]}`)
      setExecution(saved); setLaunch(value => value + 1)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return <section>
    {ids.length > 1 && <SearchableSelect value={selected || String(ids[0])} onChange={setSelected} disabled={busy}
      ariaLabel="Linked testcase execution" options={ids.map(id => ({ value: String(id), label: `Execution #${id}` }))} />}
    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { void open() }}>Review testcase retests</button>
    <ErrorText error={error} />
    {execution && <ExecutionRetest key={`${execution.id}:${launch}`} execution={execution} initialOpen hideLauncher
      disabled={execution.assigned_to_id !== user?.id} onChanged={async saved => {
        setExecution(saved)
        onChanged(await api.getFresh<DefectOut>(`/api/defects/${defect.id}`))
      }} />}
  </section>
}
