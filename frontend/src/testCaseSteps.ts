import type { TestStepIn } from './types'

export function testCaseStepErrors(steps: TestStepIn[]): string[] {
  if (!steps.length) return ['Add at least one test step.']

  const errors: string[] = []
  const blankSteps = steps
    .map((step, index) => ({ step, number: index + 1 }))
    .filter(({ step }) => !step.step_text?.trim())
    .map(({ number }) => number)
  if (blankSteps.length) errors.push(`Provide step text for step ${blankSteps.join(', ')}.`)
  if (!steps.some((step) => step.expected_result?.trim())) {
    errors.push('Add at least one expected result for this testcase.')
  }
  return errors
}
