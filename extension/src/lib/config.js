// OAuth callback host <extension-id>.chromiumapp.org must be in the gateway allowlist.
export const DEFAULT_CONFIG = Object.freeze({
  apiBaseUrl: 'https://api.jawbts.org',
  gatewayAuthorizeUrl: 'https://gateway.jawbts.org/authorize',
  embedApiUrl: 'https://embed.jawbts.org/v1/embed',
  scope: 'play_sequence_override',
  targetSimilarity: 75,
  historyLength: 400,
  penaltyStrength: 3,
  curve: 0.5,
  similarityCurve: 0.5,
  forceSkip: 1767,
  autoAdvance: true,
  softNavigation: true,
  devMode: false,
})

export const APP_NAME = 'Play Sequence Override'

function trimSlash(value) {
  return value.replace(/\/+$/, '')
}

export function normalizeBaseUrl(value, name) {
  let url
  try {
    url = new URL(String(value).trim())
  } catch {
    throw new Error(`${name} must be an absolute URL`)
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed only for localhost)`)
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`)
  return trimSlash(url.toString())
}

export function normalizeAuthorizeUrl(value) {
  const base = normalizeBaseUrl(value, 'gatewayAuthorizeUrl')
  return base.endsWith('/authorize') ? base : `${base}/authorize`
}

export function normalizeConfig(raw = {}) {
  const merged = { ...DEFAULT_CONFIG, ...raw }
  const target = Number(merged.targetSimilarity)
  if (!Number.isFinite(target) || target < 0 || target > 100) {
    throw new Error('targetSimilarity must be between 0 and 100')
  }
  const historyLength = Number(merged.historyLength)
  if (!Number.isFinite(historyLength) || historyLength < 10 || historyLength > 400) {
    throw new Error('historyLength must be between 10 and 400')
  }
  const penaltyStrength = Number(merged.penaltyStrength)
  if (!Number.isFinite(penaltyStrength) || penaltyStrength < 0 || penaltyStrength > 20) {
    throw new Error('penaltyStrength must be between 0 and 20')
  }
  const curve = Number(merged.curve)
  if (!Number.isFinite(curve) || curve < 0.25 || curve > 8) {
    throw new Error('curve must be between 0.25 and 8')
  }
  const similarityCurve = Number(merged.similarityCurve)
  if (!Number.isFinite(similarityCurve) || similarityCurve < 0.25 || similarityCurve > 8) {
    throw new Error('similarityCurve must be between 0.25 and 8')
  }
  const forceSkip = Number(merged.forceSkip)
  if (!Number.isFinite(forceSkip) || forceSkip < 0 || forceSkip > 1767) {
    throw new Error('forceSkip must be between 0 and 1767')
  }
  const config = {
    apiBaseUrl: normalizeBaseUrl(merged.apiBaseUrl, 'apiBaseUrl'),
    gatewayAuthorizeUrl: normalizeAuthorizeUrl(merged.gatewayAuthorizeUrl),
    embedApiUrl: normalizeBaseUrl(merged.embedApiUrl, 'embedApiUrl'),
    scope: String(merged.scope || DEFAULT_CONFIG.scope),
    targetSimilarity: Math.round(target),
    historyLength: Math.round(historyLength),
    penaltyStrength,
    curve,
    similarityCurve,
    forceSkip: Math.round(forceSkip),
    autoAdvance: Boolean(merged.autoAdvance),
    softNavigation: Boolean(merged.softNavigation),
    devMode: Boolean(merged.devMode),
  }
  if (config.devMode && !isLocalUrl(config.embedApiUrl)) {
    throw new Error('devMode only allows a localhost embedApiUrl')
  }
  return config
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLocalUrl(value) {
  try {
    return LOCAL_HOSTS.has(new URL(value).hostname)
  } catch {
    return false
  }
}

export function buildAuthorizeUrl(config, redirectUri, state) {
  const url = new URL(config.gatewayAuthorizeUrl)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', config.scope)
  url.searchParams.set('state', state)
  url.searchParams.set('response_mode', 'fragment')
  url.searchParams.set('app_name', APP_NAME)
  url.searchParams.set('label', 'Edge extension')
  return url.toString()
}

export function randomState() {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
