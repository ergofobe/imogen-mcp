import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Credentials } from './credentials.ts'
import { startMcpHost } from './host.ts'

const credentials: Credentials = {
  server: 'https://photos.example.com',
  clientId: 'client',
  tokens: {
    access_token: 'fake-token',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'library:read',
    obtainedAt: Date.now(),
  },
}

const root = mkdtempSync(join(tmpdir(), 'imogen-mcp-host-'))
const certPath = join(root, 'cert.pem')
const keyPath = join(root, 'key.pem')
const configHome = join(root, 'config')

const originalFetch = globalThis.fetch
let upstream: () => Response = () => new Response('unconfigured', { status: 500 })
let fetchCalls = 0
let server: ReturnType<typeof startMcpHost> | undefined

beforeAll(async () => {
  const proc = Bun.spawn(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=127.0.0.1',
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(err)
})

beforeEach(() => {
  fetchCalls = 0
  upstream = () => new Response('unconfigured', { status: 500 })
  globalThis.fetch = (async () => {
    fetchCalls += 1
    return upstream()
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (server) {
    await server.stop(true)
    server = undefined
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function listen() {
  server = startMcpHost({
    credentials,
    cert: Bun.file(certPath),
    key: Bun.file(keyPath),
    port: 0,
    hostname: '127.0.0.1',
  })
  return server.port ?? 0
}

function httpsCall(
  port: number,
  path: string,
  method: string,
  body?: string,
): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        rejectUnauthorized: false,
        headers: body
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            contentType: res.headers['content-type'],
          }),
        )
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'cli.ts'), ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: configHome, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const done = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const timeout = Bun.sleep(4000).then(() => 'timeout' as const)
  const result = await Promise.race([done.then((value) => ({ value })), timeout])
  if (result === 'timeout') {
    proc.kill()
    await proc.exited
    return { code: -1, stdout: '', stderr: 'timed out' }
  }
  const [stdout, stderr, code] = result.value
  return { code, stdout, stderr }
}

describe('HTTPS host', () => {
  test('answers only POST /mcp', async () => {
    const port = listen()

    const get = await httpsCall(port, '/mcp', 'GET')
    const other = await httpsCall(port, '/callback', 'POST', '{}')

    expect(get.status).toBe(404)
    expect(get.body).toBe('Not found')
    expect(other.status).toBe(404)
    expect(fetchCalls).toBe(0)
  })

  test('answers a notification with 202 and an empty body', async () => {
    upstream = () => new Response(null, { status: 202 })
    const port = listen()

    const response = await httpsCall(
      port,
      '/mcp',
      'POST',
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    )

    expect(response.status).toBe(202)
    expect(response.body).toBe('')
    expect(fetchCalls).toBe(1)
  })

  test('returns the forwarded JSON reply', async () => {
    const body = { jsonrpc: '2.0', id: 7, result: { ok: true } }
    upstream = () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    const port = listen()

    const response = await httpsCall(
      port,
      '/mcp',
      'POST',
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }),
    )

    expect(response.status).toBe(200)
    expect(response.contentType).toContain('application/json')
    expect(JSON.parse(response.body)).toEqual(body)
  })

  test('reuses the error object replyTo builds for a refusal', async () => {
    upstream = () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Authorization required' },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      )
    const port = listen()

    const response = await httpsCall(
      port,
      '/mcp',
      'POST',
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    )
    const reply = JSON.parse(response.body) as { id: unknown; error: { message: string } }

    expect(response.status).toBe(200)
    expect(reply.id).toBe(4)
    expect(reply.error.message).toContain('imogen-mcp login')
  })

  test('reports a body that is not JSON', async () => {
    const port = listen()

    const response = await httpsCall(port, '/mcp', 'POST', 'not-json')
    const reply = JSON.parse(response.body) as { error: { code: number; message: string } }

    expect(response.status).toBe(200)
    expect(reply.error.code).toBe(-32700)
    expect(reply.error.message).toBe('Parse error')
    expect(fetchCalls).toBe(0)
  })
})

describe('host command', () => {
  test('missing cert or key exits non-zero', async () => {
    const { code, stderr } = await runCli(['host'])

    expect(code).not.toBe(0)
    expect(stderr).toContain('imogen-mcp host --cert <path> --key <path>')
  })

  test('a missing certificate file is an error, not a generated one', async () => {
    const { code, stderr } = await runCli(['host', '--cert', join(root, 'missing.pem'), '--key', keyPath])

    expect(code).not.toBe(0)
    expect(stderr).toContain('No certificate at')
  })

  test('without credentials, host exits with the stdio not-connected error', async () => {
    const { code, stderr } = await runCli([
      'host',
      '--cert',
      certPath,
      '--key',
      keyPath,
      '--hostname',
      '127.0.0.1',
      '--port',
      '8443',
    ])

    expect(code).toBe(1)
    expect(stderr).toBe('Not connected to a library. Run: imogen-mcp login --server <url>\n')
  })

  test('no command still runs the stdio bridge', async () => {
    const { code, stderr } = await runCli([])

    expect(code).toBe(1)
    expect(stderr).toBe('Not connected to a library. Run: imogen-mcp login --server <url>\n')
  })

  test('the host command listens on the configured TLS port', async () => {
    const dir = join(configHome, 'imogen')
    mkdirSync(dir, { recursive: true })
    const credentialsPath = join(dir, 'credentials.json')
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        ...credentials,
        tokens: { ...credentials.tokens, obtainedAt: Date.now() },
      }),
      { mode: 0o600 },
    )

    const probe = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('busy'),
    })
    const port = probe.port ?? 0
    await probe.stop(true)

    const proc = Bun.spawn(
      [
        'bun',
        join(import.meta.dir, 'cli.ts'),
        'host',
        '--cert',
        certPath,
        '--key',
        keyPath,
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    let stderr = ''
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    const deadline = Date.now() + 5000
    try {
      while (Date.now() < deadline && !stderr.includes('Listening')) {
        const next = await Promise.race([
          reader.read(),
          Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null),
        ])
        if (next === null || next.done) break
        stderr += decoder.decode(next.value)
      }

      expect(stderr).toContain(`https://127.0.0.1:${port}/mcp`)
      const response = await httpsCall(port, '/health', 'GET')
      expect(response.status).toBe(404)
      expect(response.body).toBe('Not found')
    } finally {
      proc.kill()
      await proc.exited
      rmSync(credentialsPath, { force: true })
    }
  })
})
