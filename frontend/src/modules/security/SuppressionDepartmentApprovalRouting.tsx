import React from 'react'
import { Field } from '../../components/Common'
import MultiSelect from '../../components/MultiSelect'
import { SuppressionApprovalDepartmentOption, SuppressionDepartmentApprovalOut } from '../../types'

interface SuppressionDepartmentApprovalRoutingProps {
  departments: SuppressionApprovalDepartmentOption[]
  owningDepartment: string
  owningDepartmentEligible: boolean | null
  selectedDepartmentIds: number[]
  requiresAdditionalApprovals: boolean
  onRequirementChange: (required: boolean) => void
  onChange: (departmentIds: number[]) => void
  loading: boolean
  error?: unknown
  onRetry: () => void
  editable?: boolean
  lockedApprovals?: SuppressionDepartmentApprovalOut[]
}

function pickerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unable to load departments.')
}

function DepartmentLoadNotice({ error, loading, onRetry }: {
  error?: unknown
  loading: boolean
  onRetry: () => void
}) {
  if (loading) return <p className="muted small" role="status">Loading departments…</p>
  if (!error) return null
  return (
    <div className="execution-cycle-required-warning" role="alert">
      <span>Could not load departments: {pickerErrorMessage(error)}</span>
      <button type="button" className="btn btn-sm" onClick={onRetry}>Retry</button>
    </div>
  )
}

/**
 * One approval-routing field shared by suppression creation and editing.
 * Keeping the choice cards, compact picker, selected chips, count, and
 * clearing behaviour together prevents the two modal flows from drifting.
 */
export default function SuppressionDepartmentApprovalRouting({
  departments,
  owningDepartment,
  owningDepartmentEligible,
  selectedDepartmentIds,
  requiresAdditionalApprovals,
  onRequirementChange,
  onChange,
  loading,
  error,
  onRetry,
  editable = true,
  lockedApprovals = [],
}: SuppressionDepartmentApprovalRoutingProps) {
  const additionalDepartmentOptions = departments.filter(
    (department) => department.name !== owningDepartment,
  )
  const fallbackNames = new Map(
    lockedApprovals.map((approval) => [approval.department_id, approval.department_name || 'Unknown department']),
  )
  const departmentIdsByName = new Map<string, number>()
  lockedApprovals.forEach((approval) => {
    if (approval.department_name) departmentIdsByName.set(approval.department_name, approval.department_id)
  })
  additionalDepartmentOptions.forEach((department) => departmentIdsByName.set(department.name, department.id))
  const selectedAdditionalDepartmentEntries = selectedDepartmentIds
    .map((departmentId) => {
      const eligible = additionalDepartmentOptions.find((department) => department.id === departmentId)
      const name = eligible?.name || fallbackNames.get(departmentId)
      return name ? { id: departmentId, name, eligible: Boolean(eligible) } : null
    })
    .filter((entry): entry is { id: number; name: string; eligible: boolean } => Boolean(entry))
  const selectedAdditionalDepartments = selectedAdditionalDepartmentEntries.map((entry) => entry.name)
  const unavailableSelectedDepartments = selectedAdditionalDepartmentEntries.filter((entry) => !entry.eligible)

  function setSelectedNames(names: string[]) {
    onChange(names
      .map((name) => departmentIdsByName.get(name))
      .filter((departmentId): departmentId is number => typeof departmentId === 'number'))
  }

  return (
    <div className="form-section">
      <div className="form-section-title">Additional Department Approvals</div>
      {editable ? <>
        <div className="suppression-approval-routing">
          <div className="suppression-routing-intro">
            <span>Optional approval route</span>
            <strong>Does this suppression need sign-off from other departments?</strong>
            <p>The owning department remains mandatory. Add other departments only when their risk acceptance is required.</p>
          </div>
          <div className="suppression-routing-choices" role="radiogroup" aria-label="Additional department approval requirement">
            <button
              type="button"
              role="radio"
              aria-checked={!requiresAdditionalApprovals}
              className={!requiresAdditionalApprovals ? 'active' : ''}
              onClick={() => {
                onRequirementChange(false)
                onChange([])
              }}
            >
              <i aria-hidden="true" />
              <span><strong>No additional approval</strong><small>Continue with the owning department only</small></span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={requiresAdditionalApprovals}
              className={requiresAdditionalApprovals ? 'active' : ''}
              onClick={() => onRequirementChange(true)}
            >
              <i aria-hidden="true" />
              <span><strong>Yes, add departments</strong><small>All selected Department Heads must approve</small></span>
            </button>
          </div>
        </div>
        <DepartmentLoadNotice error={error} loading={loading} onRetry={onRetry} />
        {owningDepartmentEligible === false && (
          <div className="execution-cycle-required-warning" role="alert">
            <strong>Owning department approval is unavailable</strong>
            <span>
              {owningDepartment || 'The owning department'} has no active, eligible Department Head who can act in this request&apos;s workspace.
              Assign the required workspace access before saving or submitting this request.
            </span>
          </div>
        )}
        {unavailableSelectedDepartments.length > 0 && (
          <div className="execution-cycle-required-warning" role="alert">
            <strong>Previously selected department is no longer eligible</strong>
            <span>Remove each department marked Unavailable, or restore an eligible Department Head&apos;s workspace access, before saving.</span>
          </div>
        )}
        {requiresAdditionalApprovals && (
          <div className="suppression-routing-selector">
            <Field label="Required departments *">
              <MultiSelect
                value={selectedAdditionalDepartments}
                onChange={setSelectedNames}
                options={additionalDepartmentOptions.map((department) => department.name)}
                placeholder="Choose required departments…"
                itemName="department"
                searchPlaceholder="Search departments…"
                showBulkActions={false}
                variant="approval-routing"
                disabled={loading || Boolean(error)}
              />
            </Field>
            <p>Only departments with an active, eligible Department Head for this request&apos;s workspace are available.</p>
            {selectedAdditionalDepartments.length > 0 && (
              <div className="suppression-routing-selected" aria-label="Selected departments">
                {selectedAdditionalDepartmentEntries.map((department) => (
                  <button
                    key={department.id}
                    type="button"
                    className={department.eligible ? '' : 'unavailable'}
                    onClick={() => onChange(selectedDepartmentIds.filter((id) => id !== department.id))}
                    aria-label={`Remove ${department.name}${department.eligible ? '' : ' (unavailable)'}`}
                  >
                    {department.name}
                    {!department.eligible && <small>Unavailable</small>}
                    <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
            )}
            <p>
              <strong>{selectedAdditionalDepartments.length}</strong> additional department
              {selectedAdditionalDepartments.length === 1 ? '' : 's'} required before Security Team verification.
            </p>
          </div>
        )}
      </> : <>
        <p className="muted small">
          Approval routing is locked after SM approval. Return and relink the request to restart the workflow if ownership must change.
        </p>
        <div className="suppression-routing-selected" aria-label="Locked required departments">
          {lockedApprovals.map((approval) => (
            <span className="badge badge-blue" key={approval.department_id}>
              {approval.department_name || 'Unknown department'}
            </span>
          ))}
        </div>
      </>}
    </div>
  )
}
