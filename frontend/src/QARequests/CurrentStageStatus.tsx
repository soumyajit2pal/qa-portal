import React, { useId, useState } from 'react'
import { Badge } from '../components/Common'
import type { QARequestListOut } from '../types'
import { qaRequestCurrentStage, type LinkedTestingStage } from './currentStage'

const TONE_CLASS = { neutral: 'badge-gray', pending: 'badge-yellow', active: 'badge-blue', attention: 'badge-red', completed: 'badge-green' }

export default function CurrentStageStatus({ record, onOpenLinked }: {
  record: QARequestListOut
  onOpenLinked: (event: React.MouseEvent, linked: LinkedTestingStage) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const stage = qaRequestCurrentStage(record)

  return <div className="qa-current-stage">
    <span className={`badge qa-current-stage-badge ${TONE_CLASS[stage.tone]}`}>{stage.label}</span>
    <small className="qa-current-stage-owner">Pending with: {stage.pendingWith}</small>
    {stage.context && <small className="qa-current-stage-context">{stage.context}</small>}
    {stage.linked.length > 0 && <>
      <button
        type="button"
        className="qa-current-stage-toggle"
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={`${expanded ? 'Hide' : 'View'} linked testing for ${record.request_id || `Draft ${record.id}`}`}
        onClick={event => { event.stopPropagation(); setExpanded(current => !current) }}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        {expanded ? 'Hide linked testing' : `View linked testing (${stage.linked.length})`}
      </button>
      <ul id={detailsId} className="qa-current-stage-linked" hidden={!expanded} aria-label="Linked testing requests">
        {stage.linked.map(linked => <li key={linked.key}>
          <span className="qa-current-stage-kind">{linked.kind}</span>
          <button type="button" className="qa-current-stage-request" onClick={event => { event.stopPropagation(); onOpenLinked(event, linked) }} aria-label={`Open ${linked.kind} request ${linked.request.request_id}`}>
            {linked.request.request_id}
          </button>
          {(linked.request.department_unit_name || linked.request.module_name) && <small className="qa-current-stage-context">{[linked.request.department_unit_name, linked.request.module_name].filter(Boolean).join(' · ')}</small>}
          <Badge status={linked.request.status} label={linked.label} />
          <small className="qa-current-stage-owner">Pending with: {linked.pendingWith}</small>
        </li>)}
      </ul>
    </>}
  </div>
}
