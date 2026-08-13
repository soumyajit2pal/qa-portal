import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { Modal, ErrorText } from './Common'
import { IconSearch } from './Icons'
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
  const [selected, setSelected] = useState<string[]>([])
  const [primary, setPrimary] = useState('')
  const [search, setSearch] = useState('')
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
    if (!selected.length || !primary) return
    setBusy(true)
    setSaveError(null)
    try {
      await api.patch('/api/auth/me', { departments: selected, primary_department: primary })
      await refreshUser()
    } catch (err) {
      setSaveError(err)
    } finally {
      setBusy(false)
    }
  }

  function toggleDepartment(department: string) {
    setSelected((values) => {
      if (values.includes(department)) {
        const next = values.filter((value) => value !== department)
        if (primary === department) setPrimary(next[0] || '')
        return next
      }
      if (!values.length) setPrimary(department)
      return [...values, department]
    })
  }

  const visibleDepartments = departments.filter((department) => department.name.toLowerCase().includes(search.trim().toLowerCase()))

  return (
    // Reported directly ("cross button and close duplicate -- wherever on
    // confirmation modal will be close then cross button should be removed"):
    // Department selection is mandatory. The shared header × follows the
    // same safe exit path as "Log out instead" rather than bypassing setup.
    <Modal title="Welcome — one more step" onClose={logout} preventBackdropClose variant="dialog">
      <p className="muted small" style={{ marginTop: -4, marginBottom: 16 }}>
        Hi {user?.full_name || 'there'} — this is your first time signing in. Select your department access below so
        the right people (your SM, Department Head) can review requests you raise. You can always ask an
        Administrator to change this later.
      </p>
      <form onSubmit={save}>
        <section className="ldap-department-picker">
          <header><div><small>Organisation access</small><h3>Select department(s)</h3><p>Your primary department controls the default request and approval scope.</p></div><strong>{selected.length} selected</strong></header>
          <label><IconSearch width={15} height={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search departments…" /></label>
          <div className="ldap-department-options">{visibleDepartments.map((department) => {
            const isSelected = selected.includes(department.name)
            const isPrimary = primary === department.name
            return <div className={isSelected ? 'selected' : ''} key={department.id}>
              <label><input type="checkbox" checked={isSelected} onChange={() => toggleDepartment(department.name)} disabled={busy} /><span>{department.name}</span></label>
              {isPrimary ? <strong>Primary</strong> : isSelected ? <button type="button" onClick={() => setPrimary(department.name)}>Make primary</button> : null}
            </div>
          })}</div>
        </section>
        <ErrorText error={loadError} />
        <ErrorText error={saveError} />
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="submit" className="btn btn-primary" disabled={busy || !selected.length || !primary}>
            {busy ? 'Saving...' : 'Save & Continue'}
          </button>
          <button type="button" className="btn" onClick={logout}>Log out instead</button>
        </div>
      </form>
    </Modal>
  )
}
