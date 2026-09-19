export const DEFECT_EVIDENCE_EXTENSIONS = [
  '.csv', '.doc', '.docx', '.eml', '.gif', '.har', '.jpeg', '.jpg',
  '.jmx', '.json', '.log', '.msg', '.pdf', '.png', '.ppt', '.pptx',
  '.txt', '.webp', '.xls', '.xlsx', '.xml', '.zip',
  '.avi', '.mov', '.mp4', '.webm',
]

export function defectEvidenceError(files: readonly Pick<File, 'name' | 'size'>[]): string | null {
  if (files.length > 20) return 'Upload at most 20 evidence files at a time.'
  for (const file of files) {
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!DEFECT_EVIDENCE_EXTENSIONS.includes(extension)) return `"${file.name}" is not an allowed evidence type. Remove or replace it before submitting.`
    if (file.size > 25 * 1024 * 1024) return `"${file.name}" exceeds the 25 MB limit. Remove or replace it before submitting.`
  }
  return null
}
