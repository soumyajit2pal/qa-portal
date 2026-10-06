/** Mail links carry the database ID alongside the displayed business key. */
export function defectLinkTarget(params: URLSearchParams): number | string | null {
  const databaseId = params.get('openId')
  const key = params.get('open')?.trim()
  for (const candidate of [databaseId, key]) {
    if (candidate && /^[1-9]\d*$/.test(candidate) && Number.isSafeInteger(Number(candidate))) return Number(candidate)
  }
  return key || null
}

/** Resolve exact keys first, then allow DEF-00010 as shorthand for TQA-DEF-00010. */
export async function resolveDefect<T>(keyOrId: number | string, get: (path: string) => Promise<T>): Promise<T> {
  if (typeof keyOrId === 'number') return get(`/api/defects/${keyOrId}`)
  const key = keyOrId.trim()
  try {
    return await get(`/api/defects/by-key/${encodeURIComponent(key)}`)
  } catch (error) {
    const shorthand = /^DEF-(\d+)$/i.exec(key)
    if (!shorthand || (error as { status?: number })?.status !== 404) throw error
    // Existing legacy keys keep their identity. Only a missing exact key may
    // use the current namespace; access/network errors never trigger fallback.
    return get(`/api/defects/by-key/TQA-DEF-${shorthand[1].padStart(5, '0')}`)
  }
}
