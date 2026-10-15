import React, { Suspense, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { CycleFunctionalRequestOption, FunctionalOut, UserOption } from '../types'
import SearchableSelect from './SearchableSelect'
import { ErrorText, Modal } from './Common'
import ModuleBoundary from './ModuleBoundary'
import { lazyModule } from '../lazyModule'

const FunctionalDetail = lazyModule(() => import('../modules/functional/Functional')
  .then(module => ({ default: module.FunctionalDetail })), { displayName: 'FunctionalDetail' })

export function cycleRequestLabel(request: CycleFunctionalRequestOption, application: string) {
  const reference = request.cr_number || request.epic_number
  return [request.request_id, request.application_name || application, reference && `CR / EPIC: ${reference}`,
    request.change_type, request.business_defect_number && `Business defect: ${request.business_defect_number}`]
    .filter(Boolean).join(' · ')
}

interface Preview { request: FunctionalOut; preview_token: string }
export default function CycleRequestPicker({ projectId, application, cycleId, value, options, users = [],
  disabled = false, standalone = true, reviewRequired, reviewed, onChange, onReviewed }: {
  projectId: number; application: string; cycleId?: number; value: string; options: CycleFunctionalRequestOption[]
  users?: UserOption[]; disabled?: boolean; standalone?: boolean; reviewRequired: boolean; reviewed: boolean
  onChange: (value: string) => void; onReviewed: (token: string) => void
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const generation = useRef(0)
  useEffect(() => {
    generation.current++; setPreview(null); setLoading(false); setConfirming(false); setError(null)
    return () => { generation.current++ }
  }, [projectId, cycleId, value])
  const requestId = Number(value.split(':')[1])
  const path = `/api/test-execution/projects/${projectId}/functional-requests/${requestId}/preview`
  const query = cycleId ? `?cycle_id=${cycleId}` : ''
  async function open() {
    const current = ++generation.current
    setLoading(true); setPreview(null); setError(null); onReviewed('')
    try {
      const loaded = await api.getFresh<Preview>(`${path}${query}`)
      if (generation.current === current) setPreview(loaded)
    } catch (err) { if (generation.current === current) setError(err) }
    finally { if (generation.current === current) setLoading(false) }
  }
  async function confirm() {
    if (!preview || confirming) return
    const current = generation.current
    setConfirming(true); setError(null)
    try {
      const receipt = await api.post<{ preview_token: string }>(`${path}/confirm${query}`, {
        preview_token: preview.preview_token, review_confirmed: true,
      })
      if (generation.current === current) { onReviewed(receipt.preview_token); setPreview(null) }
    } catch (err) { if (generation.current === current) { setPreview(null); onReviewed(''); setError(err) } }
    finally { if (generation.current === current) setConfirming(false) }
  }
  function close() { if (!confirming) { generation.current++; setPreview(null); setLoading(false) } }
  return <>
    <div className="cycle-request-picker">
      <SearchableSelect value={value} disabled={disabled || confirming} onChange={next => { onReviewed(''); onChange(next) }}
        placeholder="Search request ID, application, CR or business defect…"
        searchPlaceholder="Search request ID, application, CR or business defect…" options={[
          ...(standalone ? [{ value: '', label: 'No request (Standalone)' }] : []),
          ...options.map(request => ({ value: `Functional:${request.id}`, label: cycleRequestLabel(request, application) })),
        ]} />
      <button type="button" className="btn" disabled={!value || loading || confirming} onClick={() => { void open() }}>
        {loading ? 'Loading preview…' : 'Preview request'}
      </button>
    </div>
    {value && <small className={`cycle-request-review-status ${reviewed ? 'success-text' : 'muted'}`} role="status">
      {reviewed ? 'Request reviewed. Ready to save.' : reviewRequired ? 'Preview this request and choose Use this request before saving.' : 'Existing request link retained. Preview is required when choosing a different request.'}
    </small>}
    <ErrorText error={error} />
    {preview && <ModuleBoundary moduleName="Functional request preview"><Suspense fallback={
      <Modal title="Opening request…" onClose={close}><p role="status">Loading request details…</p></Modal>
    }><FunctionalDetail req={preview.request} users={users} onClose={close} onChanged={() => {}}
      preview={{ busy: confirming, onConfirm: () => { void confirm() } }} /></Suspense></ModuleBoundary>}
  </>
}
