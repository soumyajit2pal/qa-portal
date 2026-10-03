import { portalDate, PORTAL_TIME_ZONE } from './time'

export const MAINTENANCE_WINDOW_ADMIN_PATH = '/api/system-settings/maintenance-window'
export const MAINTENANCE_WINDOW_CURRENT_PATH = `${MAINTENANCE_WINDOW_ADMIN_PATH}/current`
export const MAINTENANCE_WINDOW_CANCEL_PATH = `${MAINTENANCE_WINDOW_ADMIN_PATH}/cancel`

const IST_OFFSET = '+05:30'
const ACKNOWLEDGEMENT_PREFIX = 'qa_downtime_ack:'

function datePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value || ''
}

/** Convert an API instant to the portal's IST wall clock for datetime-local. */
export function maintenanceDateTimeInput(value?: string | null): string {
  if (!value) return ''
  const parsed = portalDate(value)
  if (Number.isNaN(parsed.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PORTAL_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(parsed)
  return `${datePart(parts, 'year')}-${datePart(parts, 'month')}-${datePart(parts, 'day')}T${datePart(parts, 'hour')}:${datePart(parts, 'minute')}`
}

/** Serialize an IST-labelled datetime-local value with an explicit offset. */
export function maintenanceDateTimeISO(value: string): string {
  const normalized = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) return ''
  return `${normalized}:00${IST_OFFSET}`
}

export function maintenanceAcknowledgementKey(userId: number, revision: number): string {
  return `${ACKNOWLEDGEMENT_PREFIX}${userId}:${revision}`
}

export function hasMaintenanceAcknowledgement(userId: number, revision: number): boolean {
  try { return sessionStorage.getItem(maintenanceAcknowledgementKey(userId, revision)) === '1' }
  catch { return false }
}

export function acknowledgeMaintenanceWindow(userId: number, revision: number): void {
  try { sessionStorage.setItem(maintenanceAcknowledgementKey(userId, revision), '1') }
  catch { /* The in-memory component state still prevents a repeated dialog. */ }
}

export function clearMaintenanceAcknowledgements(): void {
  try {
    const keys: string[] = []
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index)
      if (key?.startsWith(ACKNOWLEDGEMENT_PREFIX)) keys.push(key)
    }
    keys.forEach((key) => sessionStorage.removeItem(key))
  } catch { /* Logout remains available when browser storage is restricted. */ }
}
