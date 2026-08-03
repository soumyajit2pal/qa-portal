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
} from './RichTextEditor'

// A plain controlled rich-text form input (value/onChange/onImagesChange) --
// used for Test Execution's "Actual Result" field. Shares its editing
// mechanics with JiraActivity.tsx's comment composer via RichTextEditor.tsx;
// this file only owns what's specific to being a controlled form field
// (seeding from an initial markdown value, reporting images back up,
// character-count footer).
export default function JiraRichTextField({ value, disabled, onChange, onImagesChange, maxLength = 10000 }: {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  onImagesChange: (files: File[]) => void
  maxLength?: number
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const initialized = useRef(false)
  const onImagesChangeRef = useRef(onImagesChange)
  const [error, setError] = useState('')
  const [count, setCount] = useState(value.length)

  const { images, addImages, removeImage, pasteImages } = useRichTextImages({
    filenamePrefix: 'actual-result',
    messages: {
      tooLarge: (name) => `“${name}” exceeds the 10 MB limit.`,
      tooMany: () => `Actual Result can contain at most ${RICH_TEXT_MAX_IMAGES} images per save.`,
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

  return (
    <div className="jira-result-editor">
      {!disabled && (
        <RichTextToolbar
          ariaLabel="Actual Result formatting"
          codeButtonTitle="Code"
          imageButtonTitle="Upload images"
          onCommand={command}
          onBeginLink={beginLink}
          onPickImage={() => fileRef.current?.click()}
        />
      )}
      <RichTextImageInput inputRef={fileRef} onFiles={addImages} />
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
        aria-label="Actual Result"
        aria-multiline="true"
        data-placeholder="Describe the observed result. Paste screenshots with Ctrl/Cmd+V…"
        onInput={sync}
        onPaste={pasteImages}
        suppressContentEditableWarning
      />
      <RichTextPastedImages images={images} onRemove={removeImage} />
      {!disabled && (
        <div className="jira-result-editor-foot">
          <span className={count > maxLength ? 'over-limit' : ''}>{count}/{maxLength} · Rich text · Paste or upload images</span>
        </div>
      )}
      <ErrorText error={error} title="Actual Result image could not be added" guidance="Use a supported image under 10 MB, then paste or upload it again. Your formatted result remains available." />
    </div>
  )
}
