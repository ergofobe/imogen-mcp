import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { OAuthClient, type StoredTokens } from '@imogen/sdk'

export type Credentials = {
  server: string
  clientId: string
  tokens: StoredTokens
}

/** Follows the XDG convention, falling back to ~/.config on systems that do not set it. */
export function credentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'imogen', 'credentials.json')
}

export function readCredentials(): Credentials | null {
  const path = credentialsPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Credentials
  } catch {
    return null
  }
}

/** Written owner-only: this file holds a token that reads someone's whole photo library. */
export function writeCredentials(credentials: Credentials): void {
  const path = credentialsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(credentials, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
}

/**
 * Returns a usable access token, refreshing first when the current one is close to
 * expiring. Refreshing slightly early avoids a request failing mid-conversation.
 */
export async function currentAccessToken(credentials: Credentials): Promise<string> {
  if (!OAuthClient.isExpired(credentials.tokens)) return credentials.tokens.access_token

  const refreshToken = credentials.tokens.refresh_token
  if (!refreshToken) {
    throw new Error('Your saved session has expired. Run `imogen-mcp login` again.')
  }

  const oauth = new OAuthClient(credentials.server)
  const refreshed = await oauth.refresh(credentials.clientId, refreshToken).catch(() => null)
  if (!refreshed) {
    throw new Error('Could not refresh your session. Run `imogen-mcp login` again.')
  }

  writeCredentials({ ...credentials, tokens: refreshed })
  return refreshed.access_token
}
