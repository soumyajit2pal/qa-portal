import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { api, setToken, hasToken, startTokenRenewal } from '../api'
import { UserOut } from '../types'
import { uniqueWorkspaceAccess } from '../constants'

interface LoginResult {
  access_token: string
  token_type: string
  roles: string[]
  full_name: string
  username: string
}

interface AuthContextValue {
  user: UserOut | null
  loading: boolean
  login: (username: string, password: string) => Promise<LoginResult>
  logout: () => void
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
  const [justLoggedIn, setJustLoggedIn] = useState(false)

  const loadMe = useCallback(async () => {
    if (!hasToken()) {
      setLoading(false)
      return
    }
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
    if (!user) return
    return startTokenRenewal()
  }, [user?.id])

  useEffect(() => {
    const expired = () => { setUser(null); setJustLoggedIn(false) }
    window.addEventListener('qa-session-expired', expired)
    return () => window.removeEventListener('qa-session-expired', expired)
  }, [])

  const login = async (username: string, password: string): Promise<LoginResult> => {
    // The sign-in field already displays lowercase input; normalize here as
    // well so every caller of AuthContext follows the same login identity.
    const res = await api.login(username.trim().toLowerCase(), password)
    setToken(res.access_token)
    // A shared browser may still hold the previous account's workspace.
    // Resolve /me without sending that stale tenant selection.
    localStorage.removeItem('active_workspace_id')
    localStorage.removeItem('qa_active_workspace_id')
    const me = await api.get<UserOut>('/api/auth/me')
    syncWorkspaceSelection(me)
    setUser(me)
    setJustLoggedIn(true)
    return res
  }

  const logout = () => {
    // request() reads the bearer token synchronously before returning its
    // Promise, so the audit call is authenticated even though local UI state
    // is cleared immediately. A slow/unavailable server cannot trap the user
    // in a signed-in UI.
    void api.post('/api/auth/logout').catch(() => undefined)
    setToken(null)
    localStorage.removeItem('active_workspace_id')
    localStorage.removeItem('qa_active_workspace_id')
    setUser(null)
    setJustLoggedIn(false)
  }

  const refreshUser = async () => {
    const me = await api.get<UserOut>('/api/auth/me')
    syncWorkspaceSelection(me)
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
