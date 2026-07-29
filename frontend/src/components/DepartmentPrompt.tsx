import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Modal, Field, ErrorText } from './Common'
import SearchableSelect from './SearchableSelect'
import { DepartmentOut } from '../types'

// Shown once, right after a person's first-ever LDAP login (see
// models.User.needs_department_selection / App.tsx's Protected wrapper) --
// the directory's own "department" attribute is free text and often blank
// or doesn't exactly match one of our canonical department names, so this
// asks them to explicitly confirm/pick the real one themselves before they
// go any further. `preventBackdropClose` on the Modal means this can't be
// dismissed by clicking outside -- only "Save" (or the "Log out instead"
// escape hatch, for someone who opened this by mistake or doesn't know
// their department right now) can close it.
export default function DepartmentPrompt() {
  const { user, logout, refreshUser } = useAuth()
  const [departments, setDepartments] = useState<DepartmentOut[]>([])
  const [department, setDepartment] = useState('')
  const [loadError, setLoadError] = useState<unknown>(null)
  const [saveError, setSaveError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get<DepartmentOut[]>('/api/departments')
      .then(setDepartments)
      .catch(setLoadError)
  }, [])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!department) return
    setBusy(true)
    setSaveError(null)
    try {
      await api.patch('/api/auth/me', { department })
      await refreshUser()
    } catch (err) {
      setSaveError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    // The header's own "Close" button (rendered unconditionally by Modal) is
    // wired to the same action as "Log out instead" below, rather than a
    // no-op -- there's no "just dismiss without deciding" option here, so
    // closing this any way other than Save means abandoning this login.
    <Modal title="Welcome — one more step" onClose={logout} preventBackdropClose variant="dialog">
      <p className="muted small" style={{ marginTop: -4, marginBottom: 16 }}>
        Hi {user?.full_name || 'there'} — this is your first time signing in. Pick your department below so
        the right people (your SM, Department Head) can review requests you raise. You can always ask an
        Administrator to change this later.
      </p>
      <form onSubmit={save}>
        <Field label="Department *">
          <SearchableSelect
            value={department}
            onChange={setDepartment}
            options={departments.map((d) => d.name)}
            placeholder="Select your department..."
          />
        </Field>
        <ErrorText error={loadError} />
        <ErrorText error={saveError} />
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="submit" className="btn btn-primary" disabled={busy || !department}>
            {busy ? 'Saving...' : 'Save & Continue'}
          </button>
          <button type="button" className="btn" onClick={logout}>Log out instead</button>
        </div>
      </form>
    </Modal>
  )
}
