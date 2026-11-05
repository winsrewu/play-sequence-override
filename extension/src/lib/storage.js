import {
  kvDelete,
  vectorDelete,
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
  staged: 'staged',
  removed: 'removed',
  history: 'history',
  current: 'current',
  sessionPlays: 'sessionPlays',
  oauthState: 'oauthState',
  lastDecision: 'lastDecision',
  prefetchJob: 'prefetchJob',
  tabRegistry: 'tabRegistry',
  derived: 'derived',
  consent: 'consent',
  unavailable: 'unavailable',
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

function trackRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

export async function getStagedTracks() {
  await ensureMigrated()
  const stored = await kvGet(KEYS.staged, {})
  const tracks = new Map()
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return tracks
  for (const [id, track] of Object.entries(stored)) {
    const record = trackRecord(track)
    if (record) tracks.set(id, record)
  }
  return tracks
}

export async function setStagedTracks(tracks) {
  const record = {}
  for (const [id, track] of tracks) record[id] = track
  await kvSet(KEYS.staged, record)
}

export async function getRemovedTracks() {
  await ensureMigrated()
  const stored = await kvGet(KEYS.removed, {})
  const removed = new Map()
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return removed
  for (const [id, entry] of Object.entries(stored)) {
    if (!entry || typeof entry !== 'object') continue
    const track = trackRecord(entry.track)
    if (!track) continue
    removed.set(id, { track, at: typeof entry.at === 'string' ? entry.at : null })
  }
  return removed
}

export async function setRemovedTracks(removed) {
  const record = {}
  for (const [id, entry] of removed) {
    record[id] = { track: entry.track, at: entry.at ?? new Date().toISOString() }
  }
  await kvSet(KEYS.removed, record)
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

// Tracks the service reported as unavailable (deleted/private videos). These
// are kept locally so automatic fetching does not retry them for a day.
export async function getUnavailableVectors() {
  await ensureMigrated()
  const stored = await kvGet(KEYS.unavailable, {})
  const result = {}
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return result
  for (const [id, entry] of Object.entries(stored)) {
    if (!entry || typeof entry !== 'object') continue
    result[id] = {
      code: typeof entry.code === 'string' ? entry.code : 'unavailable',
      message: typeof entry.message === 'string' ? entry.message : '',
      title: typeof entry.title === 'string' ? entry.title : '',
      at: Number(entry.at) || 0,
    }
  }
  return result
}

export async function setUnavailableVectors(entries) {
  await kvSet(KEYS.unavailable, entries)
}

export async function markVectorUnavailable(id, { code, message, title }) {
  const entries = await getUnavailableVectors()
  entries[id] = {
    code: code || 'unavailable',
    message: message || '',
    title: title || '',
    at: Date.now(),
  }
  await setUnavailableVectors(entries)
}

export async function clearVectorUnavailableMany(ids) {
  const entries = await getUnavailableVectors()
  let changed = false
  for (const id of ids) {
    if (id in entries) {
      delete entries[id]
      changed = true
    }
  }
  if (changed) await setUnavailableVectors(entries)
}

export async function clearVectorUnavailable(id) {
  const entries = await getUnavailableVectors()
  if (!(id in entries)) return
  delete entries[id]
  await setUnavailableVectors(entries)
}

// Consent to send request data to remote (non-local) services.
export async function getConsent() {
  await ensureMigrated()
  const stored = await kvGet(KEYS.consent, null)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null
  return {
    granted: Boolean(stored.granted),
    at: typeof stored.at === 'string' ? stored.at : null,
    origins: Array.isArray(stored.origins)
      ? stored.origins.filter((value) => typeof value === 'string')
      : [],
  }
}

export async function setConsent(consent) {
  await kvSet(KEYS.consent, consent)
}

export async function clearConsent() {
  await kvDelete(KEYS.consent)
}

// Style clusters and projection derived from the vectors and cached.
export async function getDerived() {
  await ensureMigrated()
  const stored = await kvGet(KEYS.derived, null)
  return stored && typeof stored === 'object' ? stored : null
}

export async function setDerived(record) {
  await kvSet(KEYS.derived, record)
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

export async function deleteVectorCacheEntries(ids) {
  return vectorDelete(ids)
}

export async function clearVectorCache() {
  await vectorDeleteAll()
}
