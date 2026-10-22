import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { internalNavigationPath } from '../requestNavigation'
import { saveWorkSnapshot, WorkSnapshot, WorkTarget, workKey, workPath } from '../workViewStore'

const Scope = createContext('anonymous')
const drafts = new Map<string, Record<string, unknown>>()
const retained = new Map<string, Record<string, unknown>>()
interface WorkContext {
  target: WorkTarget; data: Record<string, unknown>; page: boolean; scope: string
  returnTo: string; open: (newTab: boolean) => Promise<void>; clear: () => void
  locked: boolean; setLocked: (key: string, locked: boolean) => void
}
const Work = createContext<WorkContext | null>(null)
export const useWorkView = () => useContext(Work)
export const useWorkScope = () => useContext(Scope)
export function WorkViewsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const scope = `${user?.id || 'anonymous'}:${user?.active_workspace_id || ''}`
  return <Scope.Provider key={scope} value={scope}>{children}</Scope.Provider>
}
export function WorkSession({ target, children, page = false, snapshot, onReturn, draftTag }: {
  target: WorkTarget; children: React.ReactNode; page?: boolean; snapshot?: WorkSnapshot; onReturn?: string; draftTag?: string
}) {
  const outer = useWorkView()
  if (outer && workKey(outer.target) === workKey(target)) return <>{children}</>
  return <WorkSessionContent key={`${workKey(target)}:${draftTag || snapshot?.draftTag || ''}`} target={target} page={page} snapshot={snapshot} onReturn={onReturn} draftTag={draftTag || snapshot?.draftTag}>{children}</WorkSessionContent>
}
function WorkSessionContent({ target, children, page, snapshot, onReturn, draftTag }: {
  target: WorkTarget; children: React.ReactNode; page: boolean; snapshot?: WorkSnapshot; onReturn?: string; draftTag?: string
}) {
  const scope = useWorkScope(), location = useLocation(), navigate = useNavigate()
  const key = `${scope}:${workKey(target)}:${draftTag || ''}`
  const cleared = useRef(false)
  const locks = useRef(new Set<string>())
  const [, redraw] = useState(0)
  const setLocked = useCallback((key: string, locked: boolean) => {
    if (locks.current.has(key) === locked) return
    if (locked) locks.current.add(key); else locks.current.delete(key)
    redraw(value => value + 1)
  }, [])
  const data = useRef<Record<string, unknown>>(drafts.get(key) || (snapshot ? structuredClone(snapshot.data) : {}))
  if (!cleared.current) drafts.set(key, data.current)
  const fallback = target.kind === 'functional' ? '/functional-requests' : ['defect', 'observation'].includes(target.kind) ? '/defects' : '/test-execution'
  const listParams = new URLSearchParams(location.search)
  if (['/defects', '/functional-requests'].includes(location.pathname)) {
    for (const key of ['open', 'openId', 'defect', 'fromPending']) listParams.delete(key)
  }
  const sourcePath = `${location.pathname}${listParams.size ? `?${listParams}` : ''}`
  const returnTo = internalNavigationPath(onReturn || snapshot?.returnTo) || (page ? fallback : sourcePath)
  const context: WorkContext = {
    target, data: data.current, scope, page, returnTo, locked: locks.current.size > 0, setLocked,
    clear: () => { cleared.current = true; for (const key of Object.keys(data.current)) delete data.current[key]; drafts.delete(key) },
    open: async newTab => {
      // Reserve the tab synchronously with the click so popup blockers do not
      // discard it while IndexedDB commits the draft. Sever its opener before
      // navigating to the application.
      const tab = newTab ? window.open('about:blank', '_blank') : null
      if (newTab && !tab) throw new Error('The browser blocked the new tab. Allow popups for this portal and try again.')
      if (tab) tab.opener = null
      try {
        rememberListScroll(scope, returnTo)
        const id = await saveWorkSnapshot({ scope, target: workKey(target), data: structuredClone(data.current),
          lists: structuredClone(retained.get(scope) || {}), returnTo, draftTag, expiresAt: Date.now() + 8 * 60 * 60 * 1000 })
        const url = `${workPath(target)}?draft=${id}`
        if (tab) tab.location.replace(url)
        else navigate(url)
      } catch (error) { tab?.close(); throw error }
    },
  }
  return <Work.Provider value={context}>{children}</Work.Provider>
}
export function restoreRetained(scope: string, values: Record<string, unknown>) { retained.set(scope, structuredClone(values)) }
export function useWorkState<T>(key: string, initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
  const context = useWorkView()
  const binding = useRef({ context, key }); binding.current = { context, key }
  const [value, update] = useState<T>(() => context && Object.hasOwn(context.data, key) ? context.data[key] as T : typeof initial === 'function' ? (initial as () => T)() : initial)
  const current = useRef(value)
  current.current = value
  if (context) context.data[key] = value
  const set = useCallback((action: React.SetStateAction<T>) => {
    const next = typeof action === 'function' ? (action as (previous: T) => T)(current.current) : action
    current.current = next
    const { context, key } = binding.current
    if (context) context.data[key] = next
    update(next)
  }, [])
  return [value, set]
}
export function useRetainedState<T>(key: string | undefined, initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
  const scope = useWorkScope()
  let values = retained.get(scope)
  if (!values) { values = {}; retained.set(scope, values) }
  const [value, update] = useState<T>(() => key && Object.hasOwn(values!, key) ? values![key] as T : typeof initial === 'function' ? (initial as () => T)() : initial)
  const current = useRef(value); current.current = value
  const binding = useRef({ values, key }); binding.current = { values, key }
  if (key) values[key] = value
  const set = useCallback((action: React.SetStateAction<T>) => {
    const next = typeof action === 'function' ? (action as (previous: T) => T)(current.current) : action
    current.current = next
    const { values, key } = binding.current
    if (key) values![key] = next
    update(next)
  }, [])
  return [value, set]
}
export function useWorkBusy(busy: boolean) {
  const context = useWorkView(), id = useId(), setLocked = context?.setLocked
  useEffect(() => { setLocked?.(id, busy); return () => setLocked?.(id, false) }, [setLocked, id, busy])
}
function rememberListScroll(scope: string, path: string) {
  if (window.location.pathname.startsWith('/work/')) return
  const values = retained.get(scope) || {}
  const content = document.querySelector('.content')
  values[`scroll:${path}`] = { x: window.scrollX, y: window.scrollY, contentTop: content?.scrollTop || 0 }
  retained.set(scope, values)
}
export function useListScrollRestoration(loading: boolean) {
  const scope = useWorkScope(), location = useLocation()
  useEffect(() => {
    if (loading) return
    const saved = retained.get(scope)?.[`scroll:${location.pathname}${location.search}`] as { x: number; y: number; contentTop: number } | undefined
    if (!saved) return
    const frame = requestAnimationFrame(() => { window.scrollTo(saved.x, saved.y); const content = document.querySelector('.content'); if (content) content.scrollTop = saved.contentTop })
    return () => cancelAnimationFrame(frame)
  }, [loading, scope, location.pathname, location.search])
}
