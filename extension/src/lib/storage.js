import {
  kvDelete,
  kvGet,
  kvSet,
  vectorDeleteAll,
  vectorGetAll,
  vectorSetMany,
} from './db.js'
import { DEFAULT_CONFIG, normalizeConfig } from './config.js'

export const KEYS = Object.freeze({
  config: 'config',
  session: 'session',
  catalog: 'catalog',
  history: 'history',
  current: 'current',
  sessionPlays: 'sessionPlays',
  oauthState: 'oauthState',
  lastDecision: 'lastDecision',
  embeddingSeed: 'embeddingSeed',
  prefetchJob: 'prefetchJob',
  tabRegistry: 'tabRegistry',
  migrated: 'migrated_v2',
})

const LEGACY_KEYS = [
  KEYS.config,
  KEYS.session,
  KEYS.catalog,
  KEYS.history,
  KEYS.current,
  KEYS.sessionPlays,
  KEYS.oauthState,
]
const LEGACY_VECTOR_PREFIX = 'emb:'

let migrationPromise = null

function decodeLegacyVector(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const copy = bytes.slice()
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)
}

async function ensureMigrated() {
  if (migrationPromise) return migrationPromise
  migrationPromise = (async () => {
    if (await kvGet(KEYS.migrated, false)) return
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      await kvSet(KEYS.migrated, true)
      return
    }
    let legacy = {}
    try {
      legacy = (await chrome.storage.local.get(null)) || {}
    } catch {
      legacy = {}
    }
    const consumed = []
    const vectors = new Map()
    for (const [key, value] of Object.entries(legacy)) {
      if (key.startsWith(LEGACY_VECTOR_PREFIX) && typeof value === 'string') {
        try {
          vectors.set(key.slice(LEGACY_VECTOR_PREFIX.length), decodeLegacyVector(value))
          consumed.push(key)
        } catch {
        }
      } else if (LEGACY_KEYS.includes(key)) {
        await kvSet(key, value)
        consumed.push(key)
      }
    }
    if (vectors.size > 0) await vectorSetMany(vectors)
    if (consumed.length > 0) {
      try {
        await chrome.storage.local.remove(consumed)
      } catch {
      }
    }
    await kvSet(KEYS.migrated, true)
  })().catch((error) => {
    migrationPromise = null
    throw error
  })
  return migrationPromise
}

export async function localGet(keys) {
  await ensureMigrated()
  if (typeof keys === 'string') return { [keys]: await kvGet(keys) }
  if (Array.isArray(keys)) {
    const result = {}
    for (const key of keys) result[key] = await kvGet(key)
    return result
  }
  throw new Error('localGet only supports a string or an array of keys')
}

export async function localSet(values) {
  for (const [key, value] of Object.entries(values)) await kvSet(key, value)
}

export async function localRemove(keys) {
  for (const key of keys) await kvDelete(key)
}

export async function getConfig() {
  await ensureMigrated()
  const stored = await kvGet(KEYS.config, null)
  try {
    return normalizeConfig({ ...DEFAULT_CONFIG, ...(stored || {}) })
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export async function setConfig(config) {
  const normalized = normalizeConfig(config)
  await kvSet(KEYS.config, normalized)
  return normalized
}

export async function getSession() {
  await ensureMigrated()
  return (await kvGet(KEYS.session, null)) || null
}

export async function setSession(session) {
  await kvSet(KEYS.session, session)
}

export async function clearSession() {
  await kvDelete(KEYS.session)
  await kvDelete(KEYS.oauthState)
}

export async function getCatalog() {
  await ensureMigrated()
  return (await kvGet(KEYS.catalog, null)) || null
}

export async function setCatalog(catalog) {
  await kvSet(KEYS.catalog, catalog)
}

export async function getHistory() {
  await ensureMigrated()
  const history = await kvGet(KEYS.history, [])
  return Array.isArray(history) ? history : []
}

export async function setHistory(history) {
  await kvSet(KEYS.history, history.slice(0, 1767))
}

export async function getCurrent() {
  await ensureMigrated()
  const current = await kvGet(KEYS.current, null)
  return typeof current === 'string' ? current : null
}

export async function setCurrent(current) {
  await kvSet(KEYS.current, current)
}

export async function getSessionPlays() {
  await ensureMigrated()
  const plays = await kvGet(KEYS.sessionPlays, {})
  return plays && typeof plays === 'object' ? plays : {}
}

export async function setSessionPlays(plays) {
  await kvSet(KEYS.sessionPlays, plays)
}

export async function getLastDecision() {
  await ensureMigrated()
  return (await kvGet(KEYS.lastDecision, null)) || null
}

export async function setLastDecision(log) {
  await kvSet(KEYS.lastDecision, log)
}

export async function clearLastDecision() {
  await kvDelete(KEYS.lastDecision)
}

export async function getEmbeddingSeed() {
  await ensureMigrated()
  return (await kvGet(KEYS.embeddingSeed, null)) || null
}

export async function setEmbeddingSeed(seed) {
  await kvSet(KEYS.embeddingSeed, seed)
}

export async function clearEmbeddingSeed() {
  await kvDelete(KEYS.embeddingSeed)
}

export async function getPrefetchJob() {
  await ensureMigrated()
  return (await kvGet(KEYS.prefetchJob, null)) || null
}

export async function setPrefetchJob(job) {
  await kvSet(KEYS.prefetchJob, job)
}

export async function clearPrefetchJob() {
  await kvDelete(KEYS.prefetchJob)
}

// Detected video tabs survive service-worker restarts; stale shapes are dropped on read.
export async function getTabRegistry() {
  await ensureMigrated()
  const stored = await kvGet(KEYS.tabRegistry, null)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  const tabs = {}
  for (const [key, entry] of Object.entries(stored)) {
    const tabId = Number(key)
    if (!Number.isInteger(tabId) || tabId <= 0) continue
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.id !== 'string' || !entry.id) continue
    if (!Number.isFinite(entry.detectedAt)) continue
    tabs[tabId] = {
      tabId,
      id: entry.id,
      url: typeof entry.url === 'string' ? entry.url : null,
      title: typeof entry.title === 'string' ? entry.title : null,
      detectedAt: entry.detectedAt,
    }
  }
  return tabs
}

export async function setTabRegistry(tabs) {
  await kvSet(KEYS.tabRegistry, tabs)
}

export async function resetSessionPlays() {
  await kvDelete(KEYS.sessionPlays)
}

export async function getVectorCache() {
  await ensureMigrated()
  return vectorGetAll()
}

export async function setVectorCacheEntry(id, vector) {
  await ensureMigrated()
  await vectorSetMany(new Map([[id, vector]]))
}

export async function setVectorCacheEntries(vectors) {
  await ensureMigrated()
  return vectorSetMany(vectors)
}

export async function clearVectorCache() {
  await vectorDeleteAll()
}
