import type { DefectLinkableExecutionOut } from './types'

/** Prefer the execution snapshot; an explicit null means no module. */
export function defectExecutionModule(context?: DefectLinkableExecutionOut): string {
  if (!context) return ''
  if (Object.prototype.hasOwnProperty.call(context, 'module_name')) return context.module_name || ''
  return context.execution.test_case?.module_name || ''
}
