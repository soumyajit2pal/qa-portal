import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { RetestOutcomeOut, TestExecutionOut } from '../types'
import { hasRetestEligibleHistory } from '../constants'
import { defectEvidenceError } from '../defectEvidence'
import { ErrorText, Field, Modal, WarningNotice } from './Common'
import ConfirmModal from './ConfirmModal'
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
  can_use_standard_results?: boolean
}
const READY_FOR_RETEST = new Set(['Ready for QA','QA Testing','Resolved','Retest','Business Acceptance','Ready for Release','Production Verification','Closed'])
const APPROVED_DISPOSITIONS = new Set(['Deferred','Rejected','Duplicate','Not a Defect','Change Request Raised'])
/** Older responses omit these presentation hints; omission is not a workflow lock. */
export function normalizeRetestContext(value: Context): Context {
  const defects = value.defects.map(row => {
    const status = row.status.trim()
    const disposition = row.approved_disposition ?? APPROVED_DISPOSITIONS.has(status)
    const ready = row.ready_for_retest ?? (!disposition && READY_FOR_RETEST.has(status))
    return { ...row, approved_disposition: disposition, ready_for_retest: ready,
      awaiting_fix: row.awaiting_fix ?? (!disposition && !ready) }
  })
  return { ...value, defects, observations: value.observations || [],
    can_record_testcase: value.can_record_testcase ?? (defects.some(row => row.ready_for_retest) || defects.every(row => row.approved_disposition)) }
}
const key = (row: { defect_id?: number | null; external_link_id?: number | null }) => row.defect_id ? `internal:${row.defect_id}` : `external:${row.external_link_id}`
/** Inline result entry shared with quick execution and the defect review surface. */
export default function ExecutionRetest({ execution, onChanged, disabled = false, initialOpen = false, hideLauncher = false, inline = false }: {
  execution: TestExecutionOut; onChanged: (execution: TestExecutionOut) => void | Promise<void>
  disabled?: boolean; initialOpen?: boolean; hideLauncher?: boolean; inline?: boolean
}) {
  const [open, setOpen] = useState(initialOpen || inline)
  const [current, setCurrent] = useState(execution)
  const [context, setContext] = useState<Context | null>(null)
  const [observed, setObserved] = useState('')
  const [actual, setActual] = useState('')
  const [build, setBuild] = useState('')
  const [reference, setReference] = useState('')
  const [values, setValues] = useState<Record<string, { selected: boolean; outcome: string; notes: string; evidence_reference: string }>>({})
  const [files, setFiles] = useState<File[]>([])
  const [images, setImages] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [confirmation, setConfirmation] = useState<number | 'final' | 'standard' | null>(null)
  useEffect(() => { setCurrent(execution) }, [execution])
  useEffect(() => {
    if (!open) return
    let active = true
    setContext(null); setError(null)
    Promise.all([
      api.getFresh<Context>(`/api/test-execution/executions/${execution.id}/retest-context`),
      api.getFresh<TestExecutionOut>(`/api/test-execution/executions/${execution.id}`),
    ]).then(([result, fresh]) => {
      if (!active) return
      setCurrent(fresh); setContext(normalizeRetestContext(result)); setBuild(result.tested_build || '')
      setValues({})
    }).catch(err => { if (active) setError(err) })
    return () => { active = false }
  }, [open, execution.id])
  async function changed(saved: TestExecutionOut) {
    setCurrent(saved); await onChanged(saved)
    setContext(normalizeRetestContext(await api.getFresh<Context>(`/api/test-execution/executions/${execution.id}/retest-context`)))
  }
  const latest = current.runs?.at(-1)
  const pending = latest?.retest && !latest.retest.final_run_id ? latest.retest : null
  const observations = context?.observations || []
  const selected = context?.defects.filter(row => values[key(row)]?.selected) || []
  function update(row: Candidate, patch: Partial<{ selected: boolean; outcome: string; notes: string; evidence_reference: string }>) {
    setValues(previous => ({ ...previous, [key(row)]: { ...(previous[key(row)] || { selected: false, outcome: '', notes: '', evidence_reference: '' }), ...patch } }))
  }
  async function save() {
    if (busy || !context || !observed) return
    const invalid = defectEvidenceError([...images, ...files])
    if (invalid) { setError(new Error(invalid)); return }
    setBusy(true); setError(null)
    try {
      const saved = await api.uploadFormFiles<TestExecutionOut>(`/api/test-execution/executions/${execution.id}/rich-retest`, {
        payload: JSON.stringify({ expected_run_version: context.run_version, observed_result: observed,
          actual_result: actual.trim(), tested_build: build.trim(), evidence_reference: reference.trim(),
          outcomes: selected.map(row => ({ defect_id: row.defect_id, external_link_id: row.external_link_id,
            expected_defect_revision: row.revision, outcome: values[key(row)].outcome || observed,
            notes: values[key(row)].notes || undefined, evidence_reference: values[key(row)].evidence_reference || undefined })) }),
      }, [...images, ...files])
      setCurrent(saved); setFiles([]); setImages([]); setActual(''); setObserved(''); setReference(''); setValues({})
      await changed(saved)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  async function confirm() {
    if (busy || confirmation === null || !context) return
    setBusy(true); setError(null)
    try {
      if (confirmation === 'standard') {
        const saved = await api.patch<TestExecutionOut>(`/api/test-execution/executions/${execution.id}`, {
          status: 'Retest Passed', expected_run_version: context.run_version,
        })
        setConfirmation(null); await changed(saved)
        return
      }
      const row = observations.find(outcome => outcome.id === confirmation)
      const candidate = context.defects.find(defect => defect.defect_id === row?.defect_id)
      const path = `/api/test-execution/executions/${execution.id}/retests/${confirmation === 'final' ? pending?.run_id : row?.run_id}`
      const saved = await api.post<TestExecutionOut>(confirmation === 'final' ? `${path}/finalize` : `${path}/outcomes/${confirmation}/verify`,
        confirmation === 'final' ? { expected_run_version: current.run_version, verification_confirmed: true }
          : { expected_defect_revision: candidate?.revision, verification_confirmed: true })
      setConfirmation(null); await changed(saved)
    } catch (err) { setConfirmation(null); setError(err) } finally { setBusy(false) }
  }
  async function download(row: Observation, doc: { id: number; file_name: string }) {
    try { await api.downloadFile(`/api/test-execution/executions/${execution.id}/runs/${row.run_id}/images/${doc.id}/download`, doc.file_name) }
    catch (err) { setError(err) }
  }
  if (!hasRetestEligibleHistory(execution.runs, execution.status)) return null
  const content = <>
    <ErrorText error={error} />
    {!context && !error && <p>Loading execution details…</p>}
    {context && <section>
      <h4>Linked findings</h4>
      {context.defects.map(row => {
        const proof = observations.find(item => key(item) === key(row))
        const actualResult = proof && current.runs?.find(run => run.id === proof.run_id)?.actual_result
        return <div key={key(row)} className="tm-retest-finding">
          <strong>{row.defect_key}</strong> · {row.status}
          {row.awaiting_fix && <span className="badge badge-gray">Awaiting fix</span>}
          {row.approved_disposition && <span className="muted"> · Approved disposition</span>}
          {proof && <div><span>Attempt #{proof.attempt_no} · {proof.outcome} · {proof.tested_build}</span>
            <span> · {proof.verification_valid && proof.current_context ? 'Verification satisfied; evidence reused' : proof.current_context ? 'Verification pending' : 'Fresh retest required'}</span>
            {actualResult && <details><summary>View actual result</summary><AuthenticatedMarkdown value={actualResult}
              basePath={`/api/test-execution/executions/${execution.id}/runs/${proof.run_id}/images`} /></details>}
            {proof.notes && <p>{proof.notes}</p>}{proof.evidence_reference && <p>Evidence: {proof.evidence_reference}</p>}
            {proof.evidence_documents.map(doc => <button type="button" className="btn btn-sm" key={doc.id} onClick={() => { void download(proof, doc) }}>{doc.file_name}</button>)}
            {proof.can_verify && !proof.verification_valid && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmation(proof.id)}>Verify {row.defect_key}</button>}
          </div>}
        </div>
      })}
      {context.can_use_standard_results && !disabled && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setConfirmation('standard')}>Retest Passed</button>}
      {!context.can_use_standard_results && !context.can_record_testcase && <WarningNotice title={context.defects.some(row => row.awaiting_fix) ? 'Awaiting fix' : 'Verification required'}>
        {context.defects.some(row => row.awaiting_fix)
          ? 'No linked fix is ready for retest. The current execution result is retained. Record a result here after a fix is submitted for QA.'
          : 'Execution entry is unavailable in the current context. Refresh the execution and review the linked verification requirements.'}
      </WarningNotice>}
      {pending?.observed_result === 'Passed' && !disabled && <button type="button" className="btn btn-primary" disabled={busy || !context.can_finalize} onClick={() => setConfirmation('final')}>Confirm final retest</button>}
      {pending && !context.can_finalize && <p className="muted">Final pass remains pending until every required linked finding has valid verification.</p>}
    </section>}
    {context?.can_record_testcase && !context.can_use_standard_results && !disabled && <form onSubmit={event => { event.preventDefault(); void save() }}>
      <h4>Log New Attempt</h4>
      <Field label="Result *"><select required value={observed} disabled={busy} onChange={event => setObserved(event.target.value)}>
        <option value="" disabled>Select result…</option>{['Passed','Failed','Blocked'].map(result => <option key={result}>{result}</option>)}
      </select></Field>
      <small className="muted">Result for the scope tested in this attempt. Untouched findings retain their status and valid evidence.</small>
      <Field label="Tested build *"><input required value={build} maxLength={150} disabled={busy} onChange={event => setBuild(event.target.value)} /></Field>
      <div className="tm-retest-selection"><strong>Select the fixes tested</strong>
        {context.defects.filter(row => row.ready_for_retest).map(row => <div key={key(row)}>
          <label><input type="checkbox" disabled={busy} checked={!!values[key(row)]?.selected} onChange={event => update(row, { selected: event.target.checked })} /> {row.defect_key}</label>
          {values[key(row)]?.selected && <details><summary>Different outcome or specific details (optional)</summary>
            <Field label={`Outcome for ${row.defect_key}`}><select value={values[key(row)].outcome} disabled={busy} onChange={event => update(row, { outcome: event.target.value })}>
              <option value="">Use attempt result</option><option disabled={!row.can_record_pass}>Passed</option><option disabled={!row.can_record_failure}>Failed</option><option>Blocked</option>
            </select></Field>
            <Field label={`Details for ${row.defect_key}`}><textarea value={values[key(row)].notes} disabled={busy} onChange={event => update(row, { notes: event.target.value })} /></Field>
            <Field label={`Evidence for ${row.defect_key}`}><input value={values[key(row)].evidence_reference} disabled={busy} onChange={event => update(row, { evidence_reference: event.target.value })} /></Field>
          </details>}
        </div>)}
      </div>
      <ExecutionEvidenceFields key={current.run_version} actual={actual} onActual={setActual} onImages={setImages} files={files} onFiles={setFiles} reference={reference} onReference={setReference} disabled={busy} />
      <button className="btn btn-primary" disabled={busy || !observed || !actual.trim() || !build.trim() || actual.length > 10000}>{busy ? 'Saving…' : 'Save Attempt'}</button>
    </form>}
    {confirmation !== null && <ConfirmModal busy={busy} title={confirmation === 'final' || confirmation === 'standard' ? 'Confirm final testcase pass' : 'Confirm fresh fix verification'} tone="warning"
      message={confirmation === 'final' || confirmation === 'standard' ? 'Confirm you have freshly retested this testcase and it passed. All linked-defect checks must be satisfied; valid evidence from partial retests is retained.' : 'Confirm you have freshly verified this specific defect against the recorded build and evidence. Required later business and production stages remain in place.'}
      confirmLabel="Confirm verification" cancelLabel="Cancel" onConfirm={() => { void confirm() }} onCancel={() => { if (!busy) setConfirmation(null) }} />}
  </>
  return <>{!inline && !hideLauncher && <button type="button" className="tm-play-button" disabled={disabled && !context?.observations.some(row => row.can_verify)} onClick={event => { event.stopPropagation(); setOpen(true) }}>▶ Run</button>}
    {inline ? content : open && <Modal title="Record Result" onClose={() => { if (!busy) { setConfirmation(null); setOpen(false) } }} wide>{content}</Modal>}
  </>
}
