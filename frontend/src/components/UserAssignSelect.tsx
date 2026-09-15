import React from 'react'
import UserPicker, { PickerUser } from './UserPicker'

interface UserAssignSelectProps {
  value: string
  onChange: (value: string) => void
  users: PickerUser[]
  placeholder: string
  disabled?: boolean
  style?: React.CSSProperties
  showRoles?: boolean
  clearable?: boolean
  clearLabel?: string
}

/** Single-value adapter for the shared UserPicker. */
export default function UserAssignSelect(props: UserAssignSelectProps) {
  return <UserPicker {...props} showRoles={props.showRoles ?? true} onChange={(value) => props.onChange(value as string)} />
}
