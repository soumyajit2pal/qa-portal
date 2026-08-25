import React from 'react'
import type { RepeatableGroupField, RepeatableGroupRow } from './Common'
import { Field } from './Common'

export const SAST_COMPONENT_FIELDS: RepeatableGroupField[] = [
  { key: 'repository_url', label: 'Repository URL', placeholder: 'https://source-control/project/repository' },
  { key: 'git_branch', label: 'Branch' },
  { key: 'commit_id', label: 'Commit ID' },
  { key: 'technology_stack', label: 'Tech Stack' },
  { key: 'build_number', label: 'Build Number' },
]

export type SastRepositoryRow = RepeatableGroupRow

export function blankSastComponent(): SastRepositoryRow {
  return { repository_url: '', git_branch: '', commit_id: '', technology_stack: '', build_number: '' }
}

export default function SastRepositoryDetails({
  rows,
  onChange,
  hashValue,
  onHashChange,
  sectionNumber = '02',
}: {
  rows: SastRepositoryRow[]
  onChange: (rows: SastRepositoryRow[]) => void
  hashValue: string
  onHashChange: (value: string) => void
  sectionNumber?: string
}) {
  const data = rows.length ? rows : [blankSastComponent()]

  function setAt(index: number, key: string, value: string) {
    onChange(data.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row))
  }

  function addRepository() {
    onChange([...data, blankSastComponent()])
  }

  function removeRepository(index: number) {
    if (data.length <= 1) return
    onChange(data.filter((_, rowIndex) => rowIndex !== index))
  }

  return (
    <section className="security-request-panel sast-repository-details">
      <div className="security-panel-heading security-panel-heading-with-action">
        <span className="security-panel-number">{sectionNumber}</span>
        <div>
          <h4>Repository and build details</h4>
          <p>Add one complete, traceable record for every repository included in the scan.</p>
        </div>
        <button type="button" className="btn security-add-button" onClick={addRepository}>+ Add repository</button>
      </div>
      <div className="security-target-list">
        {data.map((repository, index) => (
          <div className="security-target-card" key={index}>
            <div className="security-target-card-head">
              <span>Repository {String(index + 1).padStart(2, '0')}</span>
              {data.length > 1 && (
                <button type="button" className="security-remove-button" aria-label={`Remove repository ${index + 1}`} onClick={() => removeRepository(index)}>Remove</button>
              )}
            </div>
            <div className="security-repository-grid">
              {SAST_COMPONENT_FIELDS.map((field) => (
                <label className={`security-control security-control-${field.key.split('_').join('-')}`} key={field.key}>
                  <span>{field.label} *</span>
                  <input
                    required
                    value={repository[field.key] || ''}
                    placeholder={field.placeholder || field.label}
                    onChange={(event) => setAt(index, field.key, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="security-hash-field">
        <Field label="SHA256 / MD5 Hash">
          <input value={hashValue} onChange={(event) => onHashChange(event.target.value)} placeholder="Optional build or artifact hash" />
        </Field>
        <p>Optional, but recommended when a packaged build or artifact is supplied for scanning.</p>
      </div>
    </section>
  )
}
