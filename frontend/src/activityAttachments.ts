export const ACTIVITY_MAX_ATTACHMENTS = 8
export const ACTIVITY_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const ACTIVITY_ATTACHMENT_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'log'] as const
export const ACTIVITY_ATTACHMENT_ACCEPT = ACTIVITY_ATTACHMENT_EXTENSIONS.map(extension => `.${extension}`).join(',')

export function activityFileExtension(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function activityAttachmentKind(file: { file_name: string; content_type?: string | null }): 'image' | 'pdf' | 'document' {
  const extension = activityFileExtension(file.file_name)
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return 'image'
  if (extension === 'pdf') return 'pdf'
  return 'document'
}

export function activityImageBlob(file: { file_name: string }, blob: Blob): Blob {
  const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[activityFileExtension(file.file_name)]
  if (!mime) throw new Error('This attachment is not a supported image.')
  // Legacy evidence endpoints may reflect a client-supplied MIME. A preview
  // opened in a new tab must never become an executable HTML/SVG Blob.
  return blob.type === mime ? blob : new Blob([blob], { type: mime })
}

export function activityAttachmentType(name: string) {
  const extension = activityFileExtension(name)
  return extension === 'jpg' || extension === 'jpeg' ? 'JPEG' : extension.toUpperCase() || 'FILE'
}

export function activityAttachmentSize(size?: number | null) {
  if (size == null || !Number.isFinite(size) || size < 0) return 'Size unavailable'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function activityAttachmentError(files: { name: string; size: number }[], existingCount = 0): string | null {
  if (existingCount + files.length > ACTIVITY_MAX_ATTACHMENTS) return `A comment can contain at most ${ACTIVITY_MAX_ATTACHMENTS} files, including inline images.`
  for (const file of files) {
    if (!(ACTIVITY_ATTACHMENT_EXTENSIONS as readonly string[]).includes(activityFileExtension(file.name))) return `“${file.name}” is not supported. Use an image, PDF, Word, Excel, CSV, TXT or LOG file.`
    if (file.size > ACTIVITY_MAX_ATTACHMENT_BYTES) return `“${file.name}” exceeds the 10 MB file limit.`
    if (file.size === 0) return `“${file.name}” is empty. Choose a file containing evidence.`
  }
  return null
}
