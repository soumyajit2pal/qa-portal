import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, HttpError } from '../api'
import { RequestViewerContext } from '../hooks/useRequestNavigation'
import { RequestLookupError, RequestTarget, requestRoutes, requestTarget, resolveRequestId } from '../requestNavigation'
import { QARequestOut, FunctionalOut, SASTOut, DASTOut, PerformanceOut, SuppressionOut, SignOffOut, UserOut } from '../types'
import { Modal } from './Common'
import { IconSearch } from './Icons'
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
  const navigate = useNavigate()
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
  const open = useCallback(async (next: RequestTarget) => {
    const current = ++generation.current
    setTarget(next)
    setRecord(null)
    setError(null)
    try {
      const [id, availableUsers] = await Promise.all([
        resolveRequestId(next, (url) => api.get(url)),
        // Name lookup is supporting display data, not an access test for
        // the requested record. A restricted directory must not make an
        // otherwise accessible request appear missing.
        api.get<UserOut[]>('/api/auth/users').catch(() => [] as UserOut[]),
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

  // A pasted/bookmarked ?open= or ?openId= URL uses the same lookup and
  // unavailable-state modal as global search and in-app request links.
  useEffect(() => {
    const linkedTarget = requestTarget(`${location.pathname}${location.search}`)
    if (linkedTarget) void open(linkedTarget)
    else close()
    return () => { generation.current++ }
  }, [location.key, location.pathname, location.search, open, close])

  function dismiss() {
    close()
    if (!requestTarget(`${location.pathname}${location.search}`)) return
    const params = new URLSearchParams(location.search)
    params.delete('open')
    params.delete('openId')
    const remaining = params.toString()
    navigate(`${location.pathname}${remaining ? `?${remaining}` : ''}`, { replace: true })
  }

  const unavailable = useCallback(() => {
    if (!target) return
    setRecord(null)
    setError(new RequestLookupError(target.identifier))
  }, [target])

  const props = { users, onClose: dismiss, onChanged: (updated: RequestRecord) => setRecord(updated) }
  let detail: React.ReactNode = null
  if (record && target) {
    switch (target.path) {
      case '/qa-requests': detail = <QA {...props} req={record as QARequestOut} onUnavailable={unavailable} />; break
      case '/functional-requests': detail = <Functional {...props} req={record as FunctionalOut} />; break
      case '/sast': detail = <SAST {...props} req={record as SASTOut} />; break
      case '/dast': detail = <DAST {...props} req={record as DASTOut} />; break
      case '/performance': detail = <Performance {...props} req={record as PerformanceOut} />; break
      case '/suppression': detail = <Suppression {...props} sup={record as SuppressionOut} />; break
      case '/signoff': detail = <SignOff {...props} item={record as SignOffOut} />; break
    }
  }
  const loading = <Modal title="Opening request…" onClose={dismiss} variant="dialog" compact preventBackdropClose>
    <div className="request-viewer-loading" role="status"><span aria-hidden="true" /><p>Loading request details…</p></div>
  </Modal>
  const missing = error instanceof RequestLookupError || (error instanceof HttpError && [403, 404].includes(error.status))
  const httpError = error instanceof HttpError ? error : null
  const systemFailure = httpError !== null && (httpError.status >= 500 || httpError.status === 0 || httpError.status === 408)
  const errorMessage = error instanceof Error ? error.message : String(error || 'The request could not be opened.')
  function tryAnotherId() {
    dismiss()
    window.dispatchEvent(new Event('request-search-focus'))
  }
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
      {target && (error ? missing ? <Modal title="Search result" onClose={dismiss} variant="dialog" compact preventBackdropClose>
        <div className="request-not-found-state" role="alert">
          <span className="request-not-found-icon" aria-hidden="true"><IconSearch width={24} height={24} /></span>
          <span className="request-not-found-eyebrow">No result found</span>
          <h3>We couldn’t find this request</h3>
          <p>The request may not exist, may have been removed, or may be outside your workspace access.</p>
          <div className="request-not-found-query">
            <span>Request ID</span>
            <code>{target.identifier}</code>
          </div>
          <div className="request-viewer-error-actions">
            <button className="btn btn-primary" onClick={tryAnotherId}>Search another ID</button>
            <button className="btn" onClick={dismiss}>Close</button>
          </div>
        </div>
      </Modal> : <Modal title="Unable to open request" onClose={dismiss} variant="dialog" compact preventBackdropClose>
        <div className="action-error-dialog" role="alert">
          <div className="action-error-dialog-icon">!</div>
          <div>
            <strong>Request details could not be loaded</strong>
            <span>{systemFailure && httpError.status ? `Service error · HTTP ${httpError.status}` : 'Reason'}</span>
            <p>{errorMessage}</p>
            {systemFailure && httpError.reference && <small className="action-error-reference">Technical reference: {httpError.reference}</small>}
          </div>
        </div>
        <div className="action-error-guidance">
          <strong>What to do</strong>
          <p>Try loading the request again. If the problem continues, close this message and contact the portal administrator.</p>
        </div>
        <div className="request-viewer-error-actions">
          <button className="btn btn-primary" onClick={() => void open(target)}>Retry</button>
          <button className="btn" onClick={dismiss}>Close</button>
        </div>
      </Modal> : <ModuleBoundary key={`${target.path}:${target.identifier}`} moduleName="Request details">
        <Suspense fallback={loading}>{detail || loading}</Suspense>
      </ModuleBoundary>)}
    </div>
  </RequestViewerContext.Provider>
}
