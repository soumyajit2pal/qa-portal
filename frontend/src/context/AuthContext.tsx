import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import {
  ADMIN_ACCESS_DENIED_EVENT,
  ADMIN_ACCESS_RECHECK_EVENT,
  AUTH_BOOTSTRAP_TIMEOUT_MS,
  HttpError,
  api,
  setToken,
} from '../api'
import { UserOut } from '../types'
import { uniqueWorkspaceAccess } from '../constants'
import { isWorkspaceSelectionStorageChange } from '../workspaceTransition'

interface LoginResult {
  authenticated: true
}

interface AuthBootstrapIssue {
  kind: 'session' | 'administrator'
  reference?: string
}

interface AdministrativePresentation {
  user: UserOut
  unavailableError: unknown | null
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
    try {
      localStorage.removeItem('active_workspace_id')
      localStorage.removeItem('qa_active_workspace_id')
    } catch { /* The server-selected workspace remains authoritative when storage is restricted. */ }
    return
  }
  try {
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
  } catch { /* Continue with the workspace already resolved by the server. */ }
}

function withoutUnverifiedAdminRole(me: UserOut): UserOut {
  return me.roles.includes('ADMIN')
    ? { ...me, roles: me.roles.filter((role) => role !== 'ADMIN') }
    : me
}

async function administrativePresentation(me: UserOut): Promise<AdministrativePresentation> {
  if (!me.roles.includes('ADMIN')) return { user: me, unavailableError: null }
  try {
    await api.verifyAdminAccess()
    return { user: me, unavailableError: null }
  } catch (error) {
    // A 401 must continue through the normal session-expiry path rather than
    // leaving a locally authenticated-looking profile behind. Every other
    // failure stays fail-closed for ADMIN presentation while leaving ordinary
    // portal functionality available.
    if (error instanceof HttpError && error.status === 401) throw error
    return {
      user: withoutUnverifiedAdminRole(me),
      // A definitive 403 is an authorization result, not an unavailable
      // bootstrap. Network, deadline and server failures need an explicit
      // retry choice instead of silently making an Administrator look like a
      // permanently non-admin account.
      unavailableError: error instanceof HttpError && error.status === 403 ? null : error,
    }
  }
}

async function verifyAdministrativePresentation(
  me: UserOut,
  onUnavailable?: (error: unknown) => void,
): Promise<UserOut> {
  const presentation = await administrativePresentation(me)
  if (presentation.unavailableError) onUnavailable?.(presentation.unavailableError)
  return presentation.user
}

function isAuthenticationRejection(error: unknown): boolean {
  return error instanceof HttpError && error.status === 401
}

function issueReference(error: unknown): string | undefined {
  return error instanceof HttpError ? error.reference : undefined
}

function AuthBootstrapRecovery({
  issue,
  onRetry,
  onContinue,
}: {
  issue: AuthBootstrapIssue
  onRetry: () => void
  onContinue: () => void
}) {
  const sessionUnavailable = issue.kind === 'session'
  const deadlineSeconds = AUTH_BOOTSTRAP_TIMEOUT_MS / 1_000
  return (
    <main className="auth-bootstrap-recovery" aria-label="Portal session recovery">
      <section className="card empty-state auth-bootstrap-recovery-card" role="alert" aria-live="polite">
        <h1>{sessionUnavailable ? 'Session check did not complete' : 'Administrator access could not be verified'}</h1>
        <p className="msg">
          {sessionUnavailable
            ? `QualityOps could not complete the session check. Startup checks are limited to ${deadlineSeconds} seconds, and no protected portal data was loaded.`
            : 'Your session is valid, but the server did not confirm Administrator access. Administration tools remain disabled.'}
        </p>
        <p className="msg">Check the browser network connection and retry the check.</p>
        {issue.reference && <p className="muted small">Reference: {issue.reference}</p>}
        <div className="auth-bootstrap-recovery-actions">
          <button className="btn btn-primary" type="button" onClick={onRetry}>
            {sessionUnavailable ? 'Retry session check' : 'Retry access check'}
          </button>
          {!sessionUnavailable && (
            <button className="btn" type="button" onClick={onContinue}>Continue without administrator tools</button>
          )}
        </div>
      </section>
    </main>
  )
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserOut | null>(null)
  const [loading, setLoading] = useState(true)
  const [bootstrapIssue, setBootstrapIssue] = useState<AuthBootstrapIssue | null>(null)
  const [justLoggedIn, setJustLoggedIn] = useState(() => {
    try { return sessionStorage.getItem('qa_approved_session') === '1' }
    catch { return false }
  })
  useEffect(() => {
    try { sessionStorage.removeItem('qa_approved_session') }
    catch { /* Session restore must remain available when browser storage is restricted. */ }
  }, [])

  const loadMe = useCallback(async () => {
    setLoading(true)
    setBootstrapIssue(null)
    try {
      let logoutPending = false
      try { logoutPending = localStorage.getItem('qa_logout_pending') === '1' }
      catch { /* Storage can be unavailable; continue with server validation. */ }
      if (logoutPending) {
        try {
          // Retain the marker until the server confirms revocation, but do not
          // let a recovery attempt inherit the normal 30-second API deadline.
          await api.retryPendingLogout()
          localStorage.removeItem('qa_logout_pending')
        } catch { /* Stay locally signed out and retry after service recovery. */ }
        setToken(null)
        setUser(null)
        return
      }

      const restored = await api.restoreSession<UserOut>()
      const presentation = await administrativePresentation(restored)
      syncWorkspaceSelection(presentation.user)
      setUser(presentation.user)
      if (presentation.unavailableError) {
        setBootstrapIssue({
          kind: 'administrator',
          reference: issueReference(presentation.unavailableError),
        })
      }
    } catch (error) {
      setToken(null)
      setUser(null)
      // Only a genuine 401 is a completed session rejection and should show
      // the normal sign-in page. A 403 during /me is not a standard signed-out
      // response, and transport/deadline/server failures are not proof that a
      // session is invalid, so fail closed and offer an explicit retry.
      if (!isAuthenticationRejection(error)) {
        setBootstrapIssue({ kind: 'session', reference: issueReference(error) })
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadMe() }, [loadMe])

  useEffect(() => {
    const expired = () => { setUser(null); setJustLoggedIn(false) }
    const adminDenied = () => {
      setUser((current) => current ? withoutUnverifiedAdminRole(current) : current)
    }
    const recheckAdmin = () => {
      void api.verifyAdminAccess().catch((error) => {
        if (!(error instanceof HttpError) || error.status === 401 || error.status === 403) {
          adminDenied()
        }
      })
    }
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
    window.addEventListener(ADMIN_ACCESS_DENIED_EVENT, adminDenied)
    window.addEventListener(ADMIN_ACCESS_RECHECK_EVENT, recheckAdmin)
    window.addEventListener('storage', storageChanged)
    return () => {
      window.removeEventListener('qa-session-expired', expired)
      window.removeEventListener(ADMIN_ACCESS_DENIED_EVENT, adminDenied)
      window.removeEventListener(ADMIN_ACCESS_RECHECK_EVENT, recheckAdmin)
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
    try {
      localStorage.removeItem('active_workspace_id')
      localStorage.removeItem('qa_active_workspace_id')
    } catch { /* The server still validates and resolves the signed-in workspace. */ }
    // The login response intentionally contains no identity or role data.
    // Only this cookie-authenticated server lookup may populate authorization
    // state, so changing the visible login response cannot elevate the UI.
    const expectedUsername = username.trim().toLowerCase()
    const me = await verifyAdministrativePresentation(
      await api.confirmLoginIdentity<UserOut>(expectedUsername),
      (error) => setBootstrapIssue({ kind: 'administrator', reference: issueReference(error) }),
    )
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
    const me = await verifyAdministrativePresentation(
      await api.get<UserOut>('/api/auth/me'),
      (error) => setBootstrapIssue({ kind: 'administrator', reference: issueReference(error) }),
    )
    syncWorkspaceSelection(me)
    // Approval can change roles, workspace membership and onboarding gates
    // together. Enter a fresh application session after persisting the new
    // workspace, rather than mounting portal pages into the provisional one.
    if (user?.needs_role_review && !me.needs_role_review && !me.needs_department_selection) {
      try { sessionStorage.setItem('qa_approved_session', '1') }
      catch { /* Approval still takes effect when session storage is restricted. */ }
      window.location.replace('/')
      return
    }
    setUser(me)
  }

  const acknowledgeLogin = () => setJustLoggedIn(false)

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser, justLoggedIn, acknowledgeLogin }}>
      {bootstrapIssue
        ? <AuthBootstrapRecovery
            issue={bootstrapIssue}
            onRetry={() => { void loadMe() }}
            onContinue={() => setBootstrapIssue(null)}
          />
        : children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
