import { LinkedRequestRef, QARequestOut, UserOut } from '../types'

export function userName(users: UserOut[], id?: number | null): string | null {
  const u = users.find((x) => x.id === id)
  return u ? u.full_name : null
}

// Only reads the 4 linked_*_requests arrays -- shared structurally by both
// the full QARequestOut (detail view) and the lightweight QARequestListOut
// (paginated list, PAG-005), so this accepts either without the caller
// needing to cast.
interface ClassifiableRequest {
  linked_functional_requests: LinkedRequestRef[]
  linked_sast_requests: LinkedRequestRef[]
  linked_dast_requests: LinkedRequestRef[]
  linked_performance_requests: LinkedRequestRef[]
}

// Priority/Risk is per-request-type now (see models.FunctionalRequest for
// the full reasoning), not a single shared value on the gateway itself --
// mirrors backend routers/reports.py::qa_request_summary's "Type:
// Priority/Risk" breakdown, listing one entry per type actually linked to
// this QA Request.
export function classificationSummary(req: ClassifiableRequest): string {
  const f = req.linked_functional_requests?.[0]
  const s = req.linked_sast_requests?.[0]
  const d = req.linked_dast_requests?.[0]
  const p = req.linked_performance_requests?.[0]
  const parts = [
    f && `Functional: ${f.priority || '—'} / ${f.risk_rating || '—'}`,
    s && `SAST: ${s.priority || '—'} / ${s.risk_category || '—'}`,
    d && `DAST: ${d.priority || '—'} / ${d.risk_category || '—'}`,
    p && `Performance: ${p.priority || '—'} / ${p.risk_category || '—'}`,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join('; ') : 'Not yet set — raise the linked request(s) first'
}

export interface LinkedSection {
  label: string
  path: string
}

// After a QA Request is raised, each selected request type has its own
// independent request/workflow living on its own module page -- this is
// used by the "your request has been raised" alert (RequestDetail.tsx) to
// point the requester at exactly which page(s) to go review/submit next,
// rather than a generic "check your linked requests" message.
export function linkedSections(req: QARequestOut): LinkedSection[] {
  const sections: LinkedSection[] = []
  if (req.linked_functional_requests?.length) sections.push({ label: 'Functional QA Requests', path: '/functional-requests' })
  if (req.linked_sast_requests?.length) sections.push({ label: 'SAST Requests', path: '/sast' })
  if (req.linked_dast_requests?.length) sections.push({ label: 'DAST Requests', path: '/dast' })
  if (req.linked_performance_requests?.length) sections.push({ label: 'Performance Testing Requests', path: '/performance' })
  return sections
}
