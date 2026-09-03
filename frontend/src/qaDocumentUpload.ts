export const QA_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024
export const QA_DOCUMENT_SIZE_HINT = 'Maximum 10 MB per file. Multiple files allowed.'

export function qaDocumentSizeError(files: readonly Pick<File, 'name' | 'size'>[]): string | null {
  const oversized = files.find((file) => file.size > QA_DOCUMENT_MAX_BYTES)
  return oversized ? `"${oversized.name}" exceeds the 10 MB limit. Each file must be 10 MB or smaller.` : null
}

export function isQaEvidenceUpload(path: string): boolean {
  return /^\/api\/qa-requests\/\d+\/checklist-evidence\/[^/]+\/\d+\/documents$/.test(path)
}
