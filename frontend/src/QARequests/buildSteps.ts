import { FUNCTIONAL_BUCKET_TYPES } from '../constants'
import { WizardStep } from './types'

// Decides which wizard steps to show, based on which request types are
// currently ticked on the "Request Type" step.
export function buildSteps(requestTypes: string[]): WizardStep[] {
  const steps: WizardStep[] = [
    { key: 'details', label: 'Application & Change Details' },
    { key: 'type', label: 'Request Type' },
  ]
  // Functional/Sanity/Regression/UAT Support share one combined Functional
  // Testing Request -- this step is where it gets its own independent
  // Priority + Risk Rating (see models.FunctionalRequest), same idea as the
  // Priority/Risk Category fields added to the top of the sast/dast/
  // performance steps below.
  // Functional Testing's own "Ready for Testing" readiness checklist is
  // self-declared right on this same step (not a separate one) -- see
  // FunctionalStep.tsx, which folds the checklist in alongside Priority/Risk
  // Rating -- matching how SAST/DAST already self-declare their own Security
  // Readiness checklist within their own step instead of a separate one.
  if (requestTypes.some((t) => FUNCTIONAL_BUCKET_TYPES.includes(t))) steps.push({ key: 'functional', label: 'Functional QA Classification' })
  if (requestTypes.includes('SAST')) steps.push({ key: 'sast', label: 'SAST Details' })
  if (requestTypes.includes('DAST')) steps.push({ key: 'dast', label: 'DAST Details' })
  if (requestTypes.includes('Performance Testing')) steps.push({ key: 'performance', label: 'Performance Testing' })
  steps.push({ key: 'documents', label: 'Documents & Review' })
  return steps
}
