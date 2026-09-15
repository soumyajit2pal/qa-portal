import DefectWorkflowDiagram from './DefectWorkflowDiagram'
import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { DefectWorkflowPolicy, QAWorkspaceOut } from '../types'
import { ErrorText, Field } from './Common'
import ConfirmModal from './ConfirmModal'

const WORKFLOW_TEMPLATES = [
  { id: 'sit-uat', name: 'SIT + UAT', qa_environment: 'SIT', business_acceptance: true, business_environment: 'UAT', description: 'QA verifies the fix in SIT, then business users accept it in UAT.' },
  { id: 'uat-only', name: 'UAT Only', qa_environment: 'UAT', business_acceptance: false, business_environment: 'UAT', description: 'QA verifies the fix in UAT. No separate business acceptance stage is required.' },
  { id: 'qa-business-uat', name: 'QA + Business in UAT', qa_environment: 'UAT', business_acceptance: true, business_environment: 'UAT', description: 'QA and business users record separate verification results in UAT.' },
] as const

export default function WorkspaceDefectWorkflow({ workspace }: { workspace: QAWorkspaceOut }) {
  const [value, setValue] = useState<DefectWorkflowPolicy>(workspace.defect_workflow)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const [history, setHistory] = useState<DefectWorkflowPolicy[]>([])
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  const [restore, setRestore] = useState<DefectWorkflowPolicy | null>(null)
  const [historyError, setHistoryError] = useState<unknown>(null)
  const [publishedVersion, setPublishedVersion] = useState(workspace.defect_workflow?.version)
  useEffect(() => {
    setPublishedVersion(workspace.defect_workflow?.version)
    setSelectedVersion(null); setRestore(null)
  }, [workspace.id, workspace.defect_workflow])
  useEffect(() => {
    let active = true
    setHistory([]); setHistoryError(null)
    api.get<DefectWorkflowPolicy[]>(`/api/workspaces/${workspace.id}/defect-workflow/history`)
      .then(result => { if (active) setHistory(result) })
      .catch(err => { if (active) setHistoryError(err) })
    return () => { active = false }
  }, [workspace.id, publishedVersion])
  useEffect(() => { setValue(workspace.defect_workflow); setSaved(false) }, [workspace.id, workspace.defect_workflow])
  if (!value) return null
  const selectedTemplate = WORKFLOW_TEMPLATES.find(template =>
    template.qa_environment === value.qa_environment
    && template.business_acceptance === value.business_acceptance
    && (!value.business_acceptance || template.business_environment === value.business_environment))
  function applyTemplate(id: string) {
    const template = WORKFLOW_TEMPLATES.find(item => item.id === id)
    if (!template) return
    setValue({ ...value, qa_environment: template.qa_environment,
      business_acceptance: template.business_acceptance, business_environment: template.business_environment })
    setSaved(false)
  }
  const set = (key: keyof DefectWorkflowPolicy, v: string | boolean) => { setValue({ ...value, [key]: v }); setSaved(false) }
  async function publish(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      const result = await api.put<QAWorkspaceOut>(`/api/workspaces/${workspace.id}/defect-workflow`, value)
      setValue(result.defect_workflow); setPublishedVersion(result.defect_workflow.version); setSaved(true)
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  async function restoreVersion() {
    if (!restore || busy) return
    setBusy(true); setError(null)
    try {
      const result = await api.put<QAWorkspaceOut>(`/api/workspaces/${workspace.id}/defect-workflow`, { ...restore, version: publishedVersion })
      setValue(result.defect_workflow); setPublishedVersion(result.defect_workflow.version)
      setSaved(true); setSelectedVersion(result.defect_workflow.version); setRestore(null)
    } catch (err) { setError(err); setRestore(null) } finally { setBusy(false) }
  }
  const preview = history.find(item => item.version === selectedVersion)
  return <section className="workflow-panel"><h4>Defect workflow · version {value.version}</h4>
    <p>Configure testing for new defects in this workspace. Existing defects keep their original workflow version.</p>
    <details className="workflow-version-history"><summary>Version history · view or restore earlier settings</summary>
      <p>Restoring publishes the selected settings as a new version for future defects. Existing defects are unchanged.</p>
      <ErrorText error={historyError} />
      {!history.length && !historyError && <p role="status">Loading version history…</p>}
      {history.length > 0 && <Field label="View published version"><select disabled={busy} value={selectedVersion ?? ''} onChange={event => setSelectedVersion(event.target.value ? Number(event.target.value) : null)}><option value="">Select a version…</option>{history.map(item => <option key={item.version} value={item.version}>Version {item.version}{item.version === publishedVersion ? ' · Current' : ''}</option>)}</select></Field>}
      {preview && <div className="workflow-version-preview">
        <h4>Version {preview.version} settings {preview.version === publishedVersion ? '(current)' : ''}</h4>
        <dl><dt>QA testing</dt><dd>{preview.qa_environment}</dd><dt>Business acceptance</dt><dd>{preview.business_acceptance ? `Required in ${preview.business_environment}` : 'Not required'}</dd><dt>Production verification</dt><dd>{preview.production_for_all ? 'Required for every fixed defect' : 'Required when production is affected'}</dd></dl>
        <DefectWorkflowDiagram policy={preview} workspaceName={workspace.name} />
        {preview.version !== publishedVersion && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setRestore(preview)}>Restore version {preview.version} as a new version</button>}
      </div>}
    </details>
    {restore && <ConfirmModal title={`Restore version ${restore.version}?`} message={<p>This will publish version {(publishedVersion || 0) + 1} using version {restore.version} settings for new defects. Existing defects keep their original workflow. Any unpublished settings in this editor will be replaced.</p>} confirmLabel="Restore as new version" cancelLabel="Cancel" busy={busy} onConfirm={restoreVersion} onCancel={() => { if (!busy) setRestore(null) }} />}
    <form onSubmit={publish}>
      <Field label="Workflow template"><select value={selectedTemplate?.id || 'custom'} disabled={busy} onChange={e => applyTemplate(e.target.value)}>
        {!selectedTemplate && <option value="custom">Custom configuration</option>}
        {WORKFLOW_TEMPLATES.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
      </select></Field>
      <p>{selectedTemplate?.description || 'Testing stages use the individual settings below.'} Selecting a template updates this draft; publish to apply it to new defects. The production verification policy is retained.</p>
      <div className="workflow-fields">
        <Field label="QA testing environment"><select value={value.qa_environment} onChange={e => set('qa_environment', e.target.value)}>{['Dev', 'SIT', 'UAT', 'Pre-Production'].map(x => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Separate business acceptance"><select value={String(value.business_acceptance)} onChange={e => set('business_acceptance', e.target.value === 'true')}><option value="false">Not required</option><option value="true">Required</option></select></Field>
        {value.business_acceptance && <Field label="Business acceptance environment"><select value={value.business_environment} onChange={e => set('business_environment', e.target.value)}>{['UAT', 'Pre-Production'].map(x => <option key={x}>{x}</option>)}</select></Field>}
        <Field label="Production verification"><select value={String(value.production_for_all)} onChange={e => set('production_for_all', e.target.value === 'true')}><option value="false">Required when production is affected</option><option value="true">Required for every fixed defect</option></select></Field>
      </div>
      <DefectWorkflowDiagram policy={value} workspaceName={workspace.name} draft />
      <ErrorText error={error} />
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Publishing…' : 'Publish workflow for new defects'}</button>
      {saved && <p role="status">Workflow version {value.version} published.</p>}
    </form>
  </section>
}
