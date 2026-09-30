import type { Credentials } from './credentials.ts'
import { forwardMessage } from './bridge.ts'

const PARSE_ERROR = {
  jsonrpc: '2.0' as const,
  id: null,
  error: { code: -32700, message: 'Parse error' },
}

/**
 * The other front door onto the bridge.
 *
 * `runBridge` reads newline-delimited JSON-RPC from stdin. This listens for the same
 * messages as HTTP POST `/mcp` and answers with whatever `replyTo` already decided,
 * over TLS the caller configured. It does not mint a certificate.
 */
export function startMcpHost(options: {
  credentials: Credentials
  cert: string | ReturnType<typeof Bun.file>
  key: string | ReturnType<typeof Bun.file>
  port?: number
  hostname?: string
}) {
  const credentials = options.credentials

  return Bun.serve({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? 8443,
    tls: {
      cert: options.cert,
      key: options.key,
    },
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== 'POST' || url.pathname !== '/mcp') {
        return new Response('Not found', { status: 404 })
      }

      let message: unknown
      try {
        message = await request.json()
      } catch {
        return Response.json(PARSE_ERROR)
      }
      if (message === null || typeof message !== 'object') {
        return Response.json(PARSE_ERROR)
      }

      const reply = await forwardMessage(credentials, message as { id?: unknown; method?: string })
      if (reply === undefined) return new Response(null, { status: 202 })
      return Response.json(reply)
    },
  })
}
