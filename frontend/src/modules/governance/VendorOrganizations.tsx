import React, { useEffect, useState } from 'react'
import { api } from '../../api'
import { UserOut, VendorOrganizationOut } from '../../types'
import { Card, Table, Modal, Field, ErrorText, WarningNotice } from '../../components/Common'
import VendorOrganizationSelect, { VendorSelection, validVendorSelection } from '../../components/VendorOrganizationSelect'

export const USER_TYPE_LABELS: Record<string, string> = { STANDARD: 'Standard account', BANK_STAFF: 'Bank Staff', VENDOR: 'Vendor' }

export function VendorProfileEditor({ user, onClose, onDone }: { user: UserOut; onClose: () => void; onDone: () => void }) {
  const [selection, setSelection] = useState<VendorSelection>(user.vendor_organization_id ? { organization_id: user.vendor_organization_id } : {})
  const [exempt, setExempt] = useState(!!user.vendor_profile_exempt)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy || reason.trim().length < 5 || (selection.organization_name !== undefined && !validVendorSelection(selection))) return
    setBusy(true); setError(null)
    try {
      await api.patch(`/api/auth/users/${user.id}/vendor-profile`, { ...selection, vendor_profile_exempt: exempt,
        expected_organization_id: user.vendor_organization_id ?? null, expected_exempt: !!user.vendor_profile_exempt, reason: reason.trim() })
      onDone()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return <Modal title={`Vendor profile — ${user.full_name}`} onClose={onClose} variant="dialog">
    <p>@{user.username} · Vendor</p>
    <form onSubmit={save}>
      <VendorOrganizationSelect value={selection} onChange={setSelection} disabled={busy} allowBlank currentName={user.vendor_organization_name} />
      <Field label="System/test account"><label><input type="checkbox" checked={exempt} disabled={busy} onChange={event => setExempt(event.target.checked)} /> Exempt this LDAP system/test account from vendor organization setup</label></Field>
      {exempt && <WarningNotice title="Profile exemption">This account skips the vendor organization prompt. Its roles, workspace access and approval requirements continue to apply.</WarningNotice>}
      {!exempt && !validVendorSelection(selection) && <p className="muted small">This user will be asked to select an organization when using QualityOps.</p>}
      <Field label="Administrative reason *"><textarea required minLength={5} maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></Field>
      <ErrorText error={error} />
      <div className="modal-actions"><button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 5 || (selection.organization_name !== undefined && !validVendorSelection(selection))}>Save profile</button><button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>
}

export default function VendorOrganizations() {
  const [rows, setRows] = useState<VendorOrganizationOut[]>([])
  const [target, setTarget] = useState<VendorOrganizationOut | 'NEW' | null>(null)
  const [name, setName] = useState('')
  const [active, setActive] = useState(true)
  const [reason, setReason] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  async function load() {
    setLoadError(null)
    try { setRows(await api.getFresh<VendorOrganizationOut[]>('/api/vendor-organizations?include_inactive=true')) }
    catch (err) { setLoadError(err) }
  }
  useEffect(() => { void load() }, [])
  function edit(row: VendorOrganizationOut | 'NEW') {
    setTarget(row); setName(row === 'NEW' ? '' : row.name); setActive(row === 'NEW' || row.is_active); setReason(''); setError(null)
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!target || busy || name.trim().length < 2) return
    setBusy(true); setError(null)
    try {
      if (target === 'NEW') await api.post('/api/vendor-organizations', { organization_name: name })
      else await api.patch(`/api/vendor-organizations/${target.id}`, { name, is_active: active, expected_revision: target.revision, reason: reason.trim() })
      setTarget(null); await load()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return <Card title="Vendor organizations">
    <p>Maintain the shared list used during vendor profile setup. Existing assignments and audit history remain available when an organization is deactivated.</p>
    <div className="form-row"><input aria-label="Search vendor organizations" placeholder="Search organizations…" value={search} onChange={event => setSearch(event.target.value)} /><button type="button" className="btn btn-primary" onClick={() => edit('NEW')}>Create New</button><button type="button" className="btn" onClick={() => void load()}>Refresh</button></div>
    <ErrorText error={loadError} />
    <Table rowKey="id" rows={rows.filter(row => row.name.toLowerCase().includes(search.trim().toLowerCase()))} columns={[
      { key: 'name', header: 'Organization' },
      { key: 'is_active', header: 'Status', render: row => row.is_active ? 'Active' : 'Inactive' },
      { key: 'actions', header: 'Actions', filterable: false, render: row => <button className="btn btn-sm" onClick={() => edit(row)}>Manage organization</button> },
    ]} />
    {target && <Modal title={target === 'NEW' ? 'Create vendor organization' : 'Manage vendor organization'} onClose={() => setTarget(null)} variant="dialog"><form onSubmit={save}>
      <Field label="Organization name *"><input required maxLength={150} minLength={2} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></Field>
      {target !== 'NEW' && <><Field label="Status"><label><input type="checkbox" checked={active} disabled={busy} onChange={event => setActive(event.target.checked)} /> Active</label></Field>
        {!active && <WarningNotice title="Organization inactive">New users cannot select this organization. Existing user affiliations and history are retained.</WarningNotice>}
        <Field label="Reason for change *"><textarea required minLength={5} maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></Field></>}
      <ErrorText error={error} />
      <div className="modal-actions"><button type="submit" className="btn btn-primary" disabled={busy || name.trim().length < 2 || (target !== 'NEW' && reason.trim().length < 5)}>Save organization</button><button type="button" className="btn" disabled={busy} onClick={() => setTarget(null)}>Cancel</button></div>
    </form></Modal>}
  </Card>
}
