import React, { useMemo, useRef, useState, useEffect } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { ROLE_LABELS } from '../constants'
import { ApprovalActionOut, RequestDocumentOut } from '../types'
import { ErrorText } from './Common'
import {
  RICH_TEXT_MAX_IMAGES,
  editorContentToMarkdown,
  safeRichTextLink,
  useRichTextImages,
  useRichTextLink,
  RichTextToolbar,
  RichTextImageInput,
  RichTextLinkEditor,
  RichTextPastedImages,
} from './RichTextEditor'

type ActivityFilter = 'all' | 'comments' | 'history'

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

// ---- Rendering a posted comment's stored markdown back to React (display
// only -- the inverse direction, markdown -> contentEditable HTML for
// editing, lives in RichTextEditor.tsx since JiraRichTextField needs it
// too; this markdown -> React-nodes direction is only ever needed here) ----

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
      const href = linkMatch ? safeRichTextLink(linkMatch[2]) : null
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
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const HeadingTag = `h${Math.min(6, heading[1].length)}` as keyof React.JSX.IntrinsicElements
      blocks.push(<HeadingTag key={`heading-${index}`}>{inlineMarkdown(heading[2], `heading-${index}`)}</HeadingTag>)
      index += 1
      continue
    }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1])) {
      const cells = (entry: string) => entry.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
      const header = cells(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]))
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
    while (index < lines.length && lines[index].trim() && !/^\s*(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s?)/.test(lines[index])) paragraph.push(lines[index++])
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
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [characterCount, setCharacterCount] = useState(0)

  const { images, addImages, removeImage, clearImages, pasteImages } = useRichTextImages({
    filenamePrefix: 'pasted-image',
    messages: {
      tooLarge: (name) => `“${name}” exceeds the 10 MB image limit.`,
      tooMany: () => `A comment can contain at most ${RICH_TEXT_MAX_IMAGES} images.`,
    },
    onError: setError,
  })
  const { showLink, linkUrl, setLinkUrl, linkInputRef, beginLink, applyLink, cancelLink } = useRichTextLink(editorRef, setError)

  const visible = useMemo(() => items.filter((item) => {
    const comment = item.decision === 'Commented'
    return filter === 'all' || (filter === 'comments' ? comment : !comment)
  }).slice().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()), [items, filter])

  const commentCount = items.filter((item) => item.decision === 'Commented').length

  function syncEditor() {
    setCharacterCount(editorContentToMarkdown(editorRef.current).length)
  }

  function runCommand(command: string, value?: string) {
    editorRef.current?.focus()
    document.execCommand(command, false, value)
    syncEditor()
  }

  function insertTable() {
    editorRef.current?.focus()
    document.execCommand('insertHTML', false,
      '<table><thead><tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr></thead>' +
      '<tbody><tr><td>Value</td><td>Value</td><td>Value</td></tr><tr><td>Value</td><td>Value</td><td>Value</td></tr></tbody></table><div><br></div>')
    syncEditor()
  }

  function clearComposer() {
    if (editorRef.current) editorRef.current.innerHTML = ''
    clearImages()
    setCharacterCount(0); setExpanded(false); setError(''); cancelLink()
  }

  function onPaste(event: React.ClipboardEvent<HTMLDivElement>) {
    if (pasteImages(event)) setExpanded(true)
  }

  async function postComment() {
    const body = editorContentToMarkdown(editorRef.current)
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
            <>
              <RichTextToolbar
                ariaLabel="Comment formatting"
                onCommand={runCommand}
                onBeginLink={beginLink}
                onPickImage={() => fileInputRef.current?.click()}
                onInsertTable={insertTable}
              />
              <RichTextImageInput inputRef={fileInputRef} onFiles={addImages} />
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
          <RichTextPastedImages images={images} onRemove={removeImage} />
          {expanded && <div className="jira-composer-actions"><div><button className="btn btn-primary btn-sm" disabled={busy || characterCount > 5000 || (characterCount === 0 && images.length === 0)} onClick={postComment}>{busy ? 'Posting…' : 'Comment'}</button><button className="btn btn-sm" onClick={clearComposer}>Cancel</button></div><span className={characterCount > 5000 ? 'over-limit' : ''}>{characterCount}/5000 · Rich text · Paste images with Ctrl/Cmd+V</span></div>}
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
                  <time title={new Date(item.created_at).toLocaleString()}>{relativeTime(item.created_at)}</time>
                </div>
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
