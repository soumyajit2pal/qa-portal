import React from 'react'
import { Field } from './Common'
import JiraRichTextField from './JiraRichTextField'
import { DEFECT_EVIDENCE_EXTENSIONS } from '../defectEvidence'

/** The same actual-result editor and evidence inputs for first runs and retests. */
export default function ExecutionEvidenceFields({ actual, onActual, onImages, files, onFiles, reference, onReference, disabled = false }: {
  actual: string; onActual: (value: string) => void; onImages: (files: File[]) => void
  files: File[]; onFiles: (files: File[]) => void
  reference: string; onReference: (value: string) => void; disabled?: boolean
}) {
  return <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    <Field label="Actual Result"><JiraRichTextField value={actual} disabled={disabled} onChange={onActual} onImagesChange={onImages} /></Field>
    <Field label="Execution Evidence"><div className="defect-evidence">
      <label className="btn btn-sm">+ Add attachments<input type="file" multiple hidden disabled={disabled}
        accept={DEFECT_EVIDENCE_EXTENSIONS.join(',')} onChange={event => {
          const selected = Array.from(event.target.files || [])
          if (selected.length) onFiles([...files, ...selected])
          event.target.value = ''
        }} /></label>
      {!!files.length && <div className="defect-files">{files.map((file, index) => <button type="button"
        key={`${file.name}-${file.size}-${index}`} disabled={disabled} onClick={() => onFiles(files.filter((_, i) => i !== index))}>{file.name} ✕</button>)}</div>}
      <small className="muted">Documents, images, MP4, MOV, WebM, or AVI; maximum 25 MB per file.</small>
    </div></Field>
    <Field label="Test Run Artifacts"><input value={reference} maxLength={255} disabled={disabled}
      onChange={event => onReference(event.target.value)} placeholder="Link, filename, or reference" /></Field>
  </fieldset>
}
