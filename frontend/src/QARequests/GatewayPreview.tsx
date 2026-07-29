import React from 'react'

// The QA Request is a pure intake/gateway record -- it has no approval
// workflow of its own (see constants.GATEWAY_STATUSES): Draft -> Submitted
// -> Raised (immediately, once its linked child request(s) exist), or
// Cancelled while still Draft.
const GATEWAY_STAGES = ['Draft', 'Submitted', 'Raised']

export function GatewayPreview({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="stepper" style={{ margin: '4px 0 18px' }}>
      {GATEWAY_STAGES.map((label, i) => (
        <React.Fragment key={label}>
          <div className={`step ${i <= activeIndex ? 'filled' : ''}`}>
            <div className="circle">{i + 1}</div>
            <div className="step-label">{label}</div>
          </div>
          {i < GATEWAY_STAGES.length - 1 && <div className={`connector ${i < activeIndex ? 'filled' : ''}`} />}
        </React.Fragment>
      ))}
    </div>
  )
}

export function gatewayStageIndex(status?: string): number {
  if (!status || status === 'DRAFT') return 0
  if (status === 'SUBMITTED') return 1
  if (status === 'RAISED') return 2
  return 0 // CANCELLED -- shown via the badge instead of the stepper
}
