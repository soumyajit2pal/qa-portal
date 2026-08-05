import React from 'react'
import { ErrorText } from '../../components/Common'
import { DraftChecklistEvidenceOut } from '../../types'
import { ChecklistEvidencePicker, EvidenceKind } from './ChecklistEvidencePicker'
import { useChecklistTemplate } from './useChecklistTemplate'

type ChecklistModule = 'FUNCTIONAL' | 'SAST' | 'DAST' | 'PERFORMANCE'

interface Props {
  module: ChecklistModule
  kind: EvidenceKind
  sectionNumber: string
  heading: string
  description: string
  noticeLabel: string
  noticeText: string
  selectedItems: string[]
  onToggle: (item: string) => void
  draftRequestId?: number
  evidenceFiles: (kind: EvidenceKind, itemIndex: number) => File[]
  setEvidenceFiles: (kind: EvidenceKind, itemIndex: number, files: File[]) => void
  savedEvidenceFor: (kind: EvidenceKind, itemIndex: number) => DraftChecklistEvidenceOut[]
  onEvidenceChanged: () => void
}

/** Shared, aligned self-declaration table used by every testing discipline. */
export function ReadinessChecklistSection({
  module,
  kind,
  sectionNumber,
  heading,
  description,
  noticeLabel,
  noticeText,
  selectedItems,
  onToggle,
  draftRequestId,
  evidenceFiles,
  setEvidenceFiles,
  savedEvidenceFor,
  onEvidenceChanged,
}: Props) {
  const { items, loading, error } = useChecklistTemplate(module)

  return (
    <section className="security-request-panel security-checklist-panel">
      <div className="security-panel-heading">
        <span className="security-panel-number">{sectionNumber}</span>
        <div>
          <h4>{heading}</h4>
          <p>{description}</p>
        </div>
      </div>

      <div className="security-checklist-notice">
        <strong>{noticeLabel}</strong>
        <span>{noticeText}</span>
      </div>

      {loading && <div className="security-checklist-loading">Loading readiness criteria…</div>}
      <ErrorText error={error} title={`${heading} could not be loaded`} />

      {!loading && items.length > 0 && (
        <div className="security-checklist-table" role="group" aria-label={`${module} readiness checklist`}>
          <div className="security-checklist-header" aria-hidden="true">
            <span>Ready</span>
            <span>Readiness criterion</span>
            <span>Supporting evidence</span>
          </div>
          {items.map((item, itemIndex) => {
            const checked = selectedItems.includes(item.item)
            const checkboxId = `${kind}-readiness-${item.id}`
            return (
              <div className={`security-checklist-row ${checked ? 'is-checked' : ''}`} key={item.id}>
                <div className="security-checklist-check">
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(item.item)}
                  />
                </div>
                <label className="security-checklist-criterion" htmlFor={checkboxId}>
                  <span>
                    <strong>{item.item}</strong>
                    {item.is_mandatory && <span className="badge badge-red">Mandatory</span>}
                  </span>
                  {item.detail && <small>{item.detail}</small>}
                </label>
                <ChecklistEvidencePicker
                  kind={kind}
                  itemIndex={itemIndex}
                  draftRequestId={draftRequestId}
                  files={evidenceFiles(kind, itemIndex)}
                  onFilesChange={(files) => setEvidenceFiles(kind, itemIndex, files)}
                  savedFiles={savedEvidenceFor(kind, itemIndex)}
                  onReload={onEvidenceChanged}
                  checked={checked}
                  required={item.is_mandatory || checked}
                />
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
