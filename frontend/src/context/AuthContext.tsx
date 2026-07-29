import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { api, setToken, hasToken } from '../api'
import { UserOut } from '../types'

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
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserOut | null>(null)
  const [loading, setLoading] = useState(true)

  const loadMe = useCallback(async () => {
    if (!hasToken()) {
      setLoading(false)
      return
    }
    try {
      const me = await api.get<UserOut>('/api/auth/me')
      setUser(me)
    } catch (e) {
      setToken(null)
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadMe() }, [loadMe])

  const login = async (username: string, password: string): Promise<LoginResult> => {
    const res = await api.login(username, password)
    setToken(res.access_token)
    const me = await api.get<UserOut>('/api/auth/me')
    setUser(me)
    return res
  }

  const logout = () => {
    setToken(null)
    setUser(null)
  }

  const refreshUser = async () => {
    const me = await api.get<UserOut>('/api/auth/me')
    setUser(me)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
