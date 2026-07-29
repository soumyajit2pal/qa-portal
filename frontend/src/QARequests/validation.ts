import { QARequestForm, SAST_COMPONENT_FIELDS } from './types'

// Mandatory text fields on the "Application & Change Details" / "Release &
// Environment" steps (everything marked "(*)" in the QA Request field spec).
// The select-type mandatory fields (Change Type, Deployment Environment,
// Target Promotion Environment, Priority, Risk Rating) never need a separate
// check here -- their dropdowns always default to a real (non-blank) value,
// so they can't be left empty through the UI.
const REQUIRED_DETAIL_FIELDS: { key: keyof QARequestForm; label: string }[] = [
  { key: 'application_name', label: 'Application Name' },
  { key: 'application_owner', label: 'Application Owner' },
  { key: 'cr_number', label: 'Change Request ID(s)' },
  { key: 'epic_number', label: 'Epic Number' },
  { key: 'technology_stack', label: 'Technology Stack' },
  // { key: 'release_version', label: 'Release Version / Hash Value' },
  // { key: 'build_number', label: 'Build Number / Hash Value' },
]

// Because each wizard step's fields are unmounted once you move to another
// step, the browser's native `required` attribute can't catch a missing
// field from an earlier step at final-submit time -- these checks run
// explicitly instead (both before advancing past the relevant step, and
// again as a final safety check right before submit -- see
// NewRequestModal.tsx's `goNext`/`submit`).
export function detailsStepError(f: QARequestForm): string | null {
  const missing = REQUIRED_DETAIL_FIELDS.filter(({ key }) => !String(f[key] || '').trim())
  return missing.length > 0 ? `Please fill in: ${missing.map((m) => m.label).join(', ')}` : null
}

export function typeStepError(f: QARequestForm): string | null {
  return f.request_types.length === 0 ? 'Select at least one Request Type.' : null
}

// Every field of every SAST component is mandatory -- each row added via the
// "+" (RepeatableGroupInput) is a full repository/branch/commit/tech
// stack/build number set, and every one of those rows must be complete.
// Skipped once the linked SAST request already exists (existingSast), or
// once SAST isn't even a selected request type -- in the latter case there's
// no "sast" step in the wizard at all (see buildSteps), so this must bail
// out *before* checking the (still-blank, irrelevant) sast_components rows.
// Without this check, calling this from submit()'s safety net on a
// DAST-only request would wrongly flag the untouched blank SAST row as
// incomplete, then try to jump to a "sast" step that doesn't exist --
// steps.findIndex returns -1, stepIndex becomes -1, and the next render
// crashes on `steps[-1].key` (blank screen, no API call ever fires).
export function sastStepError(f: QARequestForm, existingSast: boolean): string | null {
  if (existingSast || !f.request_types.includes('SAST')) return null
  const incomplete = f.sast_components.some((c) => SAST_COMPONENT_FIELDS.some((field) => !c[field.key]?.trim()))
  return incomplete
    ? 'Please fill in every field (Repository URL, Branch, Commit ID, Tech Stack, Build Number) for each repository row.'
    : null
}

// Test Credentials is only mandatory on a target that has its own
// Authentication Required ticked -- otherwise there's nothing to fill in
// (the field isn't even shown). Skipped once the linked DAST request
// already exists (existingDast), or once DAST isn't a selected request
// type -- same "sast" step crash reasoning as above, mirrored for "dast".
export function dastStepError(f: QARequestForm, existingDast: boolean): string | null {
  if (existingDast || !f.request_types.includes('DAST')) return null
  const missingCreds = f.dast_components.some((c) => c.authentication_required && !c.test_credentials.trim())
  return missingCreds
    ? 'Test Credentials is required for any target with Authentication Required ticked.'
    : null
}
