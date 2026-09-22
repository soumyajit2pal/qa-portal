import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { api, setToken } from '../api'
import { UserOut } from '../types'
import { uniqueWorkspaceAccess } from '../constants'
import { isWorkspaceSelectionStorageChange } from '../workspaceTransition'

interface LoginResult {
  authenticated: true
}

interface AuthContextValue {
  user: UserOut | null
  loading: boolean
  login: (username: string, password: string) => Promise<LoginResult>
  logout: () => Promise<void>
  // Re-fetches /api/auth/me and updates `user` in place -- used after the
  // first-LDAP-login department-selection popup (components/
  // DepartmentPrompt.tsx) saves a department, so `user.needs_department_
  // selection` flips to false immediately without a full page reload.
  refreshUser: () => Promise<void>
  // True for the remainder of this browser session right after `login()`
  // succeeds, false on a page refresh/session-restore (loadMe() below never
  // sets it) -- lets components/PendingApprovalsNotice.tsx show its "you
  // have N pending approvals" pop-up only on an actual login, not every time
  // the app happens to (re)mount with an already-valid token. Cleared by
  // acknowledgeLogin() once that notice has been shown/dismissed, so it only
  // ever fires once per sign-in.
  justLoggedIn: boolean
  acknowledgeLogin: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

function syncWorkspaceSelection(me: UserOut) {
  const memberships = uniqueWorkspaceAccess(me)
  if (!memberships.length) {
    localStorage.removeItem('active_workspace_id')
    localStorage.removeItem('qa_active_workspace_id')
    return
  }
  const stored = Number(localStorage.getItem('active_workspace_id') || localStorage.getItem('qa_active_workspace_id'))
  // The server resolves stale or inherited selections and returns the
  // authoritative active workspace. This is essential after first-login
  // approval moves a user out of the Default Workspace.
  const preferred = me.preferred_workspace_id || me.preferred_qa_workspace_id
  const membershipFallback = memberships.some((row) => row.workspace_id === preferred)
    ? preferred!
    : memberships[0].workspace_id
  const selected = me.active_workspace_id || stored || membershipFallback
  localStorage.setItem('active_workspace_id', String(selected))
  localStorage.removeItem('qa_active_workspace_id')
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserOut | null>(null)
  const [loading, setLoading] = useState(true)
  const [justLoggedIn, setJustLoggedIn] = useState(() => sessionStorage.getItem('qa_approved_session') === '1')
  useEffect(() => { sessionStorage.removeItem('qa_approved_session') }, [])

  const loadMe = useCallback(async () => {
    try {
      if (localStorage.getItem('qa_logout_pending') === '1') {
        try {
          await api.post('/api/auth/logout')
          localStorage.removeItem('qa_logout_pending')
        } catch { /* Stay locally signed out and retry after service recovery. */ }
        setUser(null)
        setLoading(false)
        return
      }
    } catch { /* Storage can be unavailable; continue with server validation. */ }
    try {
      const me = await api.get<UserOut>('/api/auth/me')
      syncWorkspaceSelection(me)
      setUser(me)
    } catch (e) {
      setToken(null)
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadMe() }, [loadMe])

  useEffect(() => {
    const expired = () => { setUser(null); setJustLoggedIn(false) }
    const storageChanged = (event: StorageEvent) => {
      if (event.key === 'qa_session_logout' && event.newValue) expired()
      if (isWorkspaceSelectionStorageChange(event)) {
        // The workspace header is read from shared localStorage for every API
        // request. Reload this tab immediately so its mounted records cannot
        // remain from the old workspace while new requests use the new one.
        window.location.reload()
      }
    }
    window.addEventListener('qa-session-expired', expired)
    window.addEventListener('storage', storageChanged)
    return () => {
      window.removeEventListener('qa-session-expired', expired)
      window.removeEventListener('storage', storageChanged)
    }
  }, [loadMe])

  const login = async (username: string, password: string): Promise<LoginResult> => {
    // The sign-in field already displays lowercase input; normalize here as
    // well so every caller of AuthContext follows the same login identity.
    const res = await api.login(username.trim().toLowerCase(), password)
    try { localStorage.removeItem('qa_logout_pending') } catch { /* optional recovery marker */ }
    setToken(null)
    // A shared browser may still hold the previous account's workspace.
    // Resolve /me without sending that stale tenant selection.
    localStorage.removeItem('active_workspace_id')
    localStorage.removeItem('qa_active_workspace_id')
    // The login response intentionally contains no identity or role data.
    // Only this cookie-authenticated server lookup may populate authorization
    // state, so changing the visible login response cannot elevate the UI.
    const expectedUsername = username.trim().toLowerCase()
    const me = await api.confirmLoginIdentity<UserOut>(expectedUsername)
    syncWorkspaceSelection(me)
    setUser(me)
    setJustLoggedIn(true)
    return res
  }

  const logout = async () => {
    // Clear the UI immediately, but retain a non-secret retry marker until
    // the server confirms revocation of the HttpOnly session.
    setToken(null)
    try {
      localStorage.setItem('qa_logout_pending', '1')
      // Notify other same-origin tabs without placing credentials in storage.
      localStorage.setItem('qa_session_logout', String(Date.now()))
      localStorage.removeItem('active_workspace_id')
      localStorage.removeItem('qa_active_workspace_id')
    } catch { /* Storage can be unavailable; server revocation still proceeds. */ }
    setUser(null)
    setJustLoggedIn(false)
    try {
      await api.post('/api/auth/logout')
      localStorage.removeItem('qa_logout_pending')
    } catch { /* Remain signed out locally; loadMe retries revocation later. */ }
  }

  const refreshUser = async () => {
    const me = await api.get<UserOut>('/api/auth/me')
    syncWorkspaceSelection(me)
    // Approval can change roles, workspace membership and onboarding gates
    // together. Enter a fresh application session after persisting the new
    // workspace, rather than mounting portal pages into the provisional one.
    if (user?.needs_role_review && !me.needs_role_review && !me.needs_department_selection) {
      sessionStorage.setItem('qa_approved_session', '1')
      window.location.replace('/')
      return
    }
    setUser(me)
  }

  const acknowledgeLogin = () => setJustLoggedIn(false)

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser, justLoggedIn, acknowledgeLogin }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
