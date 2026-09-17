export interface LoginKey {
  algorithm: string
  key_id: string
  public_key: string
  challenge: string
  expires_in: number
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function encodeBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
}

export async function encryptLogin(key: LoginKey, username: string, password: string) {
  if (!window.crypto?.subtle || key.algorithm !== 'RSA-OAEP-256+A256GCM') {
    throw new Error('Secure login encryption is unavailable. Use HTTPS and a supported browser.')
  }
  const publicKey = await crypto.subtle.importKey('spki', decodeBase64(key.public_key),
    { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify({ username, password }))
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
      additionalData: new TextEncoder().encode(key.challenge), tagLength: 128 }, aesKey, plaintext)
    const rawKey = await crypto.subtle.exportKey('raw', aesKey)
    const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawKey)
    new Uint8Array(rawKey).fill(0)
    return { key_id: key.key_id, challenge: key.challenge, wrapped_key: encodeBase64(wrappedKey),
      iv: encodeBase64(iv), ciphertext: encodeBase64(ciphertext) }
  } finally {
    plaintext.fill(0)
  }
}
