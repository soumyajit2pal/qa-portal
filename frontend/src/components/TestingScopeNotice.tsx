import React from 'react'
import { useRequestNavigation } from '../hooks/useRequestNavigation'
import { FUNCTIONAL_BUCKET_TYPES, REQUEST_TYPES } from '../constants'
import './TestingScopeNotice.css'

export function additionalTestingOptions(requestTypes?: string | null, parentId?: number | null): string[] {
  if (!parentId) return []
  const selected = (requestTypes || '').split(',')
  const hasFunctional = selected.some((type) => FUNCTIONAL_BUCKET_TYPES.includes(type))
  return REQUEST_TYPES.filter((type) => !selected.includes(type) && !(hasFunctional && FUNCTIONAL_BUCKET_TYPES.includes(type)))
}

export default function TestingScopeNotice({ missing, parentId }: { missing?: string[]; parentId?: number | null }) {
  const navigate = useRequestNavigation()
  if (!missing?.length) return null
  return <div className="scope-context" role="status">
    <strong>Additional testing required: {missing.join(', ')}</strong>
    <p>Raise these linked requests under the same QA request before resubmitting this request.</p>
    {parentId && <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate(`/qa-requests?openId=${parentId}`)}>Open QA request to add testing</button>}
  </div>
}
