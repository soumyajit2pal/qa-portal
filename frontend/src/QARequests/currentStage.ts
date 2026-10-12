import {
  GATEWAY_PENDING_WITH, GATEWAY_STATUS_LABELS,
  QA_PENDING_WITH, QA_STATUS_LABELS,
  SAST_DAST_PENDING_WITH, SAST_DAST_STATUS_LABELS,
  PERFORMANCE_PENDING_WITH, PERFORMANCE_STATUS_LABELS,
} from '../constants'
import type { LinkedRequestRef, QARequestListOut } from '../types'

export type TestingRequestKind = 'Functional QA' | 'SAST' | 'DAST' | 'Performance'
export type StageTone = 'neutral' | 'pending' | 'active' | 'attention' | 'completed'
type LinkedField = 'linked_functional_requests' | 'linked_sast_requests' | 'linked_dast_requests' | 'linked_performance_requests'
type StageRecord = Pick<QARequestListOut, 'status'> & Partial<Pick<QARequestListOut, LinkedField | 'application_master_status'>>

export interface LinkedTestingStage {
  key: string
  kind: TestingRequestKind
  path: string
  request: LinkedRequestRef
  label: string
  pendingWith: string
  tone: StageTone
  completed: boolean
  cancelled: boolean
  unavailable: boolean
}

export interface QARequestCurrentStage {
  label: string
  pendingWith: string
  tone: StageTone
  linked: LinkedTestingStage[]
  context: string
}

const GROUPS: Array<{
  field: LinkedField; kind: TestingRequestKind; path: string
  labels: Record<string, string>; owners: Record<string, string>
}> = [
  { field: 'linked_functional_requests', kind: 'Functional QA', path: '/functional-requests', labels: QA_STATUS_LABELS, owners: QA_PENDING_WITH },
  { field: 'linked_sast_requests', kind: 'SAST', path: '/sast', labels: SAST_DAST_STATUS_LABELS, owners: SAST_DAST_PENDING_WITH },
  { field: 'linked_dast_requests', kind: 'DAST', path: '/dast', labels: SAST_DAST_STATUS_LABELS, owners: SAST_DAST_PENDING_WITH },
  { field: 'linked_performance_requests', kind: 'Performance', path: '/performance', labels: PERFORMANCE_STATUS_LABELS, owners: PERFORMANCE_PENDING_WITH },
]

const CURRENT_LABELS: Record<string, string> = {
  SM_APPROVAL_PENDING: 'Awaiting SM approval',
  DEPARTMENT_HEAD_APPROVAL_PENDING: 'Awaiting department approval',
  QA_LEAD_ASSIGNED: 'Awaiting readiness verification',
  SECURITY_LEAD_ASSIGNED: 'Awaiting security readiness',
  ENGINEER_ASSIGNED: 'Awaiting readiness verification',
  EXECUTION_IN_PROGRESS: 'Testing in progress',
  SCANNING: 'Scan in progress',
  QA_SIGNOFF_PENDING: 'Awaiting QA clearance',
  SIGNOFF_PENDING: 'Awaiting clearance',
  REQUESTER_VERIFICATION: 'Awaiting requester verification',
  CLOSED: 'Completed',
}
const ATTENTION_STATES = new Set([
  'DEFECT_RAISED', 'WAITING_FOR_FIX', 'REMEDIATION', 'ASSIGNED_TO_REQUESTER', 'DEFECT_FIX_RETEST',
])
const PENDING_STATES = new Set([
  'DRAFT', 'SUBMITTED', 'SM_APPROVAL_PENDING', 'DEPARTMENT_HEAD_APPROVAL_PENDING',
  'QA_LEAD_ASSIGNED', 'SECURITY_LEAD_ASSIGNED', 'ENGINEER_ASSIGNED',
  'QA_SIGNOFF_PENDING', 'SIGNOFF_PENDING', 'REQUESTER_VERIFICATION',
])
const APPROVAL_STATES = new Set(['SM_APPROVAL_PENDING', 'DEPARTMENT_HEAD_APPROVAL_PENDING', 'QA_SIGNOFF_PENDING', 'SIGNOFF_PENDING'])
const TESTING_STATES = new Set([
  'TEST_DESIGN', 'EXECUTION_IN_PROGRESS', 'RETESTING', 'SCANNING', 'RESCAN', 'FINDING_VALIDATION',
  'ENVIRONMENT_SETUP', 'SCRIPT_DEVELOPMENT', 'BASELINE', 'LOAD_TEST_EXECUTION', 'RESULT_ANALYSIS',
])

function sentenceCase(label: string): string {
  // Retain domain names such as QA and SM while making long badges readable.
  return label.split(' ').map((word, index) => index === 0 || /^[A-Z]{2,}$/.test(word) ? word : word.toLowerCase()).join(' ')
}

export function qaRequestCurrentStage(record: StageRecord): QARequestCurrentStage {
  const linked = GROUPS.flatMap(group => (record[group.field] || []).map(request => {
    const status = request.status || ''
    const unavailable = !group.labels[status] && status !== 'CANCELLED'
    const applicationApproval = status === 'SM_APPROVAL_PENDING' && record.application_master_status === 'PENDING_APP_OWNER'
    // Intermediate QA/security completion still has clearance, reporting or
    // requester verification ahead. Only a closed workflow is fully complete.
    const completed = status === 'CLOSED'
    const cancelled = status === 'CANCELLED'
    const attention = status.startsWith('RETURNED_') || status.includes('REJECTED') || ATTENTION_STATES.has(status)
    return {
      key: `${group.kind}-${request.id}`, kind: group.kind, path: group.path, request,
      label: applicationApproval ? 'Awaiting application approval'
        : unavailable ? 'Status unavailable'
          : CURRENT_LABELS[status] || sentenceCase(group.labels[status] || 'Cancelled'),
      pendingWith: applicationApproval ? 'Application Owner' : group.owners[status] || (cancelled ? '—' : 'Not available'),
      tone: (completed ? 'completed' : cancelled || unavailable ? 'neutral' : attention ? 'attention'
        : PENDING_STATES.has(status) ? 'pending' : 'active') as StageTone,
      completed, cancelled, unavailable,
    }
  }))
  const closedCount = linked.filter(item => item.completed).length
  const context = linked.length === 1 ? linked[0].kind
    : linked.length > 1 ? `${closedCount} of ${linked.length} testing requests completed` : ''

  // Drafts, application approval and cancellation describe the intake itself.
  if (record.status !== 'RAISED') {
    return {
      label: record.status === 'SUBMITTED' ? 'Awaiting application approval' : GATEWAY_STATUS_LABELS[record.status] || 'Status unavailable',
      pendingWith: GATEWAY_PENDING_WITH[record.status] || 'Not available',
      tone: record.status === 'SUBMITTED' ? 'pending' : 'neutral', linked, context,
    }
  }
  if (!linked.length) return { label: 'Request created', pendingWith: 'Not available', tone: 'neutral', linked, context }

  const remaining = linked.filter(item => !item.completed && !item.cancelled)
  const pendingWith = [...new Set(remaining.map(item => item.pendingWith).filter(owner => owner !== '—'))].join(', ') || '—'
  const result = (label: string, tone: StageTone): QARequestCurrentStage => ({ label, tone, pendingWith, linked, context })
  if (closedCount === linked.length) return result('Completed', 'completed')
  if (linked.every(item => item.cancelled)) return result('Cancelled', 'neutral')
  if (!remaining.length) return result('Partially cancelled', 'attention')
  if (linked.length === 1) return result(linked[0].label, linked[0].tone)
  if (remaining.some(item => item.tone === 'attention')) return result('Needs attention', 'attention')
  if (remaining.some(item => item.unavailable)) return result('Status unavailable', 'neutral')
  if (linked.some(item => item.cancelled)) return result('Partially cancelled', 'attention')
  if (remaining.every(item => item.label === remaining[0].label)) return result(remaining[0].label, remaining[0].tone)
  if (remaining.every(item => APPROVAL_STATES.has(item.request.status || ''))) return result('Awaiting approvals', 'pending')
  return result(remaining.some(item => TESTING_STATES.has(item.request.status || '')) ? 'Testing in progress' : 'In progress', 'active')
}

export function qaRequestStatusMutation(path: string): boolean {
  return ['/api/qa-requests', '/api/applications', '/api/functional-requests', '/api/sast-requests',
    '/api/dast-requests', '/api/performance-requests', '/api/signoffs'].some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}
