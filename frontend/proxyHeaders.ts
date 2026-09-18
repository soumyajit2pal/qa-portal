import type { IncomingMessage, ClientRequest } from 'node:http'
import type { TLSSocket } from 'node:tls'

/** This development/UAT server is the browser-facing edge proxy. */
export function setClientProxyHeaders(outgoing: ClientRequest, incoming: IncomingMessage) {
  // Replace supplied values: a browser must not choose its audit/rate-limit IP.
  const address = incoming.socket.remoteAddress?.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1')
  outgoing.removeHeader('Forwarded')
  outgoing.removeHeader('X-Forwarded-For')
  outgoing.removeHeader('X-Real-IP')
  if (address) {
    outgoing.setHeader('X-Forwarded-For', address)
    outgoing.setHeader('X-Real-IP', address)
  }
  outgoing.setHeader('X-Forwarded-Proto', (incoming.socket as TLSSocket).encrypted ? 'https' : 'http')
}
