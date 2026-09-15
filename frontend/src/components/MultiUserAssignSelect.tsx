import React from 'react'
import UserPicker, { PickerUser } from './UserPicker'

interface MultiUserAssignSelectProps {
  value: string[]
  onChange: (value: string[]) => void
  users: PickerUser[]
  placeholder: string
  disabled?: boolean
  style?: React.CSSProperties
  showRoles?: boolean
}

/** Multi-value adapter for the shared UserPicker. */
export default function MultiUserAssignSelect(props: MultiUserAssignSelectProps) {
  return <UserPicker {...props} multiple showRoles={props.showRoles ?? true} onChange={(value) => props.onChange(value as string[])} />
}
