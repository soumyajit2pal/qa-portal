import React, { useEffect, useRef, useState } from 'react'

// Shared low-level mechanics behind every Jira-style rich text editor in
// this app: markdown <-> contentEditable-HTML conversion, the formatting
// toolbar, pasted/attached image handling, and the inline link editor.
//
// Used by JiraActivity.tsx (the comment/activity feed's composer, which
// posts to an activity feed and renders a history list) and
// JiraRichTextField.tsx (a plain controlled rich-text form input, used for
// Test Execution's "Actual Result" field) -- two genuinely different
// features that both need the exact same editing UX. This file is the one
// place that UX lives, instead of being copy-pasted between them (which is
// what used to happen -- see ORACLE_MIGRATION_2026-07.md for the section
// documenting this extraction).

export type PendingRichImage = { file: File; previewUrl: string }

export const RICH_TEXT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const RICH_TEXT_MAX_IMAGES = 8
export const RICH_TEXT_MAX_IMAGE_BYTES = 10 * 1024 * 1024

// ---- markdown <-> contentEditable HTML ----

function textOf(node: Node): string {
  return Array.from(node.childNodes).map(nodeToMarkdown).join('')
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

function tableToMarkdown(element: HTMLElement): string {
  const rows = Array.from(element.querySelectorAll('tr')).map((row) =>
    Array.from(row.querySelectorAll('th,td')).map((cell) =>
      textOf(cell).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
    )
  ).filter((row) => row.length > 0)
  if (!rows.length) return ''
  const width = Math.max(...rows.map((row) => row.length))
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')])
  const line = (row: string[]) => `| ${row.join(' | ')} |`
  return `${line(normalized[0])}\n${line(Array(width).fill('---'))}\n${normalized.slice(1).map(line).join('\n')}\n`
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

// Reported directly: JiraActivity's copy of this handled H1-H6 (bolding the
// heading text); JiraRichTextField's copy didn't -- neither toolbar has a
// heading button so it's an edge case (only reachable by pasting external
// HTML that contains headings), but there's no reason the two editors
// should behave differently for the same pasted content. Using the more
// complete version here as the single shared implementation.
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
    case 'H6': return content ? `${'#'.repeat(Number(node.tagName.slice(1)))} ${content.trim()}\n` : ''
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
    case 'TABLE': return tableToMarkdown(node)
    case 'A': {
      const href = node.getAttribute('href') || ''
      return href ? `[${content || href}](${href})` : content
    }
    default: return styledMarkdown(node, content)
  }
}

export function editorContentToMarkdown(editor: HTMLDivElement | null): string {
  return editor ? textOf(editor).replace(/\n{3,}/g, '\n\n').trim() : ''
}

export function safeRichTextLink(value: string): string | null {
  const link = value.trim()
  return /^(https?:\/\/|mailto:)/i.test(link) ? link : null
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inlineHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\[u\]([\s\S]+?)\[\/u\]/g, '<u>$1</u>')
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+|mailto:[^)]+)\)/gi, '<a href="$2">$1</a>')
}

// Inverse of editorContentToMarkdown -- seeds a contentEditable's initial
// HTML from a stored markdown value. Only JiraRichTextField currently needs
// this direction (JiraActivity's composer always starts empty), but it
// belongs in the same codec as the rest of this file rather than living
// off on its own.
export function markdownToEditorHtml(value: string): string {
  const lines = value.replace(/\r/g, '').split('\n')
  const blocks: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { blocks.push('<div><br></div>'); index += 1; continue }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) { const level = heading[1].length; blocks.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`); index += 1; continue }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1])) {
      const cells = (entry: string) => entry.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => inlineHtml(cell.trim().replace(/\\\|/g, '|')))
      const header = cells(line)
      index += 2
      const body: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) body.push(cells(lines[index++]))
      blocks.push(`<table><thead><tr>${header.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) items.push(`<li>${inlineHtml(lines[index++].replace(/^\s*[-*]\s+/, ''))}</li>`)
      blocks.push(`<ul>${items.join('')}</ul>`); continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) items.push(`<li>${inlineHtml(lines[index++].replace(/^\s*\d+\.\s+/, ''))}</li>`)
      blocks.push(`<ol>${items.join('')}</ol>`); continue
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(inlineHtml(lines[index++].replace(/^>\s?/, '')))
      blocks.push(`<blockquote>${quote.join('<br>')}</blockquote>`); continue
    }
    blocks.push(`<div>${inlineHtml(line)}</div>`)
    index += 1
  }
  return blocks.join('')
}

// ---- Pending image attachments (validate, preview, paste, cleanup) ----

export interface RichTextImageMessages {
  // "Unsupported file type" wording is identical everywhere this is used
  // so it isn't parameterized -- only the two messages that actually
  // differ in wording between callers need to be supplied.
  tooLarge: (fileName: string) => string
  tooMany: () => string
}

export function useRichTextImages(opts: {
  maxImages?: number
  maxBytes?: number
  // Prefix for auto-generated filenames when an image is pasted rather
  // than picked from disk (e.g. "pasted-image-<ts>-1.png").
  filenamePrefix: string
  messages: RichTextImageMessages
  onError: (message: string) => void
}) {
  const { maxImages = RICH_TEXT_MAX_IMAGES, maxBytes = RICH_TEXT_MAX_IMAGE_BYTES, filenamePrefix, messages, onError } = opts
  const [images, setImages] = useState<PendingRichImage[]>([])
  const imagesRef = useRef<PendingRichImage[]>([])
  useEffect(() => { imagesRef.current = images }, [images])
  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl)), [])

  function addImages(files: File[]): boolean {
    const accepted: PendingRichImage[] = []
    for (const file of files) {
      const name = file.name || 'Pasted image'
      if (!RICH_TEXT_IMAGE_TYPES.has(file.type)) {
        onError(`“${name}” is not supported. Use PNG, JPEG, GIF, or WebP.`)
        continue
      }
      if (file.size > maxBytes) { onError(messages.tooLarge(name)); continue }
      if (images.length + accepted.length >= maxImages) { onError(messages.tooMany()); break }
      accepted.push({ file, previewUrl: URL.createObjectURL(file) })
    }
    if (accepted.length) {
      setImages((current) => [...current, ...accepted])
      onError('')
    }
    return accepted.length > 0
  }

  function removeImage(previewUrl: string) {
    URL.revokeObjectURL(previewUrl)
    setImages((current) => current.filter((image) => image.previewUrl !== previewUrl))
  }

  function clearImages() {
    images.forEach((image) => URL.revokeObjectURL(image.previewUrl))
    setImages([])
  }

  // Returns true (and calls event.preventDefault()) only if the clipboard
  // actually contained image file(s) -- lets the caller decide what else
  // should happen on a successful image paste (e.g. JiraActivity expanding
  // its composer).
  function pasteImages(event: React.ClipboardEvent<HTMLDivElement>): boolean {
    // Excel (and some other spreadsheet applications) place several
    // representations of the same copied cells on the clipboard: HTML/table
    // markup, tab-separated plain text, and an image preview. Previously the
    // image item won, preventDefault() discarded the real cells, and the
    // spreadsheet data was saved as a screenshot attachment. Prefer the
    // structured representation whenever it is present; the browser will
    // paste the table into contentEditable and the shared Markdown codec will
    // persist it as an editable Markdown table.
    const clipboardHtml = event.clipboardData.getData('text/html')
    const clipboardText = event.clipboardData.getData('text/plain')
    const hasSpreadsheetData = /<table\b|urn:schemas-microsoft-com:office:excel|\bmso-/i.test(clipboardHtml)
      || /\t/.test(clipboardText)
    if (hasSpreadsheetData) return false

    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item, index) => {
        const blob = item.getAsFile()
        if (!blob) return null
        const extension = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
        return new File([blob], `${filenamePrefix}-${Date.now()}-${index + 1}.${extension}`, { type: blob.type })
      }).filter((file): file is File => !!file)
    if (!files.length) return false
    event.preventDefault()
    return addImages(files)
  }

  return { images, addImages, removeImage, clearImages, pasteImages }
}

// ---- Inline link editor (Add link toolbar button + URL input row) ----

export function useRichTextLink(editorRef: React.RefObject<HTMLDivElement>, onError: (message: string) => void) {
  const linkInputRef = useRef<HTMLInputElement>(null)
  const savedRange = useRef<Range | null>(null)
  const [showLink, setShowLink] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')

  useEffect(() => { if (showLink) linkInputRef.current?.focus() }, [showLink])

  function beginLink() {
    const selection = window.getSelection()
    if (selection?.rangeCount && editorRef.current?.contains(selection.anchorNode)) {
      savedRange.current = selection.getRangeAt(0).cloneRange()
    } else {
      savedRange.current = null
    }
    setShowLink((current) => !current)
  }

  function applyLink(runCommand: (name: string, value?: string) => void): boolean {
    const href = safeRichTextLink(linkUrl)
    if (!href) { onError('Enter a complete http://, https://, or mailto: link.'); return false }
    editorRef.current?.focus()
    const selection = window.getSelection()
    if (selection && savedRange.current) {
      selection.removeAllRanges()
      selection.addRange(savedRange.current)
    }
    runCommand('createLink', href)
    setShowLink(false); setLinkUrl('')
    onError('')
    return true
  }

  function cancelLink() {
    setShowLink(false); setLinkUrl('')
  }

  return { showLink, linkUrl, setLinkUrl, linkInputRef, beginLink, applyLink, cancelLink }
}

// ---- Presentational pieces shared by both editors ----

export function RichTextToolbar({
  ariaLabel,
  imageButtonTitle = 'Add image',
  codeButtonTitle = 'Inline code',
  onCommand,
  onBeginLink,
  onPickImage,
  onInsertTable,
}: {
  ariaLabel: string
  imageButtonTitle?: string
  codeButtonTitle?: string
  onCommand: (name: string, value?: string) => void
  onBeginLink: () => void
  onPickImage?: () => void
  onInsertTable?: () => void
}) {
  const [menu, setMenu] = useState<'style' | 'list' | 'emoji' | 'insert' | null>(null)
  const run = (name: string, value?: string) => { onCommand(name, value); setMenu(null) }
  const toggle = (name: typeof menu) => setMenu((current) => current === name ? null : name)
  return (
    <div className="jira-editor-toolbar" role="toolbar" aria-label={ariaLabel}>
      <div className="jira-toolbar-menu-wrap">
        <button type="button" className={menu === 'style' ? 'active' : ''} title="Text style" aria-label="Text style" aria-expanded={menu === 'style'} onMouseDown={(event) => event.preventDefault()} onClick={() => toggle('style')}><b className="jira-toolbar-glyph">T</b><small>⌄</small></button>
        {menu === 'style' && <div className="jira-toolbar-menu style-menu"><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => run('formatBlock', 'div')}>Normal text</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => run('formatBlock', 'h2')}><strong>Heading</strong></button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => run('formatBlock', 'h3')}><strong>Subheading</strong></button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => run('formatBlock', 'blockquote')}>Quote</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => run('formatBlock', 'pre')}>Code block</button></div>}
      </div>
      <button type="button" title="Bold" aria-label="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => run('bold')}><strong className="jira-toolbar-glyph">B</strong></button>
      <button type="button" title="Italic" aria-label="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => run('italic')}><em className="jira-toolbar-glyph">I</em></button>
      <button type="button" title="Underline" aria-label="Underline" onMouseDown={(event) => event.preventDefault()} onClick={() => run('underline')}><u className="jira-toolbar-glyph">U</u></button>
      <button type="button" title="Strikethrough" aria-label="Strikethrough" onMouseDown={(event) => event.preventDefault()} onClick={() => run('strikeThrough')}><s className="jira-toolbar-glyph">S</s></button>
      <i />
      <div className="jira-toolbar-menu-wrap">
        <button type="button" className={menu === 'list' ? 'active' : ''} title="Lists" aria-label="Lists" aria-expanded={menu === 'list'} onMouseDown={(event) => event.preventDefault()} onClick={() => toggle('list')}><span className="jira-toolbar-icon">☷</span><small>⌄</small></button>
        {menu === 'list' && <div className="jira-toolbar-menu"><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => run('insertUnorderedList')}>• Bulleted list</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => run('insertOrderedList')}>1. Numbered list</button></div>}
      </div>
      <button type="button" title="Clear formatting" aria-label="Clear formatting" onMouseDown={(event) => event.preventDefault()} onClick={() => run('removeFormat')}><span className="jira-toolbar-clear">A</span></button>
      {onPickImage && <button type="button" className="jira-toolbar-emphasis" title={imageButtonTitle} aria-label={imageButtonTitle} onMouseDown={(event) => event.preventDefault()} onClick={onPickImage}><span className="jira-toolbar-icon">▧</span></button>}
      <button type="button" title={codeButtonTitle} aria-label={codeButtonTitle} onMouseDown={(event) => event.preventDefault()} onClick={() => run('formatBlock', 'pre')}><span className="jira-toolbar-code">{'</>'}</span></button>
      <div className="jira-toolbar-menu-wrap">
        <button type="button" className={menu === 'emoji' ? 'active' : ''} title="Insert emoji" aria-label="Insert emoji" aria-expanded={menu === 'emoji'} onMouseDown={(event) => event.preventDefault()} onClick={() => toggle('emoji')}><span className="jira-toolbar-icon">☺</span></button>
        {menu === 'emoji' && <div className="jira-toolbar-menu emoji-menu">{['🙂', '👍', '✅', '⚠️', '❌', '🎯', '🐞', '🚀'].map((emoji) => <button type="button" key={emoji} onMouseDown={(event) => event.preventDefault()} onClick={() => run('insertText', emoji)}>{emoji}</button>)}</div>}
      </div>
      {onInsertTable && <div className="jira-toolbar-menu-wrap"><button type="button" className={menu === 'insert' ? 'active' : ''} title="Insert more" aria-label="Insert more" aria-expanded={menu === 'insert'} onMouseDown={(event) => event.preventDefault()} onClick={() => toggle('insert')}><span className="jira-toolbar-icon">＋</span></button>{menu === 'insert' && <div className="jira-toolbar-menu"><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { onInsertTable(); setMenu(null) }}>▦ Insert table</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => run('formatBlock', 'blockquote')}>❝ Insert quote</button></div>}</div>}
      <button type="button" title="Add link" aria-label="Add link" onMouseDown={(event) => event.preventDefault()} onClick={() => { setMenu(null); onBeginLink() }}><span className="jira-toolbar-icon">⌁</span></button>
      <i />
      <button type="button" title="Undo" aria-label="Undo" onMouseDown={(event) => event.preventDefault()} onClick={() => run('undo')}><span className="jira-toolbar-icon">↶</span></button>
      <button type="button" title="Redo" aria-label="Redo" onMouseDown={(event) => event.preventDefault()} onClick={() => run('redo')}><span className="jira-toolbar-icon">↷</span></button>
    </div>
  )
}

export function RichTextImageInput({
  inputRef, onFiles,
}: {
  inputRef: React.RefObject<HTMLInputElement>
  onFiles: (files: File[]) => void
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp"
      multiple
      hidden
      onChange={(event) => { onFiles(Array.from(event.target.files || [])); event.target.value = '' }}
    />
  )
}

export function RichTextLinkEditor({
  linkUrl, onChange, onApply, onCancel, inputRef,
}: {
  linkUrl: string
  onChange: (value: string) => void
  onApply: () => void
  onCancel: () => void
  inputRef: React.RefObject<HTMLInputElement>
}) {
  return (
    <div className="jira-link-editor">
      <input
        ref={inputRef}
        value={linkUrl}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onApply() } }}
        placeholder="https://example.com"
      />
      <button type="button" className="btn btn-primary btn-sm" onClick={onApply}>Apply link</button>
      <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
    </div>
  )
}

export function RichTextPastedImages({ images, onRemove }: { images: PendingRichImage[]; onRemove: (previewUrl: string) => void }) {
  if (images.length === 0) return null
  return (
    <div className="jira-pasted-images">
      {images.map((image) => (
        <div key={image.previewUrl} className="jira-pasted-image">
          <img src={image.previewUrl} alt={image.file.name} />
          <span>{image.file.name}</span>
          <button type="button" title="Remove image" onClick={() => onRemove(image.previewUrl)}>×</button>
        </div>
      ))}
    </div>
  )
}
