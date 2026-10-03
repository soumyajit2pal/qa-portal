import React, { useMemo, useRef, useState, useEffect } from 'react'
import { api, mapWithConcurrency } from '../api'
import { formatDateIST, formatDateTimeIST, portalDate } from '../time'
import { useAuth } from '../context/AuthContext'
import { activeWorkspaceId, formatRoleLabels, isViewOnly, uniqueWorkspaceAccess } from '../constants'
import { ApprovalActionOut, RequestDocumentOut } from '../types'
import { EmptyState, ErrorText } from './Common'
import {
  editorContentToMarkdown,
  safeRichTextLink,
  useRichTextImages,
  useRichTextLink,
  RichTextToolbar,
  RichTextImageInput,
  RichTextLinkEditor,
  RichTextPastedImages,
  normalizeStoredRichText,
  insertRichTextImages,
  decodeRichImageName,
  pasteStructuredRichText,
  PendingRichImage,
  RICH_TEXT_IMAGE_TYPES,
  richTextImageFilename,
} from './RichTextEditor'
import { decodeMergedRichTable } from '../richTableCodec'
import { isMarkdownTableSeparator, parseMarkdownHeading, splitMarkdownTableRow } from '../markdownSyntax'
import { isActivityReadOnly } from '../activityAccess'
import { ACTIVITY_MAX_ATTACHMENTS, activityAttachmentError, activityAttachmentKind, activityImageBlob } from '../activityAttachments'
import { ActivityAttachmentCard, ActivityAttachmentPicker, PendingActivityAttachment } from './ActivityAttachments'

type ActivityFilter = 'all' | 'comments' | 'history'
const INLINE_IMAGE_PATTERN = /^!\[([^\]]*)\]\(attachment:([^)]+)\)$/

const COMMENT_WORKFLOW_ROLES = new Set([
  'REQUESTER', 'DEVELOPER', 'BUSINESS_ANALYST', 'APPLICATION_OWNER', 'SM',
  'DEPARTMENT_HEAD_CM', 'DEPARTMENT_HEAD_AGM', 'QA_ENGINEER', 'QA_LEAD',
  'CHIEF_MANAGER_QA', 'AGM_QA', 'SECURITY_ANALYST',
])

function initials(name?: string | null): string {
  const parts = (name || '?').trim().split(/\s+/)
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase()
}

function actorLabel(item: ApprovalActionOut): string {
  return item.actor_name || formatRoleLabels(item.actor_role, ' · ') || 'System'
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - portalDate(value).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatDateIST(value)
}

// ---- Rendering a posted comment's stored markdown back to React (display
// only -- the inverse direction, markdown -> contentEditable HTML for
// editing, lives in RichTextEditor.tsx since JiraRichTextField needs it
// too; this markdown -> React-nodes direction is only ever needed here) ----

function inlineMarkdown(value: string, keyPrefix: string, depth = 0): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let cursor = 0
  let index = 0
  while (cursor < value.length) {
    let start = cursor
    while (start < value.length && !'[*~`'.includes(value[start])) start += 1
    if (start >= value.length) { nodes.push(value.slice(cursor)); break }
    if (start > cursor) nodes.push(value.slice(cursor, start))
    let open = value[start]
    let close = open
    let contentStart = start + 1
    if (value.startsWith('[u]', start)) { open = '[u]'; close = '[/u]'; contentStart = start + 3 }
    else if (value.startsWith('**', start)) { open = '**'; close = '**'; contentStart = start + 2 }
    else if (value.startsWith('~~', start)) { open = '~~'; close = '~~'; contentStart = start + 2 }
    else if (open === '[') {
      const labelEnd = value.indexOf('](', contentStart)
      const hrefEnd = labelEnd >= 0 ? value.indexOf(')', labelEnd + 2) : -1
      if (labelEnd >= 0 && hrefEnd >= 0) {
        const href = safeRichTextLink(value.slice(labelEnd + 2, hrefEnd))
        const key = `${keyPrefix}-${index++}`
        nodes.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer">{value.slice(contentStart, labelEnd)}</a> : value.slice(start, hrefEnd + 1))
        cursor = hrefEnd + 1
        continue
      }
      nodes.push(value[start]); cursor = start + 1; continue
    } else if (open === '*' && value[start + 1] === '*') {
      open = '**'; close = '**'; contentStart = start + 2
    }
    const end = value.indexOf(close, contentStart)
    if (end < 0 || end === contentStart || (open === '*' && value.slice(contentStart, end).includes('\n'))) {
      nodes.push(value[start]); cursor = start + 1; continue
    }
    const content = value.slice(contentStart, end)
    const key = `${keyPrefix}-${index++}`
    const nested = depth < 10 ? inlineMarkdown(content, key, depth + 1) : content
    if (open === '[u]') nodes.push(<u key={key}>{nested}</u>)
    else if (open === '**') nodes.push(<strong key={key}>{nested}</strong>)
    else if (open === '~~') nodes.push(<s key={key}>{nested}</s>)
    else if (open === '`') nodes.push(<code key={key}>{content}</code>)
    else nodes.push(<em key={key}>{nested}</em>)
    cursor = end + close.length
  }
  return nodes
}

export function MarkdownComment({ value, attachmentUrls = {} }: { value: string; attachmentUrls?: Record<string, string> }) {
  const lines = normalizeStoredRichText(value).split('\n')
  const isTableStart = (lineIndex: number) =>
    lineIndex + 1 < lines.length &&
    lines[lineIndex].includes('|') &&
    isMarkdownTableSeparator(lines[lineIndex + 1])
  const blocks: React.ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { index += 1; continue }
    const mergedTable = decodeMergedRichTable(line)
    if (mergedTable) {
      blocks.push(
        <div className="jira-markdown-table-wrap" key={`merged-table-${index}`}>
          <table><tbody>{mergedTable.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, cellIndex) => {
              const Cell = cell.h ? 'th' : 'td'
              return <Cell key={cellIndex} colSpan={cell.c} rowSpan={cell.r}>{inlineMarkdown(cell.t, `merged-${index}-${rowIndex}-${cellIndex}`)}</Cell>
            })}</tr>
          ))}</tbody></table>
        </div>,
      )
      index += 1
      continue
    }
    const image = line.match(INLINE_IMAGE_PATTERN)
    if (image) {
      const name = decodeRichImageName(image[2])
      const url = attachmentUrls[name]
      blocks.push(url
        ? <button type="button" className="jira-inline-rich-image" key={`image-${index}`} title={`Open ${image[1] || name}`} onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}><img src={url} alt={image[1] || name} /></button>
        : <span className="jira-inline-image-missing" key={`image-${index}`}>▧ {image[1] || name}</span>)
      index += 1
      continue
    }
    const heading = parseMarkdownHeading(line)
    if (heading) {
      const HeadingTag = `h${heading.level}` as keyof React.JSX.IntrinsicElements
      blocks.push(<HeadingTag key={`heading-${index}`}>{inlineMarkdown(heading.text, `heading-${index}`)}</HeadingTag>)
      index += 1
      continue
    }
    if (isTableStart(index)) {
      const cells = splitMarkdownTableRow
      const header = cells(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() && !INLINE_IMAGE_PATTERN.test(lines[index])) rows.push(cells(lines[index++]))
      blocks.push(<div className="jira-markdown-table-wrap" key={`table-${index}`}><table><thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{inlineMarkdown(cell, `th-${index}-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inlineMarkdown(cell, `td-${index}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*]\s+/, ''))
      blocks.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, `ul-${index}-${itemIndex}`)}</li>)}</ul>)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*\d+\.\s+/, ''))
      blocks.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, `ol-${index}-${itemIndex}`)}</li>)}</ol>)
      continue
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={`quote-${index}`}>{quote.map((entry, quoteIndex) => <React.Fragment key={quoteIndex}>{inlineMarkdown(entry, `quote-${index}-${quoteIndex}`)}{quoteIndex < quote.length - 1 && <br />}</React.Fragment>)}</blockquote>)
      continue
    }
    const paragraph: string[] = [line]
    index += 1
    while (index < lines.length && lines[index].trim() && !decodeMergedRichTable(lines[index]) && !isTableStart(index) && !INLINE_IMAGE_PATTERN.test(lines[index]) && !/^\s*(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s?)/.test(lines[index])) paragraph.push(lines[index++])
    blocks.push(<p key={`p-${index}`}>{paragraph.map((entry, paragraphIndex) => <React.Fragment key={paragraphIndex}>{inlineMarkdown(entry, `p-${index}-${paragraphIndex}`)}{paragraphIndex < paragraph.length - 1 && <br />}</React.Fragment>)}</p>)
  }
  return <div className="jira-markdown">{blocks}</div>
}

export function AuthenticatedMarkdown({ value, basePath }: { value: string; basePath: string }) {
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({})
  useEffect(() => {
    let active = true
    const createdUrls: string[] = []
    setAttachmentUrls({})
    api.get<RequestDocumentOut[]>(basePath).then(async (documents) => {
      if (!active) return
      const loaded = await mapWithConcurrency(documents.filter(document => activityAttachmentKind(document) === 'image'), 3, async (document) => {
        if (!active) return null
        try {
          const blob = await api.getBlob(`${basePath}/${document.id}/download`)
          if (!active) return null
          const url = URL.createObjectURL(activityImageBlob(document, blob)); createdUrls.push(url)
          return [document.file_name, url] as const
        } catch { return null }
      })
      if (active) setAttachmentUrls(Object.fromEntries(loaded.filter((entry): entry is readonly [string, string] => entry !== null)))
    }).catch(() => undefined)
    return () => { active = false; createdUrls.forEach((url) => URL.revokeObjectURL(url)) }
  }, [basePath])
  return <MarkdownComment value={value} attachmentUrls={attachmentUrls} />
}

function CommentContent({ commentId, value }: { commentId: number; value: string }) {
  const [documents, setDocuments] = useState<RequestDocumentOut[]>([])
  const [urls, setUrls] = useState<Record<number, string>>({})
  const [loadingIds, setLoadingIds] = useState<number[]>([])
  const [error, setError] = useState<unknown>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const generation = useRef(0)
  const createdUrls = useRef(new Set<string>())
  const pdfUrls = useRef(new Map<number, string>())
  const pendingPopups = useRef(new Set<Window>())
  const busyIds = useRef(new Set<number>())
  const basePath = `/api/approvals/comments/${commentId}/attachments`

  useEffect(() => {
    const version = ++generation.current
    const active = () => generation.current === version
    setDocuments([]); setUrls({}); setLoadingIds([]); setLoadError(''); setError(null)
    async function load() {
      try {
        const docs = await api.get<RequestDocumentOut[]>(basePath)
        if (!active()) return
        setDocuments(docs)
        // Only image bytes are needed to render the feed. Documents stay metadata-only.
        const loaded = await mapWithConcurrency(docs.filter(document => activityAttachmentKind(document) === 'image'), 3, async document => {
          if (!active()) return null
          try {
            const blob = await api.getBlob(`${basePath}/${document.id}/download`)
            if (!active()) return null
            const url = URL.createObjectURL(activityImageBlob(document, blob))
            createdUrls.current.add(url)
            return [document.id, url] as const
          } catch {
            if (active()) setLoadError('Some comment images could not be loaded.')
            return null
          }
        })
        if (active()) setUrls(Object.fromEntries(loaded.filter((entry): entry is readonly [number, string] => entry !== null)))
      } catch {
        if (active()) setLoadError('Comment attachments could not be loaded.')
      }
    }
    void load()
    return () => {
      generation.current += 1
      createdUrls.current.forEach(url => URL.revokeObjectURL(url)); createdUrls.current.clear()
      pdfUrls.current.clear(); busyIds.current.clear()
      pendingPopups.current.forEach(popup => { if (!popup.closed) popup.close() }); pendingPopups.current.clear()
    }
  }, [basePath, reload])

  function markBusy(id: number, loading: boolean) {
    if (loading) busyIds.current.add(id)
    else busyIds.current.delete(id)
    setLoadingIds([...busyIds.current])
  }

  async function download(attachment: RequestDocumentOut) {
    if (busyIds.current.has(attachment.id)) return
    const version = generation.current
    markBusy(attachment.id, true); setError(null)
    try {
      const blob = await api.getBlob(`${basePath}/${attachment.id}/download`, 600_000)
      if (generation.current !== version) return
      const url = URL.createObjectURL(blob); createdUrls.current.add(url)
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = attachment.file_name
      anchor.click()
      setTimeout(() => { URL.revokeObjectURL(url); createdUrls.current.delete(url) }, 1000)
    } catch (err) { if (generation.current === version) setError(err) }
    finally { if (generation.current === version) markBusy(attachment.id, false) }
  }

  async function preview(attachment: RequestDocumentOut) {
    if (busyIds.current.has(attachment.id)) return
    if (activityAttachmentKind(attachment) === 'image') {
      if (urls[attachment.id]) window.open(urls[attachment.id], '_blank', 'noopener,noreferrer')
      return
    }
    // Open on the user's click, before the authenticated fetch can trigger popup blocking.
    const popup = window.open('about:blank', '_blank')
    if (!popup) { setError(new Error('The preview tab was blocked. Allow pop-ups for this portal or use Download.')); return }
    popup.opener = null
    pendingPopups.current.add(popup)
    const version = generation.current
    markBusy(attachment.id, true); setError(null)
    try {
      let url = pdfUrls.current.get(attachment.id)
      if (!url) {
        const blob = await api.getBlob(`${basePath}/${attachment.id}/download`, 600_000)
        if (generation.current !== version || popup.closed) return
        if (await blob.slice(0, 5).text() !== '%PDF-') throw new Error('This attachment cannot be previewed as a PDF. Use Download to review the file.')
        if (generation.current !== version || popup.closed) return
        url = URL.createObjectURL(blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }))
        createdUrls.current.add(url); pdfUrls.current.set(attachment.id, url)
      }
      if (!popup.closed) popup.location.replace(url)
    } catch (err) {
      if (!popup.closed) popup.close()
      if (generation.current === version) setError(err)
    } finally {
      pendingPopups.current.delete(popup)
      if (generation.current === version) markBusy(attachment.id, false)
    }
  }

  const inlineDocuments = new Map(documents.filter(document => urls[document.id]).map(document => [document.file_name, document]))
  const attachmentUrls = Object.fromEntries([...inlineDocuments].map(([name, document]) => [name, urls[document.id]]))
  const referenced = new Set(normalizeStoredRichText(value).split('\n').flatMap(line => {
    const image = line.match(INLINE_IMAGE_PATTERN)
    return image ? [decodeRichImageName(image[2])] : []
  }))
  // A filename is not a unique document ID. Hide only the actual rendered
  // image; keep duplicate names and non-rendered legacy references accessible.
  const inlineIds = new Set([...referenced].map(name => inlineDocuments.get(name)?.id))
  const unplaced = documents.filter(document => !inlineIds.has(document.id))
  return <>
    {value && <div className="jira-activity-message comment-box"><MarkdownComment value={value} attachmentUrls={attachmentUrls} /></div>}
    {unplaced.length > 0 && <div className="jira-comment-files" aria-label="Comment attachments">{unplaced.map(attachment => <ActivityAttachmentCard key={attachment.id} attachment={attachment} imageUrl={urls[attachment.id]} busy={loadingIds.includes(attachment.id)} onPreview={() => void preview(attachment)} onDownload={() => void download(attachment)} />)}</div>}
    {loadError && <div className="activity-attachment-load-error" role="status">{loadError} <button type="button" onClick={() => setReload(current => current + 1)}>Retry loading attachments</button></div>}
    <ErrorText error={error} title="Attachment could not be opened" guidance="Try Preview PDF or Download again. Your comment remains available." />
  </>
}

export interface JiraActivityProps {
  readOnly?: boolean
  ownerWorkspaceId?: number | null
  workflowHistory?: Record<string, any>[]
  entityType: string
  entityId: number
  items: ApprovalActionOut[]
  onPosted: (item: ApprovalActionOut) => void
}

export default function JiraActivity(props: JiraActivityProps) {
  const { user } = useAuth()
  return <JiraActivityContent key={`${props.entityType}:${props.entityId}:${props.ownerWorkspaceId ?? ''}:${activeWorkspaceId(user) ?? ''}`} {...props} />
}

export function JiraActivityContent({ entityType, entityId, items, onPosted, workflowHistory, readOnly = false, ownerWorkspaceId }: JiraActivityProps) {
  const { user } = useAuth()
  const selectedWorkspaceId = activeWorkspaceId(user)
  const activeWorkspaceAccess = uniqueWorkspaceAccess(user).find(
    (access) => access.workspace_id === selectedWorkspaceId,
  )
  const adminWithoutWorkflowRole = !!user?.roles.includes('ADMIN')
    && !user.roles.some((role) => COMMENT_WORKFLOW_ROLES.has(role))
  const accessIsReadOnly = isViewOnly(user)
    || activeWorkspaceAccess?.role === 'PARENT_WORKSPACE_VIEWER'
    || adminWithoutWorkflowRole
  const isReadOnly = isActivityReadOnly(
    readOnly || accessIsReadOnly,
    selectedWorkspaceId,
    ownerWorkspaceId,
  )
  const editorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInsertRange = useRef<Range | null>(null)
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const posting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [attachments, setAttachments] = useState<PendingActivityAttachment[]>([])
  const attachmentsRef = useRef<PendingActivityAttachment[]>([])
  const attachmentSequence = useRef(0)
  const inlineImagesRef = useRef<PendingRichImage[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [characterCount, setCharacterCount] = useState(0)

  const { images, addImages, removeImage, clearImages, pasteImages } = useRichTextImages({
    filenamePrefix: 'pasted-image',
    maxImages: ACTIVITY_MAX_ATTACHMENTS - attachments.length,
    messages: {
      tooLarge: (name) => `“${name}” exceeds the 10 MB image limit.`,
      tooMany: () => `A comment can contain at most ${ACTIVITY_MAX_ATTACHMENTS} files, including inline images.`,
    },
    onError: setError,
  })
  const { showLink, linkUrl, setLinkUrl, linkInputRef, beginLink, applyLink, cancelLink } = useRichTextLink(editorRef, setError)
  useEffect(() => { inlineImagesRef.current = images }, [images])

  const timeline = useMemo(() => {
    const entries: (ApprovalActionOut & { workflowEvent?: Record<string, any> })[] = items.map(item => ({ ...item }))
    for (const [index, event] of (workflowHistory || []).entries()) {
      const summary = [event.remarks, event.environment, event.build, event.result, event.reference].filter(Boolean).join('\n') || event.kind
      const match = entries.filter(item => !item.workflowEvent && item.decision !== 'Commented'
        && item.actor_id === event.user_id && item.decision === (event.to || event.kind)
        && item.previous_state === event.from && item.comments === summary)
        .sort((a, b) => Math.abs(portalDate(a.created_at).getTime() - portalDate(event.at).getTime()) - Math.abs(portalDate(b.created_at).getTime() - portalDate(event.at).getTime()))[0]
      if (match) match.workflowEvent = event
      else entries.push({ id: -(index + 1), entity_type: entityType, entity_id: entityId,
        actor_id: event.user_id, actor_name: event.user_name, decision: event.to || event.kind,
        created_at: event.at, previous_state: event.from, new_state: event.to, workflowEvent: event })
    }
    return entries
  }, [items, workflowHistory, entityType, entityId])
  const visible = useMemo(() => timeline.filter((item) => {
    const comment = item.decision === 'Commented'
    return filter === 'all' || (filter === 'comments' ? comment : !comment)
  }).sort((a, b) => portalDate(b.created_at).getTime() - portalDate(a.created_at).getTime()), [timeline, filter])

  const commentCount = items.filter((item) => item.decision === 'Commented').length

  function syncEditor() {
    setCharacterCount(editorContentToMarkdown(editorRef.current).length)
  }

  function runCommand(command: string, value?: string) {
    if (posting.current || isReadOnly) return
    editorRef.current?.focus()
    document.execCommand(command, false, value)
    syncEditor()
  }

  function insertTable() {
    if (posting.current || isReadOnly) return
    editorRef.current?.focus()
    document.execCommand('insertHTML', false,
      '<table><thead><tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr></thead>' +
      '<tbody><tr><td>Value</td><td>Value</td><td>Value</td></tr><tr><td>Value</td><td>Value</td><td>Value</td></tr></tbody></table><div><br></div>')
    syncEditor()
  }

  function clearComposer() {
    if (posting.current) return
    if (editorRef.current) editorRef.current.innerHTML = ''
    clearImages()
    inlineImagesRef.current = []
    attachmentsRef.current = []; setAttachments([]); setDragging(false)
    setCharacterCount(0); setExpanded(false); setError(''); cancelLink()
  }

  function onPaste(event: React.ClipboardEvent<HTMLDivElement>) {
    if (posting.current || isReadOnly) { event.preventDefault(); return }
    if (pasteStructuredRichText(event, editorRef.current)) { setExpanded(true); syncEditor(); return }
    const hasSpreadsheetData = /<table\b|urn:schemas-microsoft-com:office:excel|\bmso-/i.test(event.clipboardData.getData('text/html')) || /\t/.test(event.clipboardData.getData('text/plain'))
    const clipboardImages = hasSpreadsheetData ? [] : Array.from(event.clipboardData.items)
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile()).filter((file): file is File => file !== null)
    const unsupported = clipboardImages.find(file => !RICH_TEXT_IMAGE_TYPES.has(file.type.toLowerCase()))
    if (unsupported) {
      event.preventDefault(); setError(`“${unsupported.name || 'Pasted image'}” is not supported. Use PNG, JPEG, GIF, or WebP.`); return
    }
    const validationError = activityAttachmentError(clipboardImages.map(file => ({
      name: richTextImageFilename('pasted-image', file.name, file.type, 'clipboard'), size: file.size,
    })), inlineImagesRef.current.length + attachmentsRef.current.length)
    if (validationError) {
      event.preventDefault(); setError(validationError); return
    }
    const accepted = pasteImages(event)
    inlineImagesRef.current = [...inlineImagesRef.current, ...accepted]
    insertRichTextImages(editorRef.current, accepted)
    if (accepted.length) { setExpanded(true); syncEditor() }
  }

  function pickImages() {
    if (posting.current || isReadOnly) return
    const selection = window.getSelection()
    imageInsertRange.current = selection?.rangeCount && editorRef.current?.contains(selection.anchorNode)
      ? selection.getRangeAt(0).cloneRange() : null
    fileInputRef.current?.click()
  }

  function addInlineImages(files: File[]) {
    if (posting.current || isReadOnly) return
    const validationError = activityAttachmentError(files, inlineImagesRef.current.length + attachmentsRef.current.length)
    if (validationError) { setError(validationError); return }
    const accepted = addImages(files)
    inlineImagesRef.current = [...inlineImagesRef.current, ...accepted]
    insertRichTextImages(editorRef.current, accepted, imageInsertRange.current)
    imageInsertRange.current = null
    if (accepted.length) syncEditor()
  }

  function removeInlineImage(previewUrl: string) {
    if (posting.current || isReadOnly) return
    const image = inlineImagesRef.current.find((item) => item.previewUrl === previewUrl)
    if (image && editorRef.current) editorRef.current.querySelectorAll(`[data-rich-image-name="${CSS.escape(image.file.name)}"]`).forEach((node) => node.parentElement?.remove())
    inlineImagesRef.current = inlineImagesRef.current.filter(item => item.previewUrl !== previewUrl)
    removeImage(previewUrl); syncEditor()
  }

  function addAttachments(files: File[]) {
    if (posting.current || isReadOnly || !files.length) return
    const validationError = activityAttachmentError(files, inlineImagesRef.current.length + attachmentsRef.current.length)
    if (validationError) { setError(validationError); return }
    const next = [...attachmentsRef.current, ...files.map(file => ({ id: String(++attachmentSequence.current), file }))]
    attachmentsRef.current = next; setAttachments(next); setExpanded(true); setError('')
  }

  function removeAttachment(id: string) {
    if (posting.current || isReadOnly) return
    const next = attachmentsRef.current.filter(file => file.id !== id)
    attachmentsRef.current = next; setAttachments(next)
  }

  async function postComment() {
    if (posting.current || isReadOnly) return
    const body = editorContentToMarkdown(editorRef.current)
    const files = [...inlineImagesRef.current.map(image => image.file), ...attachmentsRef.current.map(attachment => attachment.file)]
    if (!body && files.length === 0) { setError('Enter a comment or attach a file before posting.'); return }
    if (body.length > 5000) { setError('Comment cannot exceed 5,000 characters.'); return }
    const validationError = activityAttachmentError(files)
    if (validationError) { setError(validationError); return }
    posting.current = true
    setBusy(true); setError('')
    try {
      const created = await api.uploadFormFiles<ApprovalActionOut>(
        `/api/approvals/${entityType}/${entityId}/rich-comments`,
        { body }, files, 'files', files.length ? 600_000 : undefined
      )
      if (!mounted.current) return
      onPosted(created)
      posting.current = false
      clearComposer(); setFilter('all')
    } catch (err: any) {
      if (!mounted.current) return
      const message = err?.message || ''
      if (message === 'Not Found') setError('The rich comments API is not available on the running backend. Restart or redeploy the backend service, then try again.')
      else if (message === 'Record not found') setError('This record no longer exists or the page is using a stale record ID. Close this detail view, refresh the list, and reopen it.')
      else setError(message || 'Could not post the comment.')
    } finally { posting.current = false; if (mounted.current) setBusy(false) }
  }

  return (
    <section className="jira-activity">
      <div className="jira-activity-head">
        <div><h3>Activity</h3><span>{timeline.length} event{timeline.length !== 1 ? 's' : ''}</span></div>
        <div className="jira-activity-filters">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'comments' ? 'active' : ''} onClick={() => setFilter('comments')}>Comments <span>{commentCount}</span></button>
          <button className={filter === 'history' ? 'active' : ''} onClick={() => setFilter('history')}>{workflowHistory ? 'Workflow history' : 'History'}</button>
        </div>
      </div>

      {isReadOnly && (
        <div className="jira-activity-read-only" role="note">
          Comments are read-only for the selected workspace or permission profile. Switch to the record's owning workspace with contributor access to add a comment.
        </div>
      )}

      {!isReadOnly && <div className={`jira-comment-composer ${expanded ? 'expanded' : ''} ${dragging ? 'is-dragging' : ''}`}
        onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); if (!posting.current) setDragging(true) } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={event => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); setDragging(false); addAttachments(Array.from(event.dataTransfer.files)) } }}>
        <div className="jira-avatar current">{initials(user?.full_name)}</div>
        <fieldset className="jira-composer-body" disabled={busy}>
          {expanded && (
            <>
              <RichTextToolbar
                ariaLabel="Comment formatting"
                onCommand={runCommand}
                onBeginLink={beginLink}
                onPickImage={pickImages}
                onInsertTable={insertTable}
              />
              <RichTextImageInput inputRef={fileInputRef} onFiles={addInlineImages} />
            </>
          )}
          {showLink && (
            <RichTextLinkEditor
              linkUrl={linkUrl}
              onChange={setLinkUrl}
              onApply={() => applyLink(runCommand)}
              onCancel={cancelLink}
              inputRef={linkInputRef}
            />
          )}
          <div
            ref={editorRef}
            className="jira-rich-editor"
            contentEditable={!busy}
            role="textbox"
            aria-multiline="true"
            data-placeholder="Add a comment…"
            onFocus={() => setExpanded(true)}
            onInput={syncEditor}
            onPaste={onPaste}
            onBlur={() => {
              if (!editorContentToMarkdown(editorRef.current) && editorRef.current) editorRef.current.innerHTML = ''
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                postComment()
              }
            }}
            suppressContentEditableWarning
          />
          <RichTextPastedImages images={images} onRemove={removeInlineImage} />
          <ActivityAttachmentPicker files={attachments} inlineImageCount={images.length} disabled={busy} onFiles={addAttachments} onRemove={removeAttachment} />
          {expanded && <div className="jira-composer-actions"><div><button className="btn btn-primary btn-sm" disabled={busy || characterCount > 5000 || (characterCount === 0 && images.length === 0 && attachments.length === 0)} onClick={postComment}>{busy ? 'Posting…' : 'Comment'}</button><button className="btn btn-sm" disabled={busy} onClick={clearComposer}>Cancel</button></div><span className={characterCount > 5000 ? 'over-limit' : ''}>{characterCount}/5000 · Rich text · Paste images with Ctrl/Cmd+V</span></div>}
          <ErrorText error={error} title="Comment could not be posted" guidance="Correct the issue described above, then post the comment again. Your draft, images and attached files remain available." />
        </fieldset>
      </div>}

      <div className="jira-activity-feed">
        {visible.map((item) => {
          const isComment = item.decision === 'Commented'
          const name = actorLabel(item)
          return (
            <article className={`jira-activity-item ${isComment ? 'comment' : 'history'}`} key={item.id}>
              <div className={`jira-avatar ${isComment ? '' : 'system'}`}>{isComment ? initials(name) : '↻'}</div>
              <div className="jira-activity-content">
                <div className="jira-activity-meta">
                  <strong>{name}</strong>
                  <span>{isComment ? 'added a comment' : `${item.decision || 'updated'} · ${item.step_name || 'Workflow'}`}</span>
                  {/* 2026-08 Test Approval Workflow refactor (APR-005) --
                      previous_state/new_state are only populated by the Test
                      Case approval workflow's own audit calls; every other
                      entity type's rows leave both null, so this stays
                      invisible everywhere else and simply falls back to the
                      decision/step text above. */}
                  {!isComment && item.previous_state && item.new_state && (
                    <span className="jira-activity-transition">{item.previous_state} → {item.new_state}</span>
                  )}
                  <time title={formatDateTimeIST(item.created_at)}>{relativeTime(item.created_at)}</time>
                </div>
                {item.workflowEvent && <WorkflowEventDetails event={item.workflowEvent} basePath={`/api/defects/${entityId}/attachments`} />}
                {!item.workflowEvent && item.comments && (isComment ? <CommentContent commentId={item.id} value={item.comments} /> : <div className="jira-activity-message">{item.comments}</div>)}
                {isComment && !item.comments && <CommentContent commentId={item.id} value="" />}
              </div>
            </article>
          )
        })}
        {visible.length === 0 && (
          <EmptyState
            compact
            title={filter === 'comments' ? 'No comments yet' : 'No activity recorded'}
            description={filter === 'comments'
              ? (isReadOnly ? 'No comments have been added to this record.' : 'Start the conversation using the comment box above.')
              : 'Workflow events will appear here as the request progresses.'}
          />
        )}
      </div>
    </section>
  )
}

function WorkflowEventDetails({ event, basePath }: { event: Record<string, any>; basePath: string }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function download(doc: { id: number; file_name: string }) {
    try {
      setError(null)
      const blob = await api.getBlob(`${basePath}/${doc.id}/download`, 600_000)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = doc.file_name
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) { setError(err) }
  }
  return <details className="workflow-activity-details" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>View decision details{[event.environment, event.build, event.result].filter(Boolean).length > 0 && ` · ${[event.environment, event.build, event.result].filter(Boolean).join(' · ')}`}</summary>
    {open && <div className="workflow-history-content">
      <AuthenticatedMarkdown value={[["Root cause", event.root_cause], ["Fix details", event.fix_details], ["Notes", event.remarks], ["Evidence / reference", event.reference]].filter(([, text]) => text).map(([label, text]) => `**${label}**\n\n${text}`).join('\n\n---\n\n')} basePath={basePath} />
      <div className="workflow-actions">{event.evidence_documents?.map((doc: { id: number; file_name: string }) => <button type="button" className="btn btn-sm" key={doc.id} onClick={() => void download(doc)}>Download {doc.file_name}</button>)}</div>
      <ErrorText error={error} />
    </div>}
  </details>
}
