import { useEffect, useState } from 'react'
import { api } from '../api'
import type { UserOption } from '../types'

export function useUserOptions(purpose: string, workspaceId?: number | null, defectId?: number, roles?: string, department?: string | null) {
  const [users, setUsers] = useState<UserOption[]>([])
  const query = new URLSearchParams({ purpose })
  if (workspaceId) query.set('workspace_id', String(workspaceId))
  if (roles) query.set('roles', roles)
  if (department) { query.set('department', department); query.set('department_scoped', 'true') }
  if (defectId) query.set('defect_id', String(defectId))
  const url = `/api/auth/user-options?${query}`
  useEffect(() => {
    let active = true
    setUsers([])
    api.get<UserOption[]>(url).then(rows => { if (active) setUsers(rows) })
      .catch(() => { if (active) setUsers([]) })
    return () => { active = false }
  }, [url])
  return users
}
