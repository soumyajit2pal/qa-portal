// Shared by request validation and exact global-search routing.
export const CHANGE_REFERENCE_MAX_LENGTH = 15
export const CHANGE_REFERENCE_REGEX = /^(?=.{3,15}$)[A-Z]+-[0-9]+$/i
export const CHANGE_REFERENCE_FORMAT_ERROR = 'Use letters followed by a hyphen and digits (e.g. IN-46, CR-1234 or EPIC-123456), up to 15 characters.'
