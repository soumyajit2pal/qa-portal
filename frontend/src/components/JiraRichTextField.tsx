import React, { useEffect, useRef, useState } from 'react'
import { ErrorText } from './Common'
import {
  RICH_TEXT_MAX_IMAGES,
  editorContentToMarkdown,
  markdownToEditorHtml,
  useRichTextImages,
  useRichTextLink,
  RichTextToolbar,
  RichTextImageInput,
  RichTextLinkEditor,
  RichTextPastedImages,
  insertRichTextImages,
} from './RichTextEditor'

// A plain controlled rich-text form input (value/onChange/onImagesChange) --
// used for Test Execution's "Actual Result" field. Shares its editing
// mechanics with JiraActivity.tsx's comment composer via RichTextEditor.tsx;
// this file only owns what's specific to being a controlled form field
// (seeding from an initial markdown value, reporting images back up,
// character-count footer).
export default function JiraRichTextField({ value, disabled, onChange, onImagesChange, maxLength = 10000, allowImages = true,
  ariaLabel = 'Actual Result', placeholder = 'Describe the observed result. Paste screenshots with Ctrl/Cmd+V…' }: {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  onImagesChange: (files: File[]) => void
  maxLength?: number
  allowImages?: boolean
  ariaLabel?: string
  placeholder?: string
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const validityRef = useRef<HTMLInputElement>(null)
  const initialized = useRef(false)
  const imageInsertRange = useRef<Range | null>(null)
  const onImagesChangeRef = useRef(onImagesChange)
  const [error, setError] = useState('')
  const [count, setCount] = useState(value.length)
  const lengthError = count > maxLength
    ? `${ariaLabel} exceeds the ${maxLength.toLocaleString()} character limit. Remove ${(count - maxLength).toLocaleString()} characters before saving or continuing.`
    : ''

  // Reported directly: pasting/uploading into Expected Result (or Steps to
  // Reproduce) still named the file "actual-result-...png" -- this hook was
  // originally written for just the one field and never parameterized its
  // filename/messages by which field it's actually mounted in, so every
  // JiraRichTextField instance shared the same literal "actual-result"
  // prefix regardless of its own ariaLabel. Derived from ariaLabel instead,
  // so Steps to Reproduce/Actual Result/Expected Result (and any future
  // field) each get their own correctly-named files and messages.
  const fieldSlug = ariaLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'result'
  const { images, addImages, removeImage, pasteImages } = useRichTextImages({
    filenamePrefix: fieldSlug,
    messages: {
      tooLarge: (name) => `“${name}” exceeds the 10 MB limit.`,
      tooMany: () => `${ariaLabel} can contain at most ${RICH_TEXT_MAX_IMAGES} images per save.`,
    },
    onError: setError,
  })
  const { showLink, linkUrl, setLinkUrl, linkInputRef, beginLink, applyLink, cancelLink } = useRichTextLink(editorRef, setError)

  useEffect(() => {
    if (!initialized.current && editorRef.current) {
      editorRef.current.innerHTML = markdownToEditorHtml(value)
      initialized.current = true
    }
  }, [value])
  useEffect(() => { onImagesChangeRef.current = onImagesChange }, [onImagesChange])
  useEffect(() => { onImagesChangeRef.current(images.map((image) => image.file)) }, [images])
  useEffect(() => {
    validityRef.current?.setCustomValidity(lengthError)
  }, [lengthError])

  function sync() {
    const markdown = editorContentToMarkdown(editorRef.current)
    setCount(markdown.length)
    onChange(markdown)
  }

  function command(name: string, commandValue?: string) {
    editorRef.current?.focus()
    document.execCommand(name, false, commandValue)
    sync()
  }

  function insertTable() {
    editorRef.current?.focus()
    document.execCommand('insertHTML', false,
      '<table><thead><tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr></thead>' +
      '<tbody><tr><td>Value</td><td>Value</td><td>Value</td></tr><tr><td>Value</td><td>Value</td><td>Value</td></tr></tbody></table><div><br></div>')
    sync()
  }

  function rememberImagePosition() {
    const selection = window.getSelection()
    imageInsertRange.current = selection?.rangeCount && editorRef.current?.contains(selection.anchorNode)
      ? selection.getRangeAt(0).cloneRange() : null
    fileRef.current?.click()
  }

  function addInlineImages(files: File[]) {
    const accepted = addImages(files)
    insertRichTextImages(editorRef.current, accepted, imageInsertRange.current)
    imageInsertRange.current = null
    if (accepted.length) sync()
  }

  function pasteInlineImages(event: React.ClipboardEvent<HTMLDivElement>) {
    const accepted = pasteImages(event)
    insertRichTextImages(editorRef.current, accepted)
    if (accepted.length) sync()
  }

  function removeInlineImage(previewUrl: string) {
    const image = images.find((item) => item.previewUrl === previewUrl)
    if (image && editorRef.current) {
      editorRef.current.querySelectorAll(`[data-rich-image-name="${CSS.escape(image.file.name)}"]`).forEach((node) => node.parentElement?.remove())
    }
    removeImage(previewUrl)
    sync()
  }

  return (
    <div className="jira-result-editor">
      {!disabled && (
        <RichTextToolbar
          ariaLabel={`${ariaLabel} formatting`}
          codeButtonTitle="Code"
          imageButtonTitle="Add image"
          onCommand={command}
          onBeginLink={beginLink}
          onPickImage={allowImages ? rememberImagePosition : undefined}
          onInsertTable={insertTable}
        />
      )}
      {allowImages && <RichTextImageInput inputRef={fileRef} onFiles={addInlineImages} />}
      {showLink && (
        <RichTextLinkEditor
          linkUrl={linkUrl}
          onChange={setLinkUrl}
          onApply={() => applyLink(command)}
          onCancel={cancelLink}
          inputRef={linkInputRef}
        />
      )}
      <div
        ref={editorRef}
        className="jira-rich-editor actual-result-rich-editor"
        contentEditable={!disabled}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        aria-invalid={count > maxLength}
        data-placeholder={placeholder}
        onInput={sync}
        onPaste={allowImages ? pasteInlineImages : undefined}
        suppressContentEditableWarning
      />
      <input
        ref={validityRef}
        className="rich-text-validity-proxy"
        value=""
        onChange={() => undefined}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        onInvalid={(event) => {
          event.preventDefault()
          editorRef.current?.focus()
        }}
      />
      {allowImages && <RichTextPastedImages images={images} onRemove={removeInlineImage} />}
      {!disabled && (
        <div className="jira-result-editor-foot">
          <span className={count > maxLength ? 'over-limit' : ''}>{count}/{maxLength} · Rich text{allowImages ? ' · Paste or upload images' : ''}</span>
        </div>
      )}
      <ErrorText error={lengthError || error} title={count > maxLength ? `${ariaLabel} is too long` : `${ariaLabel} image could not be added`} guidance={count > maxLength ? `Reduce this field to ${maxLength.toLocaleString()} characters or fewer. Save and workflow actions are blocked until it is corrected.` : 'Use a supported image under 10 MB, then paste or upload it again. Your formatted result remains available.'} />
    </div>
  )
}
