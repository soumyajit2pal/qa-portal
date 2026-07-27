import React, { useEffect, useState, useCallback } from 'react'
import { api } from '@qa-portal/shared/api'
import { useAuth } from '@qa-portal/shared/context/AuthContext'
import { Card, Table, Badge, Modal, Field, ErrorText, PageHeader, RequestDocuments } from '@qa-portal/shared/components/Common'
import { CERTIFICATE_TYPES, SIGNOFF_TESTING_TYPES, RISK_TIERS, ENVIRONMENTS, hasRole } from '@qa-portal/shared/constants'
import { SignOffOut, UserOut } from '@qa-portal/shared/types'

function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

const EMPTY = {
  certificate_type: 'Full Clearance', testing_type: 'Functional', testing_request_id: '',
  change_request_ids: '', application_name: '', application_owner: '', department: '',
  technology_stack: '', risk_tier: 'Tier 3 (Medium)', release_version: '', build_number: '',
  environment_tested: 'UAT', target_promotion_environment: 'Production',
  exit_criteria_notes: '', open_defect_summary: '', residual_risk_notes: '',
}
type SignOffForm = typeof EMPTY

function NewSignOffModal({ onClose, onCreated }: { onClose: () => void; onCreated: (s: SignOffOut) => void }) {
  const [form, setForm] = useState<SignOffForm>(EMPTY)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  function set<K extends keyof SignOffForm>(k: K, v: SignOffForm[K]) { setForm((f) => ({ ...f, [k]: v })) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try { onCreated(await api.post<SignOffOut>('/api/signoffs', form)) }
    catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="New QA Sign-off Certificate" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Application Name *"><input required value={form.application_name} onChange={(e) => set('application_name', e.target.value)} /></Field>
          <Field label="Application Owner"><input value={form.application_owner} onChange={(e) => set('application_owner', e.target.value)} /></Field>
          <Field label="Department"><input value={form.department} onChange={(e) => set('department', e.target.value)} /></Field>
          <Field label="Testing Request ID"><input value={form.testing_request_id} onChange={(e) => set('testing_request_id', e.target.value)} /></Field>
          <Field label="Change Request ID(s)"><input value={form.change_request_ids} onChange={(e) => set('change_request_ids', e.target.value)} /></Field>
          <Field label="Technology Stack"><input value={form.technology_stack} onChange={(e) => set('technology_stack', e.target.value)} /></Field>
          <Field label="Release Version"><input value={form.release_version} onChange={(e) => set('release_version', e.target.value)} /></Field>
          <Field label="Build Number"><input value={form.build_number} onChange={(e) => set('build_number', e.target.value)} /></Field>
          <Field label="Certificate Type">
            <select value={form.certificate_type} onChange={(e) => set('certificate_type', e.target.value)}>
              {CERTIFICATE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Testing Type">
            <select value={form.testing_type} onChange={(e) => set('testing_type', e.target.value)}>
              {SIGNOFF_TESTING_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Risk Tier">
            <select value={form.risk_tier} onChange={(e) => set('risk_tier', e.target.value)}>
              {RISK_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Environment Tested">
            <select value={form.environment_tested} onChange={(e) => set('environment_tested', e.target.value)}>
              {ENVIRONMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Target Promotion Environment">
            <select value={form.target_promotion_environment} onChange={(e) => set('target_promotion_environment', e.target.value)}>
              {ENVIRONMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Exit Criteria Validation Notes"><textarea value={form.exit_criteria_notes} onChange={(e) => set('exit_criteria_notes', e.target.value)} /></Field>
        <Field label="Open Defect Review Summary"><textarea value={form.open_defect_summary} onChange={(e) => set('open_defect_summary', e.target.value)} /></Field>
        <Field label="Residual Risk Documentation"><textarea value={form.residual_risk_notes} onChange={(e) => set('residual_risk_notes', e.target.value)} /></Field>
        <ErrorText error={error} />
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save Draft Certificate'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function SignOffDetail({ item, onClose, onChanged, users }: { item: SignOffOut; onClose: () => void; onChanged: (s: SignOffOut) => void; users: UserOut[] }) {
  const { user } = useAuth()
  const [error, setError] = useState<unknown>(null)

  async function issue() {
    try { onChanged(await api.post<SignOffOut>(`/api/signoffs/${item.id}/issue`, {})) } catch (err) { setError(err) }
  }

  return (
    <Modal title={item.certificate_id} onClose={onClose} wide>
      <ErrorText error={error} />
      <div className="grid grid-2">
        <div><strong>Application:</strong> {item.application_name}</div>
        <div><strong>Status:</strong> <Badge status={item.status} /></div>
        <div><strong>Requester:</strong> {userName(users, item.issued_by_id) || '—'}</div>
        <div><strong>Assigned To (Signed By):</strong> {userName(users, item.signed_by_id) || '—'}</div>
        <div><strong>Certificate Type:</strong> {item.certificate_type}</div>
        <div><strong>Testing Type:</strong> {item.testing_type}</div>
        <div><strong>Release / Build:</strong> {item.release_version || '—'} / {item.build_number || '—'}</div>
        <div><strong>Environment Tested:</strong> {item.environment_tested || '—'}</div>
        <div><strong>Target Promotion:</strong> {item.target_promotion_environment || '—'}</div>
        <div><strong>Risk Tier:</strong> {item.risk_tier || '—'}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, margin: '10px 0 0', flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-sm" onClick={() => api.downloadFile(`/api/signoffs/${item.id}/export`, `${item.certificate_id}.pdf`)}>
          Export PDF
        </button>
        {hasRole(user, 'QA_LEAD') && item.status === 'Draft' && (
          <button className="btn btn-success btn-sm" onClick={issue}>Sign & Issue Certificate (CM-QA)</button>
        )}
      </div>

      <div className="section-title">Documents</div>
      <RequestDocuments apiBase="/api/signoffs" reqId={item.id} />
    </Modal>
  )
}

export default function SignOff() {
  const { user } = useAuth()
  const [rows, setRows] = useState<SignOffOut[]>([])
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState<SignOffOut | null>(null)
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try { setRows(await api.get<SignOffOut[]>('/api/signoffs')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.get<UserOut[]>('/api/auth/users').then(setUsers).catch(() => { /* names just stay empty */ })
  }, [])

  const canCreate = hasRole(user, 'QA_LEAD', 'DEPARTMENT_HEAD_COE')

  return (
    <div>
      <ErrorText error={error} />
      <PageHeader
        title="QA Sign-off Certificates" count={rows.length}
        subtitle="Formal QA clearance certificates issued by the QA Lead / QA Sign-off authority ahead of release."
        actions={canCreate && <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Sign-off Certificate</button>}
      />
      <Card>
        <Table rowKey="id" onRowClick={(r) => setSelected(r)} columns={[
          { key: 'certificate_id', header: 'Certificate ID' },
          { key: 'application_name', header: 'Application' },
          { key: 'issued_by_id', header: 'Requester', render: (r) => userName(users, r.issued_by_id) || '—', filterValue: (r) => userName(users, r.issued_by_id) || '' },
          { key: 'signed_by_id', header: 'Assigned To', render: (r) => userName(users, r.signed_by_id) || '—', filterValue: (r) => userName(users, r.signed_by_id) || '' },
          { key: 'certificate_type', header: 'Type' },
          { key: 'testing_type', header: 'Testing Type' },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
        ]} rows={rows} />
      </Card>
      {showNew && <NewSignOffModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
      {selected && <SignOffDetail item={selected} onClose={() => setSelected(null)} onChanged={(u) => { setSelected(u); load() }} users={users} />}
    </div>
  )
}
