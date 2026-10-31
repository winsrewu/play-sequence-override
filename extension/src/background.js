// Service worker. The backend is stateless; config, session, catalog, history and vectors live in IndexedDB.
import { Recommender } from './lib/algorithm.js'
import {
  authStatus,
  connect as authConnect,
  disconnect as authDisconnect,
  extensionId,
  redirectUri,
} from './lib/auth.js'
import { normalizeConfig } from './lib/config.js'
import {
  DERIVED_VERSION,
  computeProjectionModel,
  computeStyleModel,
  projectPoint,
  shouldReuseDerived,
} from './lib/derived.js'
import { embedTrack } from './lib/embed-api.js'
import {
  cacheEmbedding,
  cacheEmbeddings,
  invalidateCachedEmbeddings,
  loadAllVectors,
  missingTrackIds,
} from './lib/embeddings.js'
import { parseEmbeddingText } from './lib/embedding-json.js'
import { FORMAT, VERSION, exportV2, parseAnyPlaylist, playlistSummary } from './lib/playlist.js'
import { forgetTab, isVideoTabUrl, ownerTab, ownerTabId, registerTab } from './lib/sequence.js'
import * as store from './lib/storage.js'
import { getConfig, setConfig } from './lib/storage.js'

const EXTENSION_PROTOCOL = 2

let catalogCache = null
let recommenderCache = null
let initialization = null
let projectionCache = null
let lastDecision = null
let styleCache = null
let lastAutoAdvance = null
let autoPrefetchPromise = null
let prefetchState = {
  running: false,
  waitingAuth: false,
  complete: false,
  done: 0,
  total: 0,
  remaining: 0,
  updatedAt: null,
}
const AUTO_PREFETCH_CHUNK = 20
const AUTO_PREFETCH_ALARM = 'jawbts-auto-prefetch'

function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message)?.catch?.(() => {})
  } catch {
  }
}

function errorPayload(error) {
  return {
    ok: false,
    error: {
      name: error?.name || 'Error',
      code: error?.code ?? null,
      message: error?.message || String(error),
    },
  }
}

function trackUrl(track) {
  const videoId = track.videoId || track.video_id
  const suffix = track.page > 1 ? `?p=${track.page}` : ''
  return `https://www.bilibili.com/video/${videoId}${suffix}`
}

function trackMeta(track) {
  if (!track) return null
  return {
    id: track.id,
    title: track.title,
    page: track.page,
    url: trackUrl(track),
  }
}

// --- Detected tabs ---------------------------------------------------------
// One video tab drives the sequence. The first detected tab keeps ownership
// until it closes; the survivors then re-run that decision in detection order.

let tabRegistry = null
let tabChain = Promise.resolve()

async function loadTabs() {
  if (!tabRegistry) tabRegistry = await store.getTabRegistry()
  return tabRegistry
}

function updateTabs(update) {
  const run = tabChain.then(async () => {
    const current = await loadTabs()
    const next = await update(current)
    if (next !== current) {
      tabRegistry = next
      await store.setTabRegistry(next).catch(() => {})
    }
    return next
  })
  tabChain = run.then(() => {}, () => {})
  return run
}

async function pruneTabs(tabs) {
  let next = tabs
  for (const key of Object.keys(tabs)) {
    const tabId = Number(key)
    try {
      const tab = await chrome.tabs.get(tabId)
      if (isVideoTabUrl(tab?.url)) continue
    } catch {
      // A tab that is gone cannot keep ownership.
    }
    next = forgetTab(next, tabId)
  }
  return next
}

async function ownerTabEntry() {
  const tabs = await updateTabs(pruneTabs)
  return ownerTab(tabs)
}

async function detectTab(tab, id) {
  if (!Number.isInteger(tab?.id) || !isVideoTabUrl(tab.url)) return null
  return updateTabs((tabs) =>
    registerTab(tabs, { tabId: tab.id, id, url: tab.url, title: tab.title, at: Date.now() }),
  )
}

// A tab the extension opens itself becomes the available one without waiting for a close.
async function adoptTab(tab, id) {
  if (!Number.isInteger(tab?.id)) return null
  return updateTabs((tabs) => {
    const earliest = Math.min(0, ...Object.values(tabs).map((entry) => entry.detectedAt ?? 0))
    return registerTab(tabs, {
      tabId: tab.id,
      id,
      url: tab.url,
      title: tab.title,
      at: earliest - 1,
    })
  })
}

// The non-elected tabs keep reporting, but they never drive playback or rewrite the current track.
async function isOwner(tabId) {
  const owner = await ownerTabEntry()
  return !owner || owner.tabId === tabId
}

async function forgetDetectedTab(tabId) {
  const before = ownerTabId(await loadTabs())
  const tabs = await updateTabs((current) => forgetTab(current, tabId))
  const owner = ownerTab(tabs)
  if ((owner?.tabId ?? null) === before) return
  if (owner?.id) await store.setCurrent(owner.id).catch(() => {})
  broadcast({ type: 'data-changed', kind: 'owner' })
}

async function ensureCatalog() {
  if (catalogCache) return catalogCache
  const stored = await store.getCatalog()
  if (stored && Array.isArray(stored.tracks)) {
    catalogCache = stored
    return stored
  }
  // Nothing is bundled: the catalog comes from an imported playlist only.
  catalogCache = { format: FORMAT, version: VERSION, tracks: [], empty: true }
  return catalogCache
}

async function initialize() {
  if (!initialization) {
    initialization = (async () => {
      await getConfig()
      return ensureCatalog()
    })().catch((error) => {
      initialization = null
      throw error
    })
  }
  return initialization
}

// Style clusters and the 2-D map are derived from the vectors and cached; the
// extension never reads a bundled data folder.
let derivedCache = null

async function getDerived() {
  if (derivedCache) return derivedCache
  const { vectors, dim } = await loadAllVectors()
  const stored = await store.getDerived()
  if (shouldReuseDerived(stored, vectors.size, dim)) {
    derivedCache = stored
    return stored
  }
  const record = {
    version: DERIVED_VERSION,
    dim,
    count: vectors.size,
    style: computeStyleModel(vectors),
    projection: computeProjectionModel(vectors),
    updatedAt: Date.now(),
  }
  derivedCache = record
  await store.setDerived(record).catch(() => {})
  return record
}

function styleFromDerived(style) {
  if (!style) return { labels: null, centroids: [] }
  return {
    labels: new Map(style.ids.map((id, index) => [id, style.labels[index]])),
    centroids: style.centroids,
  }
}

async function loadStyleData() {
  const source = await getDerived()
  if (styleCache?.source === source) return styleCache.value
  const value = styleFromDerived(source.style)
  styleCache = { source, value }
  return value
}

async function getRecommender(force = false) {
  if (recommenderCache && !force) return recommenderCache
  const catalog = await ensureCatalog()
  const [{ vectors, dim }, style] = await Promise.all([loadAllVectors(), loadStyleData()])
  const recommender = new Recommender({
    tracks: catalog.tracks,
    vectors,
    styleLabels: style.labels,
    styleCentroids: style.centroids,
  })
  recommenderCache = { recommender, vectors, dim }
  return recommenderCache
}

function tuningFromConfig(config) {
  return {
    historyLength: config.historyLength,
    penaltyStrength: config.penaltyStrength,
    curve: config.curve,
    simCurve: config.similarityCurve,
    forceSkip: config.forceSkip,
  }
}

function invalidateRecommender() {
  recommenderCache = null
  projectionCache = null
  styleCache = null
  derivedCache = null
}

function derivedProjection(projection) {
  if (!projection) return { byId: new Map(), project: () => ({ x: 0, y: 0 }) }
  const byId = new Map()
  for (let index = 0; index < projection.ids.length; index += 1) {
    byId.set(projection.ids[index], { x: projection.x[index], y: projection.y[index] })
  }
  return { byId, project: (vector) => projectPoint(projection, vector) }
}

async function loadProjection() {
  const source = await getDerived()
  if (projectionCache?.source === source) return projectionCache.value
  const value = derivedProjection(source.projection)
  projectionCache = { source, value }
  return value
}

async function projectionPoints(recommender) {
  const { byId, project } = await loadProjection()
  const points = []
  for (const id of recommender.ids) {
    const known = byId.get(id)
    if (known) {
      points.push({ id, x: known.x, y: known.y, approximate: false })
      continue
    }
    const index = recommender.indexById.get(id)
    const projected = project(recommender.vectors[index])
    points.push({ id, x: projected.x, y: projected.y, approximate: true })
  }
  return points
}

async function status() {
  await initialize()
  autoPrefetchMissing().catch(() => {})
  const [config, catalog, session, currentId, history, plays] = await Promise.all([
    getConfig(),
    ensureCatalog(),
    authStatus(),
    store.getCurrent(),
    store.getHistory(),
    store.getSessionPlays(),
  ])

  let embeddedCount = 0
  let missingCount = 0
  let vectorError = null
  try {
    const { recommender, vectors } = await getRecommender(true)
    embeddedCount = recommender.size
    missingCount = missingTrackIds(catalog.tracks, vectors).length
  } catch (error) {
    vectorError = error?.message || String(error)
    missingCount = catalog.tracks.length
  }

  const catalogCount = catalog.tracks.length
  const cachedCount = Math.max(0, catalogCount - missingCount)
  if (
    prefetchState.total !== catalogCount ||
    prefetchState.done < cachedCount ||
    (missingCount === 0 && !prefetchState.complete)
  ) {
    prefetchState = {
      ...prefetchState,
      total: catalogCount,
      done: missingCount === 0 ? catalogCount : cachedCount,
      remaining: missingCount,
      complete: missingCount === 0,
      waitingAuth: missingCount > 0 && !session.connected && !session.devMode,
      updatedAt: Date.now(),
    }
  }

  const byId = new Map(catalog.tracks.map((track) => [track.id, track]))
  const owner = await ownerTabEntry()
  return {
    ok: true,
    protocol: EXTENSION_PROTOCOL,
    catalogCount: catalog.tracks.length,
    catalogMissing: Boolean(catalog.empty),
    embeddedCount,
    missingCount,
    vectorError,
    current: trackMeta(byId.get(currentId)),
    history: history.slice(0, 10).map((id) => trackMeta(byId.get(id))).filter(Boolean),
    targetSimilarity: config.targetSimilarity,
    autoAdvance: config.autoAdvance,
    softNavigation: config.softNavigation,
    session,
    config,
    redirectUri: redirectUri(),
    extensionId: extensionId(),
    gatewayAllowlistHost: new URL(redirectUri()).hostname,
    summary: playlistSummary(catalog),
    sessionPlays: plays,
    prefetch: prefetchState,
    owner: owner
      ? { tabId: owner.tabId, id: owner.id, title: owner.title, url: owner.url }
      : null,
  }
}

async function recordStarted(id, meta = {}) {
  await initialize()
  const catalog = await ensureCatalog()
  const track = catalog.tracks.find((entry) => entry.id === id)
  const previous = await store.getCurrent()
  await store.setCurrent(id)

  if (!track) {
    return { ok: true, known: false, id }
  }
  if (previous === id) {
    return { ok: true, known: true, duplicate: true, track: trackMeta(track) }
  }

  const history = await store.getHistory()
  const filtered = history.filter((entry) => entry !== id)
  filtered.unshift(id)
  await store.setHistory(filtered)

  const plays = await store.getSessionPlays()
  plays[id] = (plays[id] || 0) + 1
  await store.setSessionPlays(plays)
  broadcast({ type: 'data-changed', kind: 'state' })

  return { ok: true, known: true, track: trackMeta(track), title: meta.title || track.title }
}

const biliViewCache = new Map()

async function resolveBiliView(track) {
  const bvid = track.videoId || track.video_id
  const page = Number(track.page) || 1
  if (!bvid) return null
  let view = biliViewCache.get(bvid)
  if (!view) {
    const response = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      { cache: 'no-store', credentials: 'include' },
    )
    if (!response.ok) return null
    const envelope = await response.json()
    if (Number(envelope?.code) !== 0 || !envelope?.data) return null
    view = envelope.data
    biliViewCache.set(bvid, view)
  }
  const pages = Array.isArray(view.pages) ? view.pages : []
  const selected = pages.find((entry) => Number(entry.page) === page) || pages[0]
  if (!selected) return null
  return {
    aid: Number(view.aid),
    cid: Number(selected.cid),
    bvid,
    page: Number(selected.page) || 1,
  }
}

async function softNavigate(tabId, track) {
  if (!chrome.scripting) return false
  const target = await resolveBiliView(track)
  if (!target) return false
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [target],
      func: async ({ aid, cid, bvid, page }) => {
        try {
          const links = [...document.querySelectorAll('a[href*="/video/BV"]')]
          let host = null
          for (const link of links) {
            const parent = link.__vue__?.$parent
            if (parent?.$options?.methods?.pathTo && parent.item) {
              host = parent
              break
            }
          }
          if (!host) return false

          const item = {
            aid,
            cid,
            bvid,
            page,
            redirect_url: '',
            duration: 0,
            pic: '',
            title: '',
            owner: {},
            stat: {},
            ai_rcmd: { trackid: '' },
            index: 0,
          }
          host.item = item

          const componentProto = Object.getPrototypeOf(host)
          const vueProto = Object.getPrototypeOf(componentProto)
          const originalEmit = vueProto?.$emit
          let patched = false
          if (typeof originalEmit === 'function') {
            vueProto.$emit = function (event, payload, ...rest) {
              if (event === 'RELOAD_VIDEO' && payload && typeof payload === 'object') {
                payload.p = page
                payload.cid = cid
                payload.aid = aid
                payload.bvid = bvid
              }
              return originalEmit.call(this, event, payload, ...rest)
            }
            patched = true
          }
          try {
            host.pathTo()
          } finally {
            if (patched) vueProto.$emit = originalEmit
          }

          const targetPath = `/video/${bvid}`
          for (let attempt = 0; attempt < 32; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250))
            const onTarget =
              location.pathname.includes(targetPath) &&
              (Number(new URLSearchParams(location.search).get('p') || 1) === page)
            const video = [...document.querySelectorAll('video')].find((candidate) => {
              const rect = candidate.getBoundingClientRect()
              return rect.width >= 240 && rect.height >= 120
            })
            if (onTarget) {
              if (video && !video.paused) return true
              if (video && attempt >= 8) return true
            }
          }
          return location.pathname.includes(targetPath)
        } catch {
          return false
        }
      },
    })
    return Boolean(result?.result)
  } catch {
    return false
  }
}

async function navigate(tabId, track, soft) {
  const url = trackUrl(track)
  if (tabId != null) {
    if (soft) {
      if (await softNavigate(tabId, track)) return
    }
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'navigate', url, soft })
      return
    } catch {
      await chrome.tabs.update(tabId, { url })
      return
    }
  }

  let candidates = []
  try {
    candidates = await chrome.tabs.query({ url: 'https://www.bilibili.com/*' })
  } catch {
    candidates = []
  }
  const active = candidates.find((tab) => tab.active) || candidates[0]
  if (active?.id) {
    await navigate(active.id, track, soft)
    return
  }

  const [current] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (current?.id && current.url?.startsWith('https://www.bilibili.com/')) {
    await navigate(current.id, track, soft)
    return
  }
  await adoptTab(await chrome.tabs.create({ url }), track.id)
}

async function selectNext({
  tabId = null,
  currentId = null,
  targetSimilarity = null,
  tuningOverride = null,
  newTab = false,
} = {}) {
  await initialize()
  const [config, catalog] = await Promise.all([getConfig(), ensureCatalog()])
  const { recommender } = await getRecommender()

  const current = currentId || (await store.getCurrent())
  if (!current) {
    throw new Error('No track detected; refusing to advance.')
  }
  if (!recommender.has(current)) {
    throw new Error('The current track has no embedding; refusing to advance.')
  }

  const [history, plays] = await Promise.all([store.getHistory(), store.getSessionPlays()])
  const requestedTarget = Number(targetSimilarity)
  const target = Number.isFinite(requestedTarget)
    ? Math.min(100, Math.max(0, requestedTarget)) / 100
    : config.targetSimilarity / 100
  const tuning = tuningOverride || tuningFromConfig(config)
  const decision = recommender.selectNextDetailed(
    current,
    history,
    target,
    Math.random,
    plays,
    tuning,
  )
  const nextId = decision.id
  if (nextId === current) {
    lastDecision = {
      protocol: EXTENSION_PROTOCOL,
      timestamp: new Date().toISOString(),
      request: {
        current,
        currentTrack: trackMeta(catalog.tracks.find((entry) => entry.id === current)),
        targetPercent: target * 100,
        history,
        sessionPlays: plays,
        tuning: decision.tuning || tuning,
      },
      result: { nextId, emptyPool: true },
      algorithm: decision,
    }
    console.info('[jawbts] next-track decision', lastDecision)
    await store.setLastDecision(lastDecision).catch(() => {})
    throw new Error('No eligible next track; the candidate pool is empty.')
  }

  const track = catalog.tracks.find((entry) => entry.id === nextId)
  if (!track) throw new Error(`Next track ${nextId} disappeared from the playlist.`)

  lastDecision = {
    protocol: EXTENSION_PROTOCOL,
    timestamp: new Date().toISOString(),
    request: {
      current,
      currentTrack: trackMeta(catalog.tracks.find((entry) => entry.id === current)),
      targetPercent: target * 100,
      history,
      sessionPlays: plays,
      tuning: decision.tuning || tuning,
    },
    result: {
      nextId,
      currentTrack: trackMeta(catalog.tracks.find((entry) => entry.id === current)),
      nextTrack: trackMeta(track),
    },
    algorithm: decision,
  }
  console.info('[jawbts] next-track decision', lastDecision)
  await store.setLastDecision(lastDecision).catch(() => {})

  if (newTab) await adoptTab(await chrome.tabs.create({ url: trackUrl(track) }), track.id)
  else await navigate(tabId, track, config.softNavigation)
  return {
    ok: true,
    current: trackMeta(catalog.tracks.find((entry) => entry.id === current)),
    next: trackMeta(track),
  }
}

// The page cannot host the sequence, so keep it untouched and open the next track in a new tab.
async function launch({ targetSimilarity = null } = {}) {
  await initialize()
  const current = await store.getCurrent()
  if (current) {
    const { recommender } = await getRecommender()
    if (recommender.has(current)) {
      try {
        return await selectNext({ targetSimilarity, newTab: true })
      } catch {
        // An empty candidate pool still gets a tab, seeded from the playlist's first track.
      }
    }
  }
  const catalog = await ensureCatalog()
  const track = catalog.tracks[0]
  if (!track) throw new Error('The playlist is empty; nothing to launch.')
  await adoptTab(await chrome.tabs.create({ url: trackUrl(track) }), track.id)
  return { ok: true, next: trackMeta(track) }
}

async function autoPrefetchMissing() {
  if (autoPrefetchPromise) return autoPrefetchPromise
  autoPrefetchPromise = (async () => {
    await initialize()
    const [catalog, { vectors }] = await Promise.all([ensureCatalog(), getRecommender(true)])
    const missing = missingTrackIds(catalog.tracks, vectors)
    const total = new Set(catalog.tracks.map((track) => track.id)).size
    const cached = Math.max(0, total - missing.length)

    // Nothing to fetch (and no catalog yet): stay quiet instead of reporting a
    // completed prefetch on every status call.
    if (total === 0) {
      prefetchState = {
        running: false,
        waitingAuth: false,
        complete: true,
        done: 0,
        total: 0,
        remaining: 0,
        updatedAt: Date.now(),
      }
      await store.clearPrefetchJob().catch(() => {})
      try {
        chrome.alarms?.clear(AUTO_PREFETCH_ALARM)
      } catch {
      }
      return { done: 0, total: 0 }
    }

    if (missing.length === 0) {
      prefetchState = {
        running: false,
        waitingAuth: false,
        complete: true,
        done: total,
        total,
        remaining: 0,
        updatedAt: Date.now(),
      }
      await store.clearPrefetchJob()
      try {
        chrome.alarms?.clear(AUTO_PREFETCH_ALARM)
      } catch {
      }
      broadcast({ type: 'prefetch-progress', automatic: true, complete: true, done: total, total })
      return { done: total, total }
    }

    const auth = await authStatus()
    if (!auth.devMode && !auth.connected) {
      prefetchState = {
        running: false,
        waitingAuth: true,
        complete: false,
        done: cached,
        total,
        remaining: missing.length,
        updatedAt: Date.now(),
      }
      broadcast({
        type: 'prefetch-progress',
        automatic: true,
        waitingAuth: true,
        done: cached,
        total,
        remaining: missing.length,
      })
      return { waitingAuth: true, done: cached, total }
    }

    let job = await store.getPrefetchJob()
    if (!job || job.total !== total) {
      job = { total, done: cached, failed: 0, startedAt: Date.now() }
    } else {
      job.total = total
      job.done = cached
    }
    prefetchState = {
      running: true,
      waitingAuth: false,
      complete: false,
      done: cached,
      total,
      remaining: missing.length,
      updatedAt: Date.now(),
    }
    const pending = new Set(missing)
    const failedIds = new Set()
    let processed = 0
    const failures = []
    while (processed < AUTO_PREFETCH_CHUNK && pending.size > 0) {
      const id = pending.values().next().value
      pending.delete(id)
      processed += 1
      broadcast({
        type: 'prefetch-progress',
        automatic: true,
        id,
        done: job.done,
        total,
        remaining: pending.size + failedIds.size,
      })
      try {
        const { vector } = await embedTrack(id)
        await cacheEmbedding(id, vector)
        job.done = Math.min(total, job.done + 1)
      } catch (error) {
        if (error?.code === 'token_expired' || error?.name === 'AuthError') {
          await store.setPrefetchJob({ ...job, updatedAt: Date.now() })
          prefetchState = {
            running: false,
            waitingAuth: true,
            complete: false,
            done: job.done,
            total,
            remaining: pending.size + failedIds.size,
            updatedAt: Date.now(),
          }
          broadcast({
            type: 'prefetch-progress',
            automatic: true,
            waitingAuth: true,
            done: job.done,
            total,
            remaining: pending.size + failedIds.size,
          })
          return { waitingAuth: true, done: job.done, total }
        }
        job.failed += 1
        failedIds.add(id)
        failures.push({ id, message: error?.message || String(error) })
      }
      job.updatedAt = Date.now()
      prefetchState = {
        running: true,
        waitingAuth: false,
        complete: false,
        done: job.done,
        total,
        remaining: pending.size + failedIds.size,
        updatedAt: Date.now(),
      }
      await store.setPrefetchJob(job)
      broadcast({
        type: 'prefetch-progress',
        automatic: true,
        id,
        done: job.done,
        total,
        remaining: pending.size + failedIds.size,
      })
    }
    const remaining = new Set([...pending, ...failedIds])
    const completed = remaining.size === 0
    prefetchState = {
      running: false,
      waitingAuth: false,
      complete: completed,
      done: job.done,
      total,
      remaining: remaining.size,
      updatedAt: Date.now(),
    }

    invalidateCachedEmbeddings()
    invalidateRecommender()
    if (completed) {
      await store.clearPrefetchJob()
      try {
        chrome.alarms?.clear(AUTO_PREFETCH_ALARM)
      } catch {
      }
    } else {
      try {
        chrome.alarms?.create(AUTO_PREFETCH_ALARM, { delayInMinutes: 0.5 })
      } catch {
      }
    }
    broadcast({ type: 'data-changed', kind: 'embeddings' })
    broadcast({
      type: 'prefetch-progress',
      automatic: true,
      complete: completed,
      done: job.done,
      total,
      remaining: remaining.size,
    })
    return {
      done: job.done,
      total,
      failed: job.failed,
      remaining: remaining.size,
      failures,
    }
  })().catch((error) => {
    console.error('automatic prefetch failed', error)
    prefetchState = {
      ...prefetchState,
      running: false,
      complete: false,
      updatedAt: Date.now(),
    }
    try {
      chrome.alarms?.create(AUTO_PREFETCH_ALARM, { delayInMinutes: 0.5 })
    } catch {
    }
    return { retry: true, error: error?.message || String(error) }
  })
  const current = autoPrefetchPromise
  current.finally(() => {
    if (autoPrefetchPromise === current) autoPrefetchPromise = null
  })
  return current
}

async function prefetch(onProgress) {
  await initialize()
  if (autoPrefetchPromise) {
    await autoPrefetchPromise.catch(() => {})
  }
  const [catalog, { vectors }] = await Promise.all([ensureCatalog(), getRecommender(true)])
  const missing = missingTrackIds(catalog.tracks, vectors)
  const total = new Set(catalog.tracks.map((track) => track.id)).size
  let done = Math.max(0, total - missing.length)
  let failed = 0
  const failures = []

  for (const id of missing) {
    onProgress?.({ id, done, total, failed })
    try {
      const { vector } = await embedTrack(id)
      await cacheEmbedding(id, vector)
      done += 1
    } catch (error) {
      if (error?.code === 'token_expired' || error?.name === 'AuthError') throw error
      failed += 1
      failures.push({ id, message: error?.message || String(error) })
    }
    onProgress?.({ id, done, total, failed })
  }

  invalidateCachedEmbeddings()
  invalidateRecommender()
  await getRecommender(true)
  broadcast({ type: 'data-changed', kind: 'embeddings' })
  return { ok: true, total, done, failed, failures }
}

async function importPlaylist(text) {
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`The selected file is not valid JSON: ${error.message}`)
  }
  const playlist = parseAnyPlaylist(document)
  await store.setCatalog(playlist)
  catalogCache = playlist
  invalidateRecommender()

  const ids = new Set(playlist.tracks.map((track) => track.id))
  const history = await store.getHistory()
  await store.setHistory(history.filter((id) => ids.has(id)))
  const current = await store.getCurrent()
  if (current && !ids.has(current)) await store.setCurrent(null)
  broadcast({ type: 'data-changed', kind: 'playlist' })
  autoPrefetchMissing().catch(() => {})
  return { ok: true, ...playlistSummary(playlist) }
}

async function exportPlaylist() {
  const catalog = await ensureCatalog()
  return {
    ok: true,
    format: 'v2',
    filename: 'music.v2.json',
    json: JSON.stringify(exportV2(catalog), null, 2),
  }
}

async function saveConfig(patch) {
  const current = await getConfig()
  const next = normalizeConfig({ ...current, ...patch })
  await setConfig(next)
  return { ok: true, config: next }
}

async function graphData(targetSimilarity = null, tuningOverride = null) {
  await initialize()
  const [config, currentId, history, plays] = await Promise.all([
    getConfig(),
    store.getCurrent(),
    store.getHistory(),
    store.getSessionPlays(),
  ])
  const { recommender } = await getRecommender()
  const tuning = tuningOverride || tuningFromConfig(config)
  let points = []
  try {
    points = await projectionPoints(recommender)
  } catch (error) {
    console.error('projection failed', error)
  }
  const requested = Number(targetSimilarity)
  const targetPercent = Number.isFinite(requested)
    ? Math.min(100, Math.max(0, requested))
    : config.targetSimilarity
  const target = targetPercent / 100
  if (!currentId || !recommender.has(currentId)) {
    return {
      ok: true,
      current: null,
      target: targetPercent,
      tuning,
      probabilities: {},
      max: 0,
      raw: {},
      points,
    }
  }
  const { probabilities, maxProbability } = recommender.probabilities(
    currentId,
    history,
    target,
    plays,
    tuning,
  )
  return {
    ok: true,
    current: currentId,
    target: targetPercent,
    tuning,
    probabilities: Object.fromEntries(probabilities),
    max: maxProbability,
    raw: Object.fromEntries(recommender.rawSimilarities(currentId)),
    points,
  }
}

async function playTrack(id, tabId = null) {
  await initialize()
  const [config, catalog] = await Promise.all([getConfig(), ensureCatalog()])
  const track = catalog.tracks.find((entry) => entry.id === id)
  if (!track) throw new Error(`Track ${id} is not in the playlist.`)
  await navigate(tabId, track, config.softNavigation)
  return { ok: true, track: trackMeta(track) }
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'status':
      return status()
    case 'connect':
      await authConnect()
      autoPrefetchMissing().catch(() => {})
      return status()
    case 'disconnect':
      await authDisconnect()
      return status()
    case 'next': {
      const senderTab = sender?.tab
      const biliTabId = senderTab?.url?.startsWith('https://www.bilibili.com/')
        ? senderTab.id
        : null
      const owner = await ownerTabEntry()
      const tabId = message.tabId ?? biliTabId ?? owner?.tabId ?? null
      if (owner && tabId != null && tabId !== owner.tabId) {
        throw new Error('Another tab owns the play sequence.')
      }
      return selectNext({
        tabId,
        targetSimilarity: message.targetSimilarity,
        tuningOverride: message.tuning || null,
      })
    }
    case 'launch':
      return launch({ targetSimilarity: message.targetSimilarity })
    case 'graph-data':
      return graphData(message.targetSimilarity, message.tuning || null)
    case 'decision-log':
      if (!lastDecision) lastDecision = await store.getLastDecision()
      return { ok: true, log: lastDecision }
    case 'ensure-prefetch':
      autoPrefetchMissing().catch(() => {})
      return { ok: true, prefetch: prefetchState }
    case 'soft-nav-finished': {
      const tabId = sender?.tab?.id
      if (!Number.isInteger(tabId)) return { ok: false, error: 'no tab' }
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: async () => {
            for (let i = 0; i < 20; i += 1) {
              if (window.player?.play) {
                try {
                  window.player.play()
                  window.player.requestAutoplay?.(true)
                  return true
                } catch {
                }
              }
              await new Promise((resolve) => setTimeout(resolve, 250))
            }
            return false
          },
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error?.message || String(error) }
      }
    }
    case 'ensure-content': {
      const tabId = Number(message.tabId)
      if (!Number.isInteger(tabId) || tabId <= 0) return { ok: false, error: 'invalid tab' }
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/disable-bili-auto-next.js', 'src/content.js'],
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error?.message || String(error) }
      }
    }
    case 'prefetch-state':
      return { ok: true, prefetch: prefetchState }
    case 'clear-decision-log':
      lastDecision = null
      await store.clearLastDecision()
      return { ok: true }
    case 'play-id': {
      const owner = await ownerTabEntry()
      return playTrack(message.id, message.tabId ?? owner?.tabId ?? null)
    }
    case 'track-started': {
      const tab = sender?.tab
      await detectTab(tab, message.id)
      if (!(await isOwner(tab?.id))) {
        return { ok: true, owner: false, id: message.id }
      }
      return recordStarted(message.id, message)
    }
    case 'track-ended': {
      if (!(await getConfig()).autoAdvance) return { ok: true, skipped: true }
      if (!(await isOwner(sender?.tab?.id))) return { ok: true, skipped: 'not-owner' }
      const duration = Number(message.duration)
      const position = Number(message.position)
      if (!message.ended && !message.loopOverride && Number.isFinite(duration) && duration > 0) {
        if (!Number.isFinite(position) || position < duration - 2) {
          return { ok: true, skipped: 'not-at-end' }
        }
      }
      const endedId = message.id || null
      const now = Date.now()
      if (
        endedId &&
        lastAutoAdvance?.id === endedId &&
        now - lastAutoAdvance.at < 5000
      ) {
        return { ok: true, skipped: 'duplicate-ended' }
      }
      if (endedId) lastAutoAdvance = { id: endedId, at: now }
      return selectNext({ tabId: sender?.tab?.id ?? null, currentId: endedId })
    }
    case 'import':
      return importPlaylist(message.text)
    case 'import-embeddings': {
      const [vectors, catalog] = await Promise.all([
        Promise.resolve(parseEmbeddingText(message.text)),
        ensureCatalog(),
      ])
      const ids = new Set(catalog.tracks.map((track) => track.id))
      const accepted = new Map()
      let ignored = 0
      for (const [id, vector] of vectors) {
        if (ids.has(id)) accepted.set(id, vector)
        else ignored += 1
      }
      const count = await cacheEmbeddings(accepted)
      if (count > 0) {
        invalidateCachedEmbeddings()
        invalidateRecommender()
        broadcast({ type: 'data-changed', kind: 'embeddings' })
        autoPrefetchMissing().catch(() => {})
      }
      return { ok: true, count, ignored }
    }
    case 'export':
      return exportPlaylist()
    case 'prefetch': {
      const { ok, ...result } = await prefetch((progress) => {
        chrome.runtime.sendMessage({ type: 'prefetch-progress', ...progress }).catch(() => {})
      })
      return { ok, ...result }
    }
    case 'save-config':
      return saveConfig(message.config || {})
    case 'set-target':
      return saveConfig({ targetSimilarity: Number(message.value) })
    case 'save-tuning': {
      const tuning = message.tuning || {}
      return saveConfig({
        historyLength: Number(tuning.historyLength),
        penaltyStrength: Number(tuning.penaltyStrength),
        curve: Number(tuning.curve),
        similarityCurve: Number(tuning.simCurve ?? tuning.similarityCurve),
        forceSkip: Number(tuning.forceSkip),
      })
    }
    case 'set-auto':
      return saveConfig({ autoAdvance: Boolean(message.value) })
    case 'clear-history':
      await store.setHistory([])
      await store.resetSessionPlays()
      await store.setCurrent(null)
      return { ok: true }
    case 'reset-vectors':
      await store.clearVectorCache()
      autoPrefetchPromise = null
      invalidateCachedEmbeddings()
      invalidateRecommender()
      broadcast({ type: 'data-changed', kind: 'embeddings' })
      return status()
    case 'meta':
      return {
        ok: true,
        extensionId: extensionId(),
        redirectUri: redirectUri(),
        gatewayAllowlistHost: new URL(redirectUri()).hostname,
      }
    default:
      return { ok: false, error: { name: 'UnknownMessage', message: `Unknown message ${message?.type}` } }
  }
}

// Closing the elected tab, or navigating it off video pages, re-runs the decision.
if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    forgetDetectedTab(tabId).catch(() => {})
  })
}

if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo?.url || isVideoTabUrl(changeInfo.url)) return
    forgetDetectedTab(tabId).catch(() => {})
  })
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse(errorPayload(error)))
  return true
})

chrome.runtime.onInstalled.addListener(() => {
  initialize()
    .then(() => autoPrefetchMissing())
    .catch((error) => console.error('initialization failed', error))
})

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === AUTO_PREFETCH_ALARM) {
      autoPrefetchPromise = null
      autoPrefetchMissing().catch((error) => console.error('alarm prefetch failed', error))
    }
  })
}

chrome.runtime.onStartup.addListener(() => {
  // Tab ids are not stable across browser restarts, so the election starts fresh.
  updateTabs(() => ({})).catch(() => {})
  initialize()
    .then(() => store.resetSessionPlays())
    .then(() => autoPrefetchMissing())
    .catch((error) => console.error('initialization failed', error))
})
