import React from 'react'
import { Field } from '../../components/Common'
import { QARequestOut } from '../../types'
import { QARequestForm, SetField } from '../types'

interface Props {
  form: QARequestForm
  set: SetField
  editing?: QARequestOut
  files: File[]
  setFiles: (files: File[]) => void
}

// Last wizard step -- supporting document upload, remarks, and (for a
// brand-new request) a reminder of what Submit is about to do.
export function DocumentsStep({ form, set, editing, files, setFiles }: Props) {
  return (
    <>
      <div className="form-section">
        <div className="form-section-title">Supporting Documents</div>
        <Field label="Upload (multiple files supported)">
          <input
            type="file"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files || []))}
          />
          {files.length > 0 && (
            <p className="muted small" style={{ marginTop: 4 }}>
              {files.length} file{files.length > 1 ? 's' : ''} selected: {files.map((f) => f.name).join(', ')}
            </p>
          )}
        </Field>
      </div>

      <div className="form-section">
        <div className="form-section-title">Remarks</div>
        <Field label="Additional notes (optional)"><textarea value={form.remarks} onChange={(e) => set('remarks', e.target.value)} /></Field>
      </div>

      {!editing && (
        <p className="muted small" style={{ marginTop: -4 }}>
          Submitting will raise this request and immediately create whichever linked request(s) your
          selected types call for — you'll land back on this gateway record (with links to each) right after.
        </p>
      )}
    </>
  )
}
