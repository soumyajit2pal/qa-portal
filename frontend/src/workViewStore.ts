export type WorkKind = 'add-cases' | 'defect' | 'functional' | 'observation'
export interface WorkTarget { kind: WorkKind; id: number | 'new' }
export interface WorkSnapshot {
  scope: string; target: string; data: Record<string, unknown>; lists: Record<string, unknown>
  returnTo: string; expiresAt: number
  draftTag?: string
}
export function workKey(target: WorkTarget) { return `${target.kind}:${target.id}` }
export function workPath(target: WorkTarget) {
  if (target.kind === 'observation') return '/work/observations/new'
  if (target.kind === 'add-cases') return `/work/test-cycles/${target.id}/add-cases`
  if (target.kind === 'functional') return `/work/functional-requests/${target.id}`
  return `/work/defects/${target.id}`
}
export function parseWorkPath(path: string): WorkTarget | null {
  if (path === '/work/observations/new') return { kind: 'observation', id: 'new' }
  const match = /^\/work\/(test-cycles|functional-requests|defects)\/([1-9]\d*|new)(\/add-cases)?$/.exec(path)
  if (!match || (match[1] === 'test-cycles') !== !!match[3]) return null
  if (match[2] === 'new' && match[1] !== 'defects') return null
  const id = match[2] === 'new' ? 'new' : Number(match[2])
  if (typeof id === 'number' && !Number.isSafeInteger(id)) return null
  return { kind: match[1] === 'test-cycles' ? 'add-cases' : match[1] === 'defects' ? 'defect' : 'functional', id }
}
export function validSnapshot(value: WorkSnapshot | undefined, scope: string, target: WorkTarget) {
  return !!value && value.scope === scope && value.target === workKey(target) && value.expiresAt > Date.now()
}

// IndexedDB preserves File/Blob/Set values when a draft is handed to another
// tab. URLs carry only a random key, never form contents or attachments.
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('qualityops-work-views', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('handoffs')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('Draft transfer storage is unavailable. Your current view is still open.'))
  })
}
export async function saveWorkSnapshot(value: WorkSnapshot): Promise<string> {
  const id = crypto.randomUUID(), db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('handoffs', 'readwrite'), store = tx.objectStore('handoffs')
      const scan = store.openCursor()
      scan.onsuccess = () => { const cursor = scan.result; if (!cursor) return; if (cursor.value.expiresAt <= Date.now()) cursor.delete(); cursor.continue() }
      store.put(value, id)
      tx.oncomplete = () => resolve()
      tx.onerror = tx.onabort = () => reject(new Error('Could not preserve this draft. Your current view is still open.'))
    })
    return id
  } finally { db.close() }
}
export async function readWorkSnapshot(id: string): Promise<WorkSnapshot | undefined> {
  if (!/^[\da-f-]{36}$/i.test(id)) return undefined
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('handoffs').objectStore('handoffs').get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error('Could not restore this draft.'))
    })
  } finally { db.close() }
}
