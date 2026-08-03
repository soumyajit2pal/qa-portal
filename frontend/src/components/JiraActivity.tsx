import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { ROLE_LABELS } from '../constants'
import { ApprovalActionOut, RequestDocumentOut } from '../types'
import { ErrorText } from './Common'

type ActivityFilter = 'all' | 'comments' | 'history'
type PendingImage = { file: File; previewUrl: string }

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

function initials(name?: string | null): string {
  const parts = (name || '?').trim().split(/\s+/)
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase()
}

function actorLabel(item: ApprovalActionOut): string {
  return item.actor_name || (item.actor_role || 'System').split(',').map((role) => ROLE_LABELS[role.trim()] || role.trim()).join(' · ')
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(value).toLocaleDateString()
}

function textOf(node: Node): string {
  return Array.from(node.childNodes).map((child) => nodeToMarkdown(child)).join('')
}

function listToMarkdown(element: HTMLElement, ordered: boolean): string {
  return Array.from(element.children).map((child, index) => {
    const nestedLists = Array.from(child.children).filter((entry) => ['UL', 'OL'].includes(entry.tagName))
    const clone = child.cloneNode(true) as HTMLElement
    Array.from(clone.children).filter((entry) => ['UL', 'OL'].includes(entry.tagName)).forEach((entry) => entry.remove())
    const line = textOf(clone).trim()
    const nested = nestedLists.map((entry) => listToMarkdown(entry as HTMLElement, entry.tagName === 'OL')
      .split('\n').filter(Boolean).map((nestedLine) => `  ${nestedLine}`).join('\n')).join('\n')
    return `${ordered ? `${index + 1}.` : '-'} ${line}${nested ? `\n${nested}` : ''}`
  }).join('\n') + '\n'
}

function styledMarkdown(element: HTMLElement, value: string): string {
  let result = value
  const weight = element.style.fontWeight
  if (weight === 'bold' || Number.parseInt(weight || '0', 10) >= 600) result = `**${result}**`
  if (element.style.fontStyle === 'italic') result = `*${result}*`
  const decoration = element.style.textDecoration || element.style.textDecorationLine
  if (decoration.includes('underline')) result = `[u]${result}[/u]`
  if (decoration.includes('line-through')) result = `~~${result}~~`
  return result
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
  if (!(node instanceof HTMLElement)) return ''
  const content = textOf(node)
  switch (node.tagName) {
    case 'BR': return '\n'
    case 'DIV':
    case 'P': return `${styledMarkdown(node, content.trimEnd())}\n`
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': return content ? `**${content.trim()}**\n` : ''
    case 'B':
    case 'STRONG': return content ? `**${content}**` : ''
    case 'I':
    case 'EM': return content ? `*${content}*` : ''
    case 'U': return content ? `[u]${content}[/u]` : ''
    case 'S':
    case 'STRIKE': return content ? `~~${content}~~` : ''
    case 'CODE': return content ? `\`${content.replace(/`/g, '\\`')}\`` : ''
    case 'PRE': return content ? `\`${content.trim().replace(/`/g, '\\`')}\`\n` : ''
    case 'BLOCKQUOTE': return content.split('\n').filter(Boolean).map((line) => `> ${line}`).join('\n') + '\n'
    case 'UL': return listToMarkdown(node, false)
    case 'OL': return listToMarkdown(node, true)
    case 'A': {
      const href = node.getAttribute('href') || ''
      return href ? `[${content || href}](${href})` : content
    }
    default: return styledMarkdown(node, content)
  }
}

function editorMarkdown(editor: HTMLDivElement | null): string {
  return editor ? textOf(editor).replace(/\n{3,}/g, '\n\n').trim() : ''
}

function safeLink(value: string): string | null {
  const link = value.trim()
  return /^(https?:\/\/|mailto:)/i.test(link) ? link : null
}

function inlineMarkdown(value: string, keyPrefix: string): React.ReactNode[] {
  const pattern = /(\[u\][\s\S]+?\[\/u\]|\*\*[\s\S]+?\*\*|~~[\s\S]+?~~|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*)/g
  const nodes: React.ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  let index = 0
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${index++}`
    if (token.startsWith('[u]')) nodes.push(<u key={key}>{inlineMarkdown(token.slice(3, -4), key)}</u>)
    else if (token.startsWith('**')) nodes.push(<strong key={key}>{inlineMarkdown(token.slice(2, -2), key)}</strong>)
    else if (token.startsWith('~~')) nodes.push(<s key={key}>{inlineMarkdown(token.slice(2, -2), key)}</s>)
    else if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      const href = linkMatch ? safeLink(linkMatch[2]) : null
      nodes.push(href
        ? <a key={key} href={href} target="_blank" rel="noreferrer">{linkMatch![1]}</a>
        : token)
    } else nodes.push(<em key={key}>{inlineMarkdown(token.slice(1, -1), key)}</em>)
    cursor = match.index + token.length
  }
  if (cursor < value.length) nodes.push(value.slice(cursor))
  return nodes
}

export function MarkdownComment({ value }: { value: string }) {
  const lines = value.replace(/\r/g, '').split('\n')
  const blocks: React.ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { index += 1; continue }
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
    while (index < lines.length && lines[index].trim() && !/^\s*(?:[-*]\s+|\d+\.\s+|>\s?)/.test(lines[index])) paragraph.push(lines[index++])
    blocks.push(<p key={`p-${index}`}>{paragraph.map((entry, paragraphIndex) => <React.Fragment key={paragraphIndex}>{inlineMarkdown(entry, `p-${index}-${paragraphIndex}`)}{paragraphIndex < paragraph.length - 1 && <br />}</React.Fragment>)}</p>)
  }
  return <div className="jira-markdown">{blocks}</div>
}

function CommentAttachments({ commentId }: { commentId: number }) {
  const [documents, setDocuments] = useState<RequestDocumentOut[]>([])
  const [urls, setUrls] = useState<Record<number, string>>({})

  useEffect(() => {
    let active = true
    const createdUrls: string[] = []
    async function load() {
      try {
        const docs = await api.get<RequestDocumentOut[]>(`/api/approvals/comments/${commentId}/attachments`)
        if (!active) return
        setDocuments(docs)
        const loaded = await Promise.all(docs.map(async (document) => {
          const blob = await api.getBlob(`/api/approvals/comments/${commentId}/attachments/${document.id}/download`)
          const url = URL.createObjectURL(blob)
          createdUrls.push(url)
          return [document.id, url] as const
        }))
        if (active) setUrls(Object.fromEntries(loaded))
        else loaded.forEach(([, url]) => URL.revokeObjectURL(url))
      } catch {
        // A missing legacy attachment endpoint should not hide the comment.
      }
    }
    load()
    return () => { active = false; createdUrls.forEach((url) => URL.revokeObjectURL(url)) }
  }, [commentId])

  if (documents.length === 0) return null
  return (
    <div className="jira-comment-attachments">
      {documents.map((document) => urls[document.id] && (
        <button key={document.id} type="button" className="jira-comment-image" title={`Open ${document.file_name}`} onClick={() => window.open(urls[document.id], '_blank', 'noopener,noreferrer')}>
          <img src={urls[document.id]} alt={document.file_name} />
          <span>{document.file_name}</span>
        </button>
      ))}
    </div>
  )
}

export default function JiraActivity({ entityType, entityId, items, onPosted }: {
  entityType: string
  entityId: number
  items: ApprovalActionOut[]
  onPosted: (item: ApprovalActionOut) => void
}) {
  const { user } = useAuth()
  const editorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const linkInputRef = useRef<HTMLInputElement>(null)
  const savedLinkRange = useRef<Range | null>(null)
  const imagesRef = useRef<PendingImage[]>([])
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [characterCount, setCharacterCount] = useState(0)
  const [images, setImages] = useState<PendingImage[]>([])
  const [showLink, setShowLink] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')

  useEffect(() => { imagesRef.current = images }, [images])
  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl)), [])
  useEffect(() => { if (showLink) linkInputRef.current?.focus() }, [showLink])

  const visible = useMemo(() => items.filter((item) => {
    const comment = item.decision === 'Commented'
    return filter === 'all' || (filter === 'comments' ? comment : !comment)
  }).slice().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()), [items, filter])

  const commentCount = items.filter((item) => item.decision === 'Commented').length

  function syncEditor() {
    setCharacterCount(editorMarkdown(editorRef.current).length)
  }

  function runCommand(command: string, value?: string) {
    editorRef.current?.focus()
    document.execCommand(command, false, value)
    syncEditor()
  }

  function clearComposer() {
    if (editorRef.current) editorRef.current.innerHTML = ''
    images.forEach((image) => URL.revokeObjectURL(image.previewUrl))
    setImages([]); setCharacterCount(0); setExpanded(false); setError(''); setShowLink(false); setLinkUrl('')
  }

  function addImages(files: File[]) {
    const accepted: PendingImage[] = []
    for (const file of files) {
      if (!IMAGE_TYPES.has(file.type)) { setError(`“${file.name || 'Pasted image'}” is not supported. Use PNG, JPEG, GIF, or WebP.`); continue }
      if (file.size > MAX_IMAGE_BYTES) { setError(`“${file.name || 'Pasted image'}” exceeds the 10 MB image limit.`); continue }
      if (images.length + accepted.length >= MAX_IMAGES) { setError(`A comment can contain at most ${MAX_IMAGES} images.`); break }
      accepted.push({ file, previewUrl: URL.createObjectURL(file) })
    }
    if (accepted.length) { setImages((current) => [...current, ...accepted]); setExpanded(true); setError('') }
  }

  function onPaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const pasted = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item, index) => {
        const blob = item.getAsFile()
        if (!blob) return null
        const extension = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
        return new File([blob], `pasted-image-${Date.now()}-${index + 1}.${extension}`, { type: blob.type })
      }).filter((file): file is File => !!file)
    if (pasted.length) {
      event.preventDefault()
      addImages(pasted)
    }
  }

  function applyLink() {
    const href = safeLink(linkUrl)
    if (!href) { setError('Enter a complete http://, https://, or mailto: link.'); return }
    editorRef.current?.focus()
    const selection = window.getSelection()
    if (selection && savedLinkRange.current) {
      selection.removeAllRanges()
      selection.addRange(savedLinkRange.current)
    }
    runCommand('createLink', href)
    setShowLink(false); setLinkUrl(''); setError('')
  }

  function beginLink() {
    const selection = window.getSelection()
    if (selection?.rangeCount && editorRef.current?.contains(selection.anchorNode)) {
      savedLinkRange.current = selection.getRangeAt(0).cloneRange()
    } else {
      savedLinkRange.current = null
    }
    setShowLink((current) => !current)
  }

  async function postComment() {
    const body = editorMarkdown(editorRef.current)
    if (!body && images.length === 0) { setError('Enter a comment or paste an image before posting.'); return }
    if (body.length > 5000) { setError('Comment cannot exceed 5,000 characters.'); return }
    setBusy(true); setError('')
    try {
      const created = await api.uploadFormFiles<ApprovalActionOut>(
        `/api/approvals/${entityType}/${entityId}/rich-comments`,
        { body }, images.map((image) => image.file), 'files'
      )
      onPosted(created)
      clearComposer(); setFilter('all')
    } catch (err: any) {
      const message = err?.message || ''
      if (message === 'Not Found') setError('The rich comments API is not available on the running backend. Restart or redeploy the backend service, then try again.')
      else if (message === 'Record not found') setError('This record no longer exists or the page is using a stale record ID. Close this detail view, refresh the list, and reopen it.')
      else setError(message || 'Could not post the comment.')
    } finally { setBusy(false) }
  }

  return (
    <section className="jira-activity">
      <div className="jira-activity-head">
        <div><h3>Activity</h3><span>{items.length} event{items.length !== 1 ? 's' : ''}</span></div>
        <div className="jira-activity-filters">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'comments' ? 'active' : ''} onClick={() => setFilter('comments')}>Comments <span>{commentCount}</span></button>
          <button className={filter === 'history' ? 'active' : ''} onClick={() => setFilter('history')}>History</button>
        </div>
      </div>

      <div className={`jira-comment-composer ${expanded ? 'expanded' : ''}`}>
        <div className="jira-avatar current">{initials(user?.full_name)}</div>
        <div className="jira-composer-body">
          {expanded && (
            <div className="jira-editor-toolbar" role="toolbar" aria-label="Comment formatting">
              <button type="button" title="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand('bold')}><strong>B</strong></button>
              <button type="button" title="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand('italic')}><em>I</em></button>
              <button type="button" title="Underline" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand('underline')}><u>U</u></button>
              <button type="button" title="Strikethrough" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand('strikeThrough')}><s>S</s></button>
              <span />
              <button type="button" title="Bulleted list" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand('insertUnorderedList')}>• List</button>
              <button type="button" title="Numbered list" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand('insertOrderedList')}>1. List</button>
              <button type="button" title="Quote" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand('formatBlock', 'blockquote')}>❝</button>
              <button type="button" title="Inline code" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand('formatBlock', 'pre')}>{'</>'}</button>
              <span />
              <button type="button" title="Add link" onMouseDown={(event) => event.preventDefault()} onClick={beginLink}>Link</button>
              <button type="button" title="Attach images" onMouseDown={(event) => event.preventDefault()} onClick={() => fileInputRef.current?.click()}>Image</button>
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => { addImages(Array.from(event.target.files || [])); event.target.value = '' }} />
            </div>
          )}
          {showLink && (
            <div className="jira-link-editor">
              <input ref={linkInputRef} value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyLink() } }} placeholder="https://example.com" />
              <button type="button" className="btn btn-primary btn-sm" onClick={applyLink}>Apply link</button>
              <button type="button" className="btn btn-sm" onClick={() => { setShowLink(false); setLinkUrl('') }}>Cancel</button>
            </div>
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
              if (!editorMarkdown(editorRef.current) && editorRef.current) editorRef.current.innerHTML = ''
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                postComment()
              }
            }}
            suppressContentEditableWarning
          />
          {images.length > 0 && (
            <div className="jira-pasted-images">
              {images.map((image, index) => (
                <div key={image.previewUrl} className="jira-pasted-image">
                  <img src={image.previewUrl} alt={image.file.name} />
                  <span>{image.file.name}</span>
                  <button type="button" title="Remove image" onClick={() => {
                    URL.revokeObjectURL(image.previewUrl)
                    setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }}>×</button>
                </div>
              ))}
            </div>
          )}
          {expanded && <div className="jira-composer-actions"><span className={characterCount > 5000 ? 'over-limit' : ''}>{characterCount}/5000 · Rich text · Paste images with Ctrl/Cmd+V</span><div><button className="btn btn-sm" onClick={clearComposer}>Cancel</button><button className="btn btn-primary btn-sm" disabled={busy || characterCount > 5000 || (characterCount === 0 && images.length === 0)} onClick={postComment}>{busy ? 'Posting…' : 'Comment'}</button></div></div>}
          <ErrorText error={error} title="Comment could not be posted" guidance="Correct the issue described above, then post the comment again. Your draft and pasted images remain available." />
        </div>
      </div>

      <div className="jira-activity-feed">
        {visible.map((item) => {
          const isComment = item.decision === 'Commented'
          const name = actorLabel(item)
          return (
            <article className={`jira-activity-item ${isComment ? 'comment' : 'history'}`} key={item.id}>
              <div className={`jira-avatar ${isComment ? '' : 'system'}`}>{isComment ? initials(name) : '↻'}</div>
              <div className="jira-activity-content">
                <div className="jira-activity-meta"><strong>{name}</strong><span>{isComment ? 'added a comment' : `${item.decision || 'updated'} · ${item.step_name || 'Workflow'}`}</span><time title={new Date(item.created_at).toLocaleString()}>{relativeTime(item.created_at)}</time></div>
                {item.comments && <div className={`jira-activity-message ${isComment ? 'comment-box' : ''}`}>{isComment ? <MarkdownComment value={item.comments} /> : item.comments}</div>}
                {isComment && <CommentAttachments commentId={item.id} />}
              </div>
            </article>
          )
        })}
        {visible.length === 0 && <div className="jira-activity-empty">{filter === 'comments' ? 'No comments yet. Start the conversation above.' : 'No activity recorded yet.'}</div>}
      </div>
    </section>
  )
}
