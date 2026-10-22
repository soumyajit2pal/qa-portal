import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { RetestOutcomeOut, TestExecutionOut } from '../types'
import { hasRetestEligibleHistory } from '../constants'
import { defectEvidenceError } from '../defectEvidence'
import { ErrorText, Field, Modal, WarningNotice } from './Common'
import ExecutionEvidenceFields from './ExecutionEvidenceFields'
import { AuthenticatedMarkdown } from './JiraActivity'

interface Candidate {
  defect_id?: number; external_link_id?: number; defect_key: string; status: string; revision?: number
  can_verify?: boolean; can_record_pass: boolean; can_record_failure: boolean
  ready_for_retest: boolean; awaiting_fix: boolean; approved_disposition: boolean
}
interface Observation extends RetestOutcomeOut {
  run_id: number; attempt_no: number; tested_build: string; current_context: boolean; can_verify: boolean
}
interface Context {
  run_version: number; environment: string; tested_build: string; defects: Candidate[]
  observations: Observation[]; can_finalize: boolean; can_record_testcase: boolean
  can_use_standard_results?: boolean; verification_gaps?: { defect_key: string; message: string }[]
}
/** Older hints must not reintroduce result-entry locks. */
export function normalizeRetestContext(value: Context): Context {
  return { ...value, defects: value.defects.map(row => ({ ...row, ready_for_retest: true,
    awaiting_fix: false, can_record_pass: true, can_record_failure: true })),
    observations: value.observations || [], verification_gaps: value.verification_gaps || [],
    can_record_testcase: true, can_use_standard_results: false }
}
const key = (row: { defect_id?: number | null; external_link_id?: number | null }) => row.defect_id ? `internal:${row.defect_id}` : `external:${row.external_link_id}`
export default function ExecutionRetest({ execution, disabled = false, onChanged, inline = false, initialOpen = false, hideLauncher = false }: {
  execution: TestExecutionOut; disabled?: boolean; onChanged: (saved: TestExecutionOut) => void | Promise<void>
  inline?: boolean; initialOpen?: boolean; hideLauncher?: boolean
}) {
  const [open, setOpen] = useState(inline || initialOpen)
  const [current, setCurrent] = useState(execution)
  const [context, setContext] = useState<Context | null>(null)
  const [observed, setObserved] = useState(''), [actual, setActual] = useState(''), [build, setBuild] = useState(''), [reference, setReference] = useState('')
  const [values, setValues] = useState<Record<string, { selected: boolean; outcome: string; notes: string; evidence_reference: string }>>({})
  const [files, setFiles] = useState<File[]>([]), [images, setImages] = useState<File[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [savedNotice, setSavedNotice] = useState(''), [retry, setRetry] = useState(0)
  const submitting = useRef(false)
  useEffect(() => { setCurrent(execution) }, [execution])
  useEffect(() => {
    if (!open) return
    let active = true
    setError(null)
    Promise.all([api.getFresh<Context>(`/api/test-execution/executions/${execution.id}/retest-context`),
      api.getFresh<TestExecutionOut>(`/api/test-execution/executions/${execution.id}`)])
      .then(([result, fresh]) => { if (active) { setCurrent(fresh); setContext(normalizeRetestContext(result)); setBuild(value => value || result.tested_build || '') } })
      .catch(reason => { if (active) setError(reason) })
    return () => { active = false }
  }, [open, execution.id, retry])
  const selected = context?.defects.filter(row => values[key(row)]?.selected) || []
  function update(row: Candidate, patch: Partial<{ selected: boolean; outcome: string; notes: string; evidence_reference: string }>) {
    setValues(previous => ({ ...previous, [key(row)]: { ...(previous[key(row)] || { selected: false, outcome: '', notes: '', evidence_reference: '' }), ...patch } }))
  }
  async function save() {
    if (submitting.current || !context || !observed) return
    const invalid = defectEvidenceError([...images, ...files])
    if (invalid) { setError(new Error(invalid)); return }
    submitting.current = true; setBusy(true); setError(null); setSavedNotice('')
    try {
      const saved = await api.uploadFormFiles<TestExecutionOut>(`/api/test-execution/executions/${execution.id}/rich-retest`, {
        payload: JSON.stringify({ expected_run_version: context.run_version, observed_result: observed,
          actual_result: actual.trim(), tested_build: build.trim(), evidence_reference: reference.trim(),
          outcomes: selected.map(row => ({ defect_id: row.defect_id, external_link_id: row.external_link_id,
            expected_defect_revision: row.revision, outcome: values[key(row)].outcome || (observed === 'NA' ? 'Not tested' : observed),
            notes: values[key(row)].notes || undefined, evidence_reference: values[key(row)].evidence_reference || undefined })) }),
      }, [...images, ...files])
      setCurrent(saved); setFiles([]); setImages([]); setActual(''); setObserved(''); setReference(''); setValues({})
      setContext(previous => previous ? { ...previous, run_version: saved.run_version, verification_gaps: saved.verification_gaps } : previous)
      setSavedNotice(`Result saved as ${saved.status}. Defect workflow statuses are unchanged.`)
      await onChanged(saved)
      setContext(normalizeRetestContext(await api.getFresh<Context>(`/api/test-execution/executions/${execution.id}/retest-context`)))
    } catch (reason) { setError(reason) } finally { submitting.current = false; setBusy(false) }
  }
  if (!hasRetestEligibleHistory(execution.runs, execution.status)) return null
  const content = <>
    <ErrorText error={error} />
    {!!error && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setRetry(value => value + 1)}>Refresh execution details</button>}
    {!context && !error && <p role="status">Loading execution details…</p>}
    {savedNotice && <p role="status">{savedNotice}</p>}
    {!!context?.verification_gaps?.length && <WarningNotice title="Verification gaps">
      <p>You can save the actual result. These gaps remain visible for review in reports and QA certificates.</p>
      <ul>{context.verification_gaps.map((gap, index) => <li key={`${gap.defect_key}:${index}`}><strong>{gap.defect_key}</strong> · {gap.message}</li>)}</ul>
    </WarningNotice>}
    {context && <details><summary>Linked findings and previous results ({context.defects.length})</summary>
      {context.defects.map(row => {
        const proof = context.observations.find(item => key(item) === key(row))
        const result = proof && current.runs?.find(run => run.id === proof.run_id)?.actual_result
        return <div key={key(row)} className="tm-retest-finding"><strong>{row.defect_key}</strong> · {row.status}
          {proof && <div>Attempt #{proof.attempt_no} · {proof.outcome} · {proof.tested_build}
            <span> · {proof.verification_valid && proof.current_context ? 'QA coverage recorded' : 'Verification pending'}</span>
            {result && <AuthenticatedMarkdown value={result} basePath={`/api/test-execution/executions/${execution.id}/runs/${proof.run_id}/images`} />}
            {proof.notes && <p>{proof.notes}</p>}
          </div>}
        </div>
      })}
    </details>}
    {context && !disabled && <form onSubmit={event => { event.preventDefault(); void save() }}>
      <h4>Record result</h4>
      <p className="muted small">Test environment: {context.environment}. Save what happened in this attempt; linked defect status and verification are tracked separately.</p>
      <Field label="Result *"><select required value={observed} disabled={busy} onChange={event => setObserved(event.target.value)}>
        <option value="" disabled>Select result…</option>{['Passed','Failed','Blocked','NA'].map(result => <option key={result}>{result}</option>)}
      </select></Field>
      <Field label="Tested build *"><input required value={build} maxLength={150} disabled={busy} onChange={event => setBuild(event.target.value)} /></Field>
      {!!context.defects.length && <details className="tm-retest-selection"><summary>Findings tested in this attempt (optional)</summary>
        {context.defects.map(row => <div key={key(row)}><label><input type="checkbox" disabled={busy} checked={!!values[key(row)]?.selected} onChange={event => update(row, { selected: event.target.checked })} /> {row.defect_key} · {row.status}</label>
          {values[key(row)]?.selected && <><Field label={`Outcome for ${row.defect_key}`}><select value={values[key(row)].outcome} disabled={busy} onChange={event => update(row, { outcome: event.target.value })}>
            <option value="">Use testcase result</option><option>Passed</option><option>Failed</option><option>Blocked</option><option>Not tested</option>
          </select></Field><Field label={`Details for ${row.defect_key}`}><textarea disabled={busy} value={values[key(row)].notes} onChange={event => update(row, { notes: event.target.value })} /></Field></>}
        </div>)}
      </details>}
      <ExecutionEvidenceFields key={current.run_version} actual={actual} onActual={setActual} onImages={setImages} files={files} onFiles={setFiles} reference={reference} onReference={setReference} disabled={busy} />
      <button className="btn btn-primary" disabled={busy || !observed || !actual.trim() || !build.trim() || actual.length > 10000}>{busy ? 'Saving…' : 'Save result'}</button>
    </form>}
  </>
  return <>{!inline && !hideLauncher && <button type="button" className="tm-play-button" disabled={disabled} onClick={event => { event.stopPropagation(); setOpen(true) }}>▶ Run</button>}
    {inline ? content : open && <Modal title="Record Result" onClose={() => { if (!busy) setOpen(false) }} closeDisabled={busy} wide>{content}</Modal>}
  </>
}
