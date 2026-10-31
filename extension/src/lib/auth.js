// Protected OAuth via launchWebAuthFlow. Refresh tokens are single-use and refreshes are serialised.
import { buildAuthorizeUrl, randomState } from './config.js'
import { getConfig, KEYS, localGet, localRemove, localSet } from './storage.js'

const ACCESS_MIN_TTL_MS = 30_000
const REFRESH_TIMEOUT_MS = 60_000
const REVOKE_TIMEOUT_MS = 20_000

export class AuthError extends Error {
  constructor(code, message) {
    super(message || 'Authentication failed')
    this.name = 'AuthError'
    this.code = code
  }
}

export class AuthUnavailableError extends Error {
  constructor(message) {
    super(message || 'jawbts-api is unavailable')
    this.name = 'AuthUnavailableError'
  }
}

let refreshPromise = null

export function redirectUri() {
  return chrome.identity.getRedirectURL('oauth')
}

export function extensionId() {
  return chrome.runtime.id
}

export function decodeJwt(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function accessExpiry(token, expiresIn, fallbackNow = Date.now()) {
  const claims = decodeJwt(token)
  if (claims && Number.isFinite(Number(claims.exp))) return Number(claims.exp) * 1000
  const seconds = Number(expiresIn)
  return fallbackNow + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000
}

function sessionFromTokenData(data, previous = null) {
  const accessToken = String(data.token || data.access_token || '')
  const refreshToken = String(data.refreshToken || data.refresh_token || previous?.refreshToken || '')
  if (!accessToken || !refreshToken) throw new AuthError('invalid_response', 'The API did not return tokens.')
  const claims = decodeJwt(accessToken)
  return {
    v: 1,
    accessToken,
    accessExpiresAt: accessExpiry(accessToken, data.expiresIn ?? data.expires_in),
    refreshToken,
    refreshExpiresAt: data.refreshTokenExpiresAt || data.refresh_token_expires_at || previous?.refreshExpiresAt || null,
    scope: Array.isArray(data.scope) ? data.scope.filter((item) => typeof item === 'string') : (previous?.scope || []),
    subject: typeof claims?.sub === 'string' ? claims.sub : (previous?.subject || null),
    sessionId: typeof claims?.sid === 'string' ? claims.sid : (previous?.sessionId || null),
    updatedAt: Date.now(),
  }
}

function parseCallback(callbackUrl, expectedState) {
  let url
  try {
    url = new URL(callbackUrl)
  } catch {
    throw new AuthError('invalid_redirect', 'The OAuth callback was not a valid URL.')
  }
  const raw = url.hash && url.hash.length > 1 ? url.hash.slice(1) : url.search.slice(1)
  const params = new URLSearchParams(raw)

  const error = params.get('error')
  if (error) {
    throw new AuthError(error, params.get('error_description') || 'Authorization was denied.')
  }
  const state = params.get('state')
  if (!expectedState || state !== expectedState) {
    throw new AuthError('state_mismatch', 'The OAuth state did not match; login was discarded.')
  }
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  if (!accessToken || !refreshToken) {
    throw new AuthError('invalid_response', 'The gateway did not return both tokens.')
  }
  return {
    v: 1,
    accessToken,
    accessExpiresAt: accessExpiry(accessToken, params.get('expires_in')),
    refreshToken,
    refreshExpiresAt: params.get('refresh_token_expires_at'),
    scope: String(params.get('scope') || '')
      .split(/\s+/)
      .filter(Boolean),
    subject: decodeJwt(accessToken)?.sub || null,
    sessionId: decodeJwt(accessToken)?.sid || null,
    tokenId: params.get('token_id') || null,
    updatedAt: Date.now(),
  }
}

async function postJson(url, body, { token = null, timeout = REFRESH_TIMEOUT_MS } = {}) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new AuthUnavailableError('jawbts-api did not respond in time.')
    }
    throw new AuthUnavailableError('Could not reach jawbts-api.')
  }
  let envelope = null
  try {
    envelope = await response.json()
  } catch {
    envelope = null
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new AuthUnavailableError(`jawbts-api returned HTTP ${response.status} without JSON.`)
  }
  return { response, envelope }
}

function definitiveAuthFailure(code) {
  return [10000, 10002, 10005, 10006].includes(Number(code))
}

async function clearIfDefinitive(code) {
  if (definitiveAuthFailure(code)) {
    await localRemove([KEYS.session])
    return true
  }
  return false
}

export async function connect() {
  const config = await getConfig()
  if (config.devMode) return { devMode: true }
  const state = randomState()
  await localSet({ [KEYS.oauthState]: state })
  let callbackUrl
  try {
    callbackUrl = await chrome.identity.launchWebAuthFlow({
      url: buildAuthorizeUrl(config, redirectUri(), state),
      interactive: true,
    })
  } catch (error) {
    await localRemove([KEYS.oauthState])
    throw new AuthError('cancelled', error?.message || 'The authorization window was closed.')
  }
  await localRemove([KEYS.oauthState])
  if (!callbackUrl) throw new AuthError('cancelled', 'The authorization window was closed.')

  const session = parseCallback(callbackUrl, state)
  if (config.scope && !session.scope.includes(config.scope)) {
    throw new AuthError(
      'insufficient_scope',
      `The gateway did not grant "${config.scope}". Request that scope in /authorize.`,
    )
  }
  await localSet({ [KEYS.session]: session })
  return session
}

async function performRefresh(session, config) {
  if (!session?.refreshToken) throw new AuthError('no_session', 'No refresh token is stored.')
  if (session.refreshExpiresAt) {
    const expires = Date.parse(session.refreshExpiresAt)
    if (Number.isFinite(expires) && expires <= Date.now()) {
      await localRemove([KEYS.session])
      throw new AuthError('refresh_expired', 'The refresh token has expired; sign in again.')
    }
  }

  const { response, envelope } = await postJson(
    `${config.apiBaseUrl}/auth/refresh`,
    { refreshToken: session.refreshToken },
    { timeout: REFRESH_TIMEOUT_MS },
  )

  if (!response.ok || envelope.success !== true) {
    const code = Number(envelope.code)
    await clearIfDefinitive(code)
    if (definitiveAuthFailure(code)) {
      throw new AuthError(code, envelope.message || 'The session is no longer valid.')
    }
    if (response.status >= 500 || response.status === 429) {
      throw new AuthUnavailableError(envelope.message || 'jawbts-api could not refresh the session.')
    }
    throw new AuthError(code || 'refresh_failed', envelope.message || 'Could not refresh the session.')
  }

  const data = envelope.data
  const next = sessionFromTokenData(data, session)
  await localSet({ [KEYS.session]: next })
  return next
}

export async function refreshSession() {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    const [config, session] = await Promise.all([getConfig(), localGet(KEYS.session)])
    return performRefresh(session[KEYS.session], config)
  })().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

export async function getSession() {
  const stored = await localGet(KEYS.session)
  return stored[KEYS.session] || null
}

export async function getAccessToken({ forceRefresh = false } = {}) {
  const config = await getConfig()
  if (config.devMode) return null
  const session = await getSession()
  if (!session) throw new AuthError('no_session', 'Connect your Jawbts account first.')
  if (
    !forceRefresh &&
    session.accessToken &&
    Number(session.accessExpiresAt) > Date.now() + ACCESS_MIN_TTL_MS
  ) {
    return session.accessToken
  }
  const refreshed = await refreshSession()
  return refreshed.accessToken
}

export async function authStatus() {
  const config = await getConfig()
  if (config.devMode) {
    return {
      connected: true,
      devMode: true,
      subject: 'local-dev',
      scope: [config.scope],
      redirectUri: redirectUri(),
    }
  }
  const session = await getSession()
  if (!session) return { connected: false, subject: null, scope: [], redirectUri: redirectUri() }
  return {
    connected: true,
    subject: session.subject,
    scope: session.scope || [],
    accessExpiresAt: session.accessExpiresAt,
    refreshExpiresAt: session.refreshExpiresAt,
    redirectUri: redirectUri(),
  }
}

export async function disconnect() {
  const config = await getConfig()
  if (config.devMode) {
    await localRemove([KEYS.session, KEYS.oauthState])
    return { revoked: false, devMode: true }
  }
  const session = await getSession()
  if (!session) return { revoked: false }
  let revoked = false
  try {
    const token = session.accessToken &&
      Number(session.accessExpiresAt) > Date.now() + 5_000
      ? session.accessToken
      : await getAccessToken()
    const claims = decodeJwt(token)
    if (typeof claims?.sid === 'string') {
      const config = await getConfig()
      const { response } = await postJson(
        `${config.apiBaseUrl}/auth/revoke`,
        { sessionId: claims.sid },
        { token, timeout: REVOKE_TIMEOUT_MS },
      )
      revoked = response.ok
    }
  } catch {
    revoked = false
  } finally {
    await localRemove([KEYS.session, KEYS.oauthState])
  }
  return { revoked }
}

export async function retry() {
  return refreshSession()
}
