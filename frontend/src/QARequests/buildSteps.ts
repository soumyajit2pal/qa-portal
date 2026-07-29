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
  if (requestTypes.some((t) => FUNCTIONAL_BUCKET_TYPES.includes(t))) steps.push({ key: 'functional', label: 'Functional QA Classification' })
  if (requestTypes.includes('SAST')) steps.push({ key: 'sast', label: 'SAST Details' })
  if (requestTypes.includes('DAST')) steps.push({ key: 'dast', label: 'DAST Details' })
  if (requestTypes.includes('Performance Testing')) steps.push({ key: 'performance', label: 'Performance Testing' })
  // This checklist is Functional Testing's own "Ready for Testing" readiness
  // checklist -- only relevant while one of the Functional bucket types is
  // selected (SAST/DAST no longer feed into it at all; they have their own
  // dedicated Security Readiness checklist instead, self-declared on their
  // own SAST/DAST step above, or afterward from their own module's Edit
  // Details).
  if (requestTypes.some((t) => FUNCTIONAL_BUCKET_TYPES.includes(t))) {
    steps.push({ key: 'checklist', label: 'Readiness Checklist' })
  }
  steps.push({ key: 'documents', label: 'Documents & Review' })
  return steps
}
