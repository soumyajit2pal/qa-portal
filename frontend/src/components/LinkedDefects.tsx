import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { Badge } from './Common'
import { DefectListOut, PageOut } from '../types'

// Keep the Defect Management implementation in its existing lazy bundle;
// linked-defect panels only download it after the user asks to open one.
const EmbeddedDefectDetail = React.lazy(() => import('../modules/test-management/Defects')
  .then((module) => ({ default: module.EmbeddedDefectDetail })))

export default function LinkedDefects({ query, title = 'Linked Defects' }: { query: string; title?: string }) {
  const [items, setItems] = useState<DefectListOut[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    // SRS 7.2 pagination rollout -- /api/defects is now paginated;
    // `query` is always a single-entity scope (qa_request_id/cycle_id/
    // test_case_id/execution_id), so page_size=100 covers "every defect
    // linked to this one record" without needing a real pager UI here.
    api.get<PageOut<DefectListOut>>(`/api/defects?${query}&page_size=100`)
      .then((page) => { if (active) setItems(page.items) })
      .catch(() => { if (active) setItems([]) })
    return () => { active = false }
  }, [query])
  if (!items.length) return null
  return <>
    <section className="linked-defects-panel">
      <div><strong>{title}</strong><span>{items.length}</span></div>
      <div>{items.map((defect) => <button key={defect.id} type="button" onClick={() => setSelectedKey(defect.defect_key)}>
        <span><b>{defect.defect_key}</b><small>{defect.title}</small></span><Badge status={defect.status} /><em className={`defect-severity ${defect.severity.toLowerCase()}`}>{defect.severity}</em>
      </button>)}</div>
    </section>
    {selectedKey && <React.Suspense fallback={null}><EmbeddedDefectDetail defectKey={selectedKey} onClose={() => setSelectedKey(null)} /></React.Suspense>}
  </>
}
