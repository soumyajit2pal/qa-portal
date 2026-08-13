import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Badge } from './Common'
import { DefectListOut, PageOut } from '../types'

export default function LinkedDefects({ query, title = 'Linked Defects', returnTo }: { query: string; title?: string; returnTo?: string }) {
  const navigate = useNavigate()
  const [items, setItems] = useState<DefectListOut[]>([])
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
  // 2026-08 -- reported directly: opening a defect from here (e.g. Test
  // Execution's "Cycle Defects" panel) is a full-page navigation to
  // /defects, so closing the defect used to just land on the Defects
  // register instead of going back to wherever the click came from.
  // `returnTo` (when the caller has a sensible page to return to -- see
  // TestExecution.tsx's usage) is carried through as a `return` query param
  // that Defects.tsx's DefectDetail onClose reads and navigates back to.
  const openUrl = (key: string) => `/defects?open=${encodeURIComponent(key)}${returnTo ? `&return=${encodeURIComponent(returnTo)}` : ''}`
  return <section className="linked-defects-panel">
    <div><strong>{title}</strong><span>{items.length}</span></div>
    <div>{items.map((defect) => <button key={defect.id} type="button" onClick={() => navigate(openUrl(defect.defect_key))}>
      <span><b>{defect.defect_key}</b><small>{defect.title}</small></span><Badge status={defect.status} /><em className={`defect-severity ${defect.severity.toLowerCase()}`}>{defect.severity}</em>
    </button>)}</div>
  </section>
}
