import React, { useEffect, useRef, useState } from 'react'
import { ErrorText } from './Common'

export type PendingRichImage = { file: File; previewUrl: string }

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

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

function markdownToEditorHtml(value: string): string {
  const lines = value.replace(/\r/g, '').split('\n')
  const blocks: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { blocks.push('<div><br></div>'); index += 1; continue }
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

export default function JiraRichTextField({ value, disabled, onChange, onImagesChange, maxLength = 10000 }: {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  onImagesChange: (files: File[]) => void
  maxLength?: number
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const linkInputRef = useRef<HTMLInputElement>(null)
  const savedLinkRange = useRef<Range | null>(null)
  const initialized = useRef(false)
  const imagesRef = useRef<PendingRichImage[]>([])
  const onImagesChangeRef = useRef(onImagesChange)
  const [images, setImages] = useState<PendingRichImage[]>([])
  const [error, setError] = useState('')
  const [count, setCount] = useState(value.length)
  const [showLink, setShowLink] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')

  useEffect(() => {
    if (!initialized.current && editorRef.current) {
      editorRef.current.innerHTML = markdownToEditorHtml(value)
      initialized.current = true
    }
  }, [value])
  useEffect(() => { onImagesChangeRef.current = onImagesChange }, [onImagesChange])
  useEffect(() => { imagesRef.current = images; onImagesChangeRef.current(images.map((image) => image.file)) }, [images])
  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl)), [])

  function sync() {
    const markdown = editorMarkdown(editorRef.current)
    setCount(markdown.length)
    onChange(markdown)
  }

  function command(name: string, commandValue?: string) {
    editorRef.current?.focus()
    document.execCommand(name, false, commandValue)
    sync()
  }

  function beginLink() {
    const selection = window.getSelection()
    if (selection?.rangeCount && editorRef.current?.contains(selection.anchorNode)) savedLinkRange.current = selection.getRangeAt(0).cloneRange()
    else savedLinkRange.current = null
    setShowLink((current) => !current)
    setTimeout(() => linkInputRef.current?.focus(), 0)
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
    command('createLink', href)
    setShowLink(false); setLinkUrl(''); setError('')
  }

  function addImages(files: File[]) {
    const accepted: PendingRichImage[] = []
    for (const file of files) {
      if (!IMAGE_TYPES.has(file.type)) { setError(`“${file.name || 'Pasted image'}” is not supported. Use PNG, JPEG, GIF, or WebP.`); continue }
      if (file.size > MAX_IMAGE_BYTES) { setError(`“${file.name || 'Pasted image'}” exceeds the 10 MB limit.`); continue }
      if (images.length + accepted.length >= MAX_IMAGES) { setError(`Actual Result can contain at most ${MAX_IMAGES} images per save.`); break }
      accepted.push({ file, previewUrl: URL.createObjectURL(file) })
    }
    if (accepted.length) { setImages((current) => [...current, ...accepted]); setError('') }
  }

  function paste(event: React.ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.items).filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item, index) => {
      const blob = item.getAsFile()
      if (!blob) return null
      const extension = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
      return new File([blob], `actual-result-${Date.now()}-${index + 1}.${extension}`, { type: blob.type })
    }).filter((file): file is File => !!file)
    if (files.length) { event.preventDefault(); addImages(files) }
  }

  return (
    <div className="jira-result-editor">
      {!disabled && <div className="jira-editor-toolbar" role="toolbar" aria-label="Actual Result formatting">
        <button type="button" title="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => command('bold')}><strong>B</strong></button>
        <button type="button" title="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => command('italic')}><em>I</em></button>
        <button type="button" title="Underline" onMouseDown={(e) => e.preventDefault()} onClick={() => command('underline')}><u>U</u></button>
        <button type="button" title="Strikethrough" onMouseDown={(e) => e.preventDefault()} onClick={() => command('strikeThrough')}><s>S</s></button><span />
        <button type="button" title="Bulleted list" onMouseDown={(e) => e.preventDefault()} onClick={() => command('insertUnorderedList')}>• List</button>
        <button type="button" title="Numbered list" onMouseDown={(e) => e.preventDefault()} onClick={() => command('insertOrderedList')}>1. List</button>
        <button type="button" title="Quote" onMouseDown={(e) => e.preventDefault()} onClick={() => command('formatBlock', 'blockquote')}>❝</button>
        <button type="button" title="Code" onMouseDown={(e) => e.preventDefault()} onClick={() => command('formatBlock', 'pre')}>{'</>'}</button><span />
        <button type="button" title="Add link" onMouseDown={(e) => e.preventDefault()} onClick={beginLink}>Link</button>
        <button type="button" title="Upload images" onMouseDown={(e) => e.preventDefault()} onClick={() => fileRef.current?.click()}>Image</button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { addImages(Array.from(e.target.files || [])); e.target.value = '' }} />
      </div>}
      {showLink && <div className="jira-link-editor"><input ref={linkInputRef} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink() } }} placeholder="https://example.com" /><button type="button" className="btn btn-primary btn-sm" onClick={applyLink}>Apply link</button><button type="button" className="btn btn-sm" onClick={() => { setShowLink(false); setLinkUrl('') }}>Cancel</button></div>}
      <div ref={editorRef} className="jira-rich-editor actual-result-rich-editor" contentEditable={!disabled} role="textbox" aria-label="Actual Result" aria-multiline="true" data-placeholder="Describe the observed result. Paste screenshots with Ctrl/Cmd+V…" onInput={sync} onPaste={paste} suppressContentEditableWarning />
      {images.length > 0 && <div className="jira-pasted-images">{images.map((image, index) => <div key={image.previewUrl} className="jira-pasted-image"><img src={image.previewUrl} alt={image.file.name} /><span>{image.file.name}</span><button type="button" title="Remove image" onClick={() => { URL.revokeObjectURL(image.previewUrl); setImages((current) => current.filter((_, i) => i !== index)) }}>×</button></div>)}</div>}
      {!disabled && <div className="jira-result-editor-foot"><span className={count > maxLength ? 'over-limit' : ''}>{count}/{maxLength} · Rich text · Paste or upload images</span></div>}
      <ErrorText error={error} title="Actual Result image could not be added" guidance="Use a supported image under 10 MB, then paste or upload it again. Your formatted result remains available." />
    </div>
  )
}
