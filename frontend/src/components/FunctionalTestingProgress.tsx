import React from 'react'

const stages = ['Tester Assigned', 'Test Design', 'Execution', 'QA Completed', 'Clearance']
const stageByStatus: Record<string, number> = {
  TESTER_ASSIGNED: 0,
  TEST_DESIGN: 1,
  EXECUTION_IN_PROGRESS: 2,
  DEFECT_RAISED: 2,
  WAITING_FOR_FIX: 2,
  RETESTING: 2,
  QA_COMPLETED: 3,
  QA_SIGNOFF_PENDING: 4,
  QA_SIGNED_OFF: 4,
  QA_CHANGE_REVIEW: 4,
  REQUESTER_VERIFICATION: 4,
}

/** Keep the testing path visible even when its next action belongs to someone else. */
export default function FunctionalTestingProgress({ status, testerNames, isAssignedTester }: {
  status: string
  testerNames: string
  isAssignedTester: boolean
}) {
  const active = stageByStatus[status]
  if (active === undefined) return null
  const nextAction = status === 'TESTER_ASSIGNED' ? 'Start Test Design'
    : status === 'TEST_DESIGN' ? 'Start Execution' : null
  return <section aria-label="Testing workflow">
    <div className="section-title">Testing workflow</div>
    <div className="stepper" style={{ margin: '4px 0 18px' }}>
      {stages.map((label, index) => <React.Fragment key={label}>
        <div className={`step ${index <= active ? 'filled' : ''} ${index === active ? 'current' : ''}`}
          aria-current={index === active ? 'step' : undefined}>
          <div className="circle">{index + 1}</div>
          <div className="step-label">{label}</div>
        </div>
        {index < stages.length - 1 && <div className={`connector ${index < active ? 'filled' : ''}`} />}
      </React.Fragment>)}
    </div>
    {nextAction && <div className="info-banner" role="status">
      <strong>Next step: {nextAction}.</strong>{' '}
      {testerNames ? <>Assigned tester(s): {testerNames}.{' '}</> : <>No tester is assigned. Ask the QA Lead to assign a tester.{' '}</>}
      {isAssignedTester ? <>Use {nextAction} below to continue.</>
        : <>This action is available to the assigned testers when they open this request.</>}
      {status === 'TEST_DESIGN' && <> Execution uses a linked Test Cycle; a new link requires request preview.</>}
    </div>}
  </section>
}
