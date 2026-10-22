import React from 'react'
import RecordNumberLink from './RecordNumberLink'

export default function DefectNumberLink({ id, defectKey, loading, onOpen }: {
  id: number; defectKey: string; loading?: boolean; onOpen: () => void
}) {
  return <RecordNumberLink kind="defect" id={id} recordKey={defectKey} loading={loading} onOpen={onOpen} />
}
