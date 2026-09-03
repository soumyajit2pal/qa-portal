import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../api'
import { RequestViewerContext } from '../hooks/useRequestNavigation'
import { RequestTarget, requestRoutes, requestTarget, resolveRequestId } from '../requestNavigation'
import { QARequestOut, FunctionalOut, SASTOut, DASTOut, PerformanceOut, SuppressionOut, SignOffOut, UserOut } from '../types'
import { ErrorText, Modal } from './Common'
import ModuleBoundary from './ModuleBoundary'
import { RequestDetail as QA } from '../QARequests/RequestDetail'

const Functional = lazy(() => import('../modules/functional/Functional').then((m) => ({ default: m.FunctionalDetail })))
const SAST = lazy(() => import('../modules/security/SAST').then((m) => ({ default: m.SASTDetail })))
const DAST = lazy(() => import('../modules/security/DAST').then((m) => ({ default: m.DASTDetail })))
const Performance = lazy(() => import('../modules/specialised-testing/Performance').then((m) => ({ default: m.PerformanceDetail })))
const Suppression = lazy(() => import('../modules/security/Suppression').then((m) => ({ default: m.SuppressionDetail })))
const SignOff = lazy(() => import('../modules/governance/SignOff').then((m) => ({ default: m.SignOffDetail })))
type RequestRecord = QARequestOut | FunctionalOut | SASTOut | DASTOut | PerformanceOut | SuppressionOut | SignOffOut

export default function RequestViewer({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const [target, setTarget] = useState<RequestTarget | null>(null)
  const [record, setRecord] = useState<RequestRecord | null>(null)
  const [users, setUsers] = useState<UserOut[]>([])
  const [error, setError] = useState<unknown>(null)
  const generation = useRef(0)
  const close = useCallback(() => {
    generation.current++
    setTarget(null)
    setRecord(null)
    setError(null)
  }, [])
  // Leaving the originating page also dismisses its request viewer.
  useEffect(() => { close(); return () => { generation.current++ } }, [location.key, close])

  const open = useCallback(async (next: RequestTarget) => {
    const current = ++generation.current
    setTarget(next)
    setRecord(null)
    setError(null)
    try {
      const [id, availableUsers] = await Promise.all([
        resolveRequestId(next, (url) => api.get(url)),
        api.get<UserOut[]>('/api/auth/users'),
      ])
      if (current !== generation.current) return
      const full = await api.get<RequestRecord>(`${requestRoutes[next.path].api}/${id}`)
      if (current !== generation.current) return
      setUsers(availableUsers)
      setRecord(full)
    } catch (err) {
      if (current === generation.current) setError(err)
    }
  }, [])

  const props = { users, onClose: close, onChanged: (updated: RequestRecord) => setRecord(updated) }
  let detail: React.ReactNode = null
  if (record && target) {
    switch (target.path) {
      case '/qa-requests': detail = <QA {...props} req={record as QARequestOut} onUnavailable={close} />; break
      case '/functional-requests': detail = <Functional {...props} req={record as FunctionalOut} />; break
      case '/sast': detail = <SAST {...props} req={record as SASTOut} />; break
      case '/dast': detail = <DAST {...props} req={record as DASTOut} />; break
      case '/performance': detail = <Performance {...props} req={record as PerformanceOut} />; break
      case '/suppression': detail = <Suppression {...props} sup={record as SuppressionOut} />; break
      case '/signoff': detail = <SignOff {...props} item={record as SignOffOut} />; break
    }
  }
  const loading = <Modal title="Opening request…" onClose={close}><p role="status">Loading request details…</p></Modal>
  return <RequestViewerContext.Provider value={open}>
    <div style={{ display: 'contents' }} onClickCapture={(event) => {
      // Covers request <Link>s as well as the programmatic navigation hook.
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element ? event.target.closest('a') : null
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return
      const destination = requestTarget(anchor.getAttribute('href') || '')
      if (!destination) return
      event.preventDefault()
      event.stopPropagation()
      void open(destination)
    }}>
      {children}
      {target && (error ? <Modal title="Unable to open request" onClose={close}>
        <ErrorText error={error} /><button className="btn" onClick={() => void open(target)}>Retry</button>
      </Modal> : <ModuleBoundary key={`${target.path}:${target.identifier}`} moduleName="Request details">
        <Suspense fallback={loading}>{detail || loading}</Suspense>
      </ModuleBoundary>)}
    </div>
  </RequestViewerContext.Provider>
}
