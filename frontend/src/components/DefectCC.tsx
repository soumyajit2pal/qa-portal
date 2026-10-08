import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { DefectOut, UserOption } from '../types'
import { ErrorText, Field } from './Common'
import UserPicker from './UserPicker'

export function DefectCCField({ workspaceId, value, onChange, selectedUsers = [], disabled = false }: {
  workspaceId?: number | null
  value: number[]
  onChange: (ids: number[]) => void
  selectedUsers?: UserOption[]
  disabled?: boolean
}) {
  const [users, setUsers] = useState<UserOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true
    setUsers([]); setError(null)
    if (!workspaceId) { setLoading(false); return }
    setLoading(true)
    api.get<UserOption[]>(`/api/auth/user-options?purpose=defect_cc&workspace_id=${workspaceId}`)
      .then(rows => { if (current) setUsers(rows) })
      .catch(err => { if (current) setError(err) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [workspaceId, retry])
  const options = [...new Map([...selectedUsers, ...users].map(user => [user.id, user])).values()]
  return <Field label="CC">
    <UserPicker multiple value={value.map(String)} onChange={ids => onChange((ids as string[]).map(Number))}
      users={options} placeholder={loading ? 'Loading workspace users…' : 'Select CC users…'}
      ariaLabel="CC users" showRoles={false} disabled={disabled || loading || !workspaceId} />
    <small className="muted">Choose people from this workspace to follow the defect and receive email updates.</small>
    {!!error && <><ErrorText error={error} /><button type="button" className="btn btn-sm" onClick={() => setRetry(value => value + 1)}>Retry CC users</button></>}
  </Field>
}

export default function DefectCC({ defect, canManage, onChanged }: {
  defect: DefectOut
  canManage: boolean
  onChanged: (defect: DefectOut) => void
}) {
  const [editing, setEditing] = useState(false)
  const [ids, setIds] = useState<number[]>(defect.cc_user_ids || [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => { setIds(defect.cc_user_ids || []); setEditing(false); setError(null) }, [defect])
  async function save() {
    setBusy(true); setError(null)
    try {
      const saved = await api.put<DefectOut>(`/api/defects/${defect.id}/cc`, { cc_user_ids: ids })
      onChanged(saved); setEditing(false)
    } catch (err) { setError(err) }
    finally { setBusy(false) }
  }
  return <section className="defect-cc" aria-label="Defect CC">
    <div className="defect-cc-heading"><h4>CC</h4>{canManage && !editing && <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Manage CC</button>}</div>
    {editing ? <>
      <DefectCCField workspaceId={defect.qa_workspace_id} value={ids} onChange={setIds} selectedUsers={defect.cc_users} disabled={busy} />
      <div className="defect-cc-actions"><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save CC'}</button><button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setIds(defect.cc_user_ids || []); setEditing(false); setError(null) }}>Cancel</button></div>
      <ErrorText error={error} />
    </> : <><p>{defect.cc_users?.length ? defect.cc_users.map(user => user.full_name).join(', ') : 'No CC users selected.'}</p><small className="muted">CC receives defect updates and does not change the responsible owner.</small></>}
  </section>
}
