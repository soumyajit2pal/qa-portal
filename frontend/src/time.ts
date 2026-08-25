/** The QA Portal has one business timezone, independent of a user's browser. */
export const PORTAL_TIME_ZONE = 'Asia/Kolkata'
const IST_OFFSET = '+05:30'
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/**
 * API database columns are IST wall-clock values.  Oracle returns these
 * timezone-naive, so attach the portal offset before a browser parses them.
 */
export function portalDate(value: string | Date): Date {
  if (value instanceof Date) return value
  if (NAIVE_DATETIME.test(value) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    return new Date(`${value}${IST_OFFSET}`)
  }
  return new Date(value)
}

export function formatDateTimeIST(value: string | Date): string {
  return `${portalDate(value).toLocaleString('en-IN', {
    timeZone: PORTAL_TIME_ZONE,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })} IST`
}

export function formatDateIST(value: string | Date): string {
  return portalDate(value).toLocaleDateString('en-IN', {
    timeZone: PORTAL_TIME_ZONE,
    day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

/** `YYYY-MM-DD` for date inputs, calculated in IST rather than UTC/GMT. */
export function istToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PORTAL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** Serialize an instant with the portal's explicit +05:30 offset for APIs. */
export function toISTISOString(value: Date = new Date()): string {
  return new Date(value.getTime() + 5.5 * 60 * 60 * 1000).toISOString().replace('Z', IST_OFFSET)
}
