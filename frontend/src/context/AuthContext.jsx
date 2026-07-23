import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { api, setToken, hasToken } from '../api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadMe = useCallback(async () => {
    if (!hasToken()) {
      setLoading(false)
      return
    }
    try {
      const me = await api.get('/api/auth/me')
      setUser(me)
    } catch (e) {
      setToken(null)
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadMe() }, [loadMe])

  const login = async (username, password) => {
    const res = await api.login(username, password)
    setToken(res.access_token)
    const me = await api.get('/api/auth/me')
    setUser(me)
    return res
  }

  const logout = () => {
    setToken(null)
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
