import type { DefectLinkableExecutionOut, QARequestListOut } from './types'

/** A testcase area must never enter the application-module catalogue. */
export function defectRequestModule(request?: Pick<QARequestListOut, 'module_name'>): string {
  return request?.module_name || ''
}

/** Read only a pinned execution snapshot, including older API snapshots. */
export function defectExecutionFeatureArea(context?: DefectLinkableExecutionOut): string {
  if (!context?.execution.pinned_version_id) return ''
  if (Object.prototype.hasOwnProperty.call(context, 'feature_area')) return context.feature_area || ''
  return context.module_name || ''
}
