import { QARequestForm, SAST_COMPONENT_FIELDS } from './types'
import { validEnvironmentPromotion, validTargetPromotionOptions } from '../constants'

// Mandatory text fields on the "Application & Change Details" / "Release &
// Environment" steps (everything marked "(*)" in the QA Request field spec).
// The select-type mandatory fields (Change Type, Deployment Environment,
// Priority, Risk Rating) never need a separate "is it filled in" check here
// -- their dropdowns always default to a real (non-blank) value, so they
// can't be left empty through the UI.
//
// Target Promotion Environment is the one exception -- reported directly:
// "'Select Target Promotion Environment' is getting as selection... still
// it's allowing to go next." Unlike the other selects above, its own
// dropdown (DetailsStep.tsx/Functional.tsx's Edit Details modal) always
// renders a real blank `<option value="">Select Target Promotion
// Environment</option>` placeholder alongside the real choices, so it CAN
// be left on that blank value and submitted -- the comment this replaced
// wrongly assumed otherwise. Checked explicitly below instead, but only
// when there's actually a valid choice to make: if Deployment Environment
// is already "Production" (the final pipeline stage), there is no later
// stage to promote to -- validTargetPromotionOptions returns an empty list,
// and DetailsStep.tsx itself now reflects that by disabling the field and
// dropping its "*" -- so requiring a value there would make the form
// impossible to complete instead of just quietly under-validated.
const REQUIRED_DETAIL_FIELDS: { key: keyof QARequestForm; label: string }[] = [
  { key: 'application_name', label: 'Application Name' },
  { key: 'application_owner', label: 'Application Owner' },
  { key: 'cr_number', label: 'CR Number/EPIC Number' },
  { key: 'technology_stack', label: 'Technology Stack' },
  { key: 'change_description', label: 'Change Description' },
  // { key: 'release_version', label: 'Release Version / Hash Value' },
  // { key: 'build_number', label: 'Build Number / Hash Value' },
]

// Exported so steps/DetailsStep.tsx's inline onBlur error text checks the
// exact same rule as the real gate below, instead of keeping its own
// separate copy that could silently drift out of sync with this one.
//
// Reported directly: "max length 15" -- both alternatives now cap out at 15
// characters total (prefix included): CR-<up to 12 digits> or EPIC-<up to
// 10 digits>. DetailsStep.tsx's own `maxLength={11}` on the input was
// already inconsistent with this regex even before this change (11 is
// shorter than EPIC-123456789's 14 chars), so that's raised to 15 too.
export const CR_OR_EPIC_NUMBER_REGEX = /^(?:CR-[0-9]{1,12}|EPIC-[0-9]{1,10})$/

// Because each wizard step's fields are unmounted once you move to another
// step, the browser's native `required` attribute can't catch a missing
// field from an earlier step at final-submit time -- these checks run
// explicitly instead (both before advancing past the relevant step, and
// again as a final safety check right before submit -- see
// NewRequestModal.tsx's `goNext`/`submit`).
export function detailsStepError(f: QARequestForm): string | null {
  const missing = REQUIRED_DETAIL_FIELDS.filter(({ key }) => !String(f[key] || '').trim())
  if (missing.length > 0) return `Please fill in: ${missing.map((m) => m.label).join(', ')}`
  // Reported directly: DetailsStep.tsx already showed an inline "Invalid
  // format" message under CR Number/EPIC Number on blur, but that
  // check lived only in local component state -- Next/Submit never
  // consulted it, so a clearly-flagged invalid value still went through.
  // Enforced here instead, the same place every other mandatory-field rule
  // already lives, so it actually blocks Next/Submit like the on-screen
  // error implies it should.
  if (!CR_OR_EPIC_NUMBER_REGEX.test(f.cr_number.trim())) {
    return 'CR Number/EPIC Number is not in a valid format. Example: CR-1234 or EPIC-123456'
  }
  // Reported directly -- see this function's own header comment for the
  // full story. Only enforced when there's actually a valid choice
  // (Deployment Environment isn't already the final "Production" stage);
  // DetailsStep.tsx mirrors this same condition to disable the field and
  // drop its "*" in that edge case, so the message and the UI never
  // disagree about whether a value is actually required right now.
  if (validTargetPromotionOptions(f.environment).length > 0 && !f.target_promotion_environment) {
    return 'Please select a Target Promotion Environment.'
  }
  // DetailsStep.tsx's own Target Promotion Environment dropdown already
  // only offers options strictly later than the picked Deployment
  // Environment (and auto-corrects itself when Deployment changes), so this
  // should never actually trip in normal use -- kept as a real gate anyway
  // (same belt-and-braces reasoning as the CR/Epic format checks above) in
  // case a Draft saved before this rule existed still has a stale, now-
  // invalid combination on it.
  if (!validEnvironmentPromotion(f.environment, f.target_promotion_environment)) {
    return `Target Promotion Environment ('${f.target_promotion_environment}') must be later than Deployment Environment ('${f.environment}') in the pipeline SIT -> UAT -> Pre-Production -> Production.`
  }
  return null
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
