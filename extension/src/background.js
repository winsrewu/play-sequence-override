// Service worker. The backend is stateless; config, session, catalog, history and vectors live in IndexedDB.
import { Recommender } from './lib/algorithm.js'
import {
  authStatus,
  connect as authConnect,
  disconnect as authDisconnect,
  extensionId,
  redirectUri,
} from './lib/auth.js'
import { consentCovers, normalizeConfig, remoteOrigins } from './lib/config.js'
import {
  DERIVED_VERSION,
  computeProjectionModel,
  computeStyleModel,
  projectPoint,
  shouldReuseDerived,
} from './lib/derived.js'
import {
  LANE_INSTRUMENTAL,
  LANE_LYRICS,
  LYRICS_THRESHOLD_DEFAULT,
  formatLyricsRatio,
  laneAt,
  laneCandidates,
  lanePreview,
  lyricsCounts,
  normalizeLyricsShare,
  parseLyricsRatio,
} from './lib/lyrics.js'
import { parseLyricsText } from './lib/lyrics-json.js'
import { analyzeVocalsBatch, embedTrack, embedTrackBatch } from './lib/embed-api.js'
import {
  cacheEmbedding,
  cacheEmbeddings,
  invalidateCachedEmbeddings,
  loadAllVectors,
  missingTrackIds,
} from './lib/embeddings.js'
import { parseEmbeddingText } from './lib/embedding-json.js'
import {
  FORMAT,
  VERSION,
  exportV2,
  parseAnyPlaylist,
  parseInternalId,
  playlistSummary,
} from './lib/playlist.js'
import { parseCommand } from './lib/command-parse.js'
import { estimateEta } from './lib/eta.js'
import { multiPageVideos, trackText } from './lib/console-format.js'
import { IMPORT_SOURCES, resolveImportTracks } from './lib/import-sources.js'
import { forgetTab, isVideoPageUrl, isVideoTabUrl, ownerTab, ownerTabId, registerTab } from './lib/sequence.js'
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
let prefetchState = {
  running: false,
  waitingAuth: false,
  complete: false,
  startedAt: null,
  startDone: 0,
  etaSeconds: null,
  done: 0,
  total: 0,
  remaining: 0,
  updatedAt: null,
}
const EMBED_BATCH_SIZE = 10
const EMBED_POLL_START_MS = 5000
const EMBED_POLL_MAX_MS = 20000
const EMBED_ITEM_DEADLINE_MS = 15 * 60_000
const MANUAL_PREFETCH_ALARM = 'jawbts-manual-prefetch'
const AUTO_FETCH_COOLDOWN_MS = 60_000
let lastAutoFetchAt = 0

const LYRICS_ALARM = 'jawbts-lyrics-analysis'
const LYRICS_BATCH_SIZE = 15
const LYRICS_POLL_START_MS = 2000
const LYRICS_POLL_MAX_MS = 15000
const LYRICS_ITEM_DEADLINE_MS = 15 * 60_000
const LYRICS_AUTO_COOLDOWN_MS = 60_000
let lastLyricsAutoStartAt = 0
let lyricsJobPromise = null
let lyricsStarting = false
let lyricsState = {
  running: false,
  complete: false,
  waitingAuth: false,
  waitingConsent: false,
  done: 0,
  total: 0,
  remaining: 0,
  failed: 0,
  startedAt: null,
  startDone: 0,
  updatedAt: null,
}

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
      // Verdicts saved with an older threshold are re-derived from their stored
      // ratio before the first status is served.
      await refreshLyricsVerdicts().catch(() => 0)
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

async function consentStatus(config = null) {
  const current = config || (await getConfig())
  const origins = remoteOrigins(current)
  if (origins.length === 0) return { required: false, granted: true, origins: [], at: null }
  const stored = await store.getConsent()
  return {
    required: true,
    granted: consentCovers(stored, origins),
    origins,
    at: stored?.at || null,
  }
}

async function requireRemoteConsent() {
  const consent = await consentStatus()
  if (consent.required && !consent.granted) {
    throw new Error(
      'Cross-border transfer consent is required in Settings & allowlist before the extension contacts a remote service.',
    )
  }
}

// Embeddings without a catalog (or staged) track are dropped automatically.
async function pruneVectors() {
  const [catalog, staged] = await Promise.all([ensureCatalog(), store.getStagedTracks()])
  if (catalog.tracks.length === 0) return 0
  const keep = new Set(catalog.tracks.map((track) => track.id))
  for (const id of staged.keys()) keep.add(id)
  const { vectors } = await loadAllVectors()
  const stale = [...vectors.keys()].filter((id) => !keep.has(id))
  if (stale.length === 0) return 0
  await store.deleteVectorCacheEntries(stale)
  invalidateCachedEmbeddings()
  return stale.length
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
  const consent = await consentStatus(config)
  if (missingCount > 0) startVectorFetch().catch(() => {})
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
  prefetchState = {
    ...prefetchState,
    waitingConsent: missingCount > 0 && consent.required && !consent.granted,
  }

  const byId = new Map(catalog.tracks.map((track) => [track.id, track]))
  const lyrics = await store.getLyrics()
  const lyricsSummary = lyricsCounts(lyrics, catalog.tracks.map((track) => track.id))
  const currentLyrics = currentId ? lyrics.get(currentId) || null : null
  // Vectors come first: the service analyzes one track per request, so wait
  // until the prefetch has filled the library before running detection.
  if (lyricsSummary.unknown > 0) {
    startLyricsFetch().catch(() => {})
  }
  const owner = await ownerTabEntry()
  return {
    ok: true,
    protocol: EXTENSION_PROTOCOL,
    catalogCount: catalog.tracks.length,
    catalogMissing: Boolean(catalog.empty),
    embeddedCount,
    missingCount,
    vectorError,
    consent,
    unavailable: Object.entries(await activeUnavailable()).map(([id, entry]) => ({
      id,
      title: entry.title || trackMeta(byId.get(id))?.title || '',
      code: entry.code,
      message: entry.message,
      at: entry.at,
    })),
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
    lyrics: {
      enabled: config.lyricsEnabled,
      share: config.lyricsShare,
      ...lyricsSummary,
      current: currentLyrics,
      job: lyricsProgress(),
    },
    prefetch: {
      ...prefetchState,
      etaSeconds: prefetchState.running
        ? estimateEta(
            prefetchState.done - (prefetchState.startDone || 0),
            prefetchState.remaining,
            prefetchState.startedAt,
          )
        : null,
    },
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
      // Soft navigation patches the video page's Vue player; festival and other
      // player pages must be replaced with a real navigation.
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      if (isVideoPageUrl(tab?.url) && (await softNavigate(tabId, track))) return
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
  // Deterministic lyrics lane: the cursor advances once per picked track and
  // resets when the share changes. Unanalyzed tracks stay in both lanes.
  const share = normalizeLyricsShare(config.lyricsShare)
  const trackIds = catalog.tracks.map((track) => track.id)
  let allowedIds = null
  let nextCursor = null
  let lanes = null
  let lyricsMeta = { enabled: false, share }
  if (config.lyricsEnabled) {
    const lyrics = await store.getLyrics()
    let cursor = await store.getLyricsCursor()
    if (cursor.share !== share) cursor = { share, index: 0 }
    const lane = laneAt(cursor.index, share)
    allowedIds = laneCandidates(lyrics, trackIds, lane)
    nextCursor = { share, index: cursor.index + 1 }
    lanes = { lyrics, lane }
    lyricsMeta = {
      enabled: true,
      share,
      lane,
      laneSize: allowedIds.size,
      known: lyricsCounts(lyrics, trackIds).known,
      cursor: cursor.index,
    }
  }
  let decision = recommender.selectNextDetailed(
    current,
    history,
    target,
    Math.random,
    plays,
    tuning,
    { allowedIds },
  )
  if (lanes && decision.poolSize === 0) {
    // The chosen lane has no eligible track. Keep the draw inside a single lane:
    // try the other lane instead of mixing every track together or stalling.
    const other = lanes.lane === LANE_LYRICS ? LANE_INSTRUMENTAL : LANE_LYRICS
    const otherIds = laneCandidates(lanes.lyrics, trackIds, other)
    const fallback = otherIds.size > 0
      ? recommender.selectNextDetailed(
          current,
          history,
          target,
          Math.random,
          plays,
          tuning,
          { allowedIds: otherIds },
        )
      : null
    if (fallback && fallback.poolSize > 0) {
      decision = fallback
      lyricsMeta = { ...lyricsMeta, lane: other, laneSize: otherIds.size, fallback: true }
    }
  }
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
      lyrics: lyricsMeta,
    }
    console.info('[jawbts] next-track decision', lastDecision)
    await store.setLastDecision(lastDecision).catch(() => {})
    throw new Error(
      config.lyricsEnabled
        ? 'No eligible next track; unclassified tracks are skipped while the lyrics share is on.'
        : 'No eligible next track; the candidate pool is empty.',
    )
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
    lyrics: lyricsMeta,
  }
  console.info('[jawbts] next-track decision', lastDecision)
  await store.setLastDecision(lastDecision).catch(() => {})

  if (newTab) await adoptTab(await chrome.tabs.create({ url: trackUrl(track) }), track.id)
  else await navigate(tabId, track, config.softNavigation)
  if (nextCursor) await store.setLyricsCursor(nextCursor).catch(() => {})
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

async function resumeManualPrefetch() {
  if (manualPrefetchPromise) return
  const job = await store.getPrefetchJob().catch(() => null)
  if (!job || job.kind !== 'manual') {
    try {
      chrome.alarms?.clear(MANUAL_PREFETCH_ALARM)
    } catch {
    }
    return
  }
  prefetch().catch((error) => console.error('manual prefetch resume failed', error))
}

let manualPrefetchPromise = null

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const UNAVAILABLE_TTL_MS = 24 * 3600 * 1000

async function activeUnavailable() {
  const entries = await store.getUnavailableVectors()
  const now = Date.now()
  let changed = false
  for (const [id, entry] of Object.entries(entries)) {
    if (now - entry.at >= UNAVAILABLE_TTL_MS) {
      delete entries[id]
      changed = true
    }
  }
  if (changed) await store.setUnavailableVectors(entries).catch(() => {})
  return entries
}

async function startVectorFetch() {
  if (manualPrefetchPromise) return
  if (Date.now() - lastAutoFetchAt < AUTO_FETCH_COOLDOWN_MS) return
  const [catalog, { vectors }] = await Promise.all([ensureCatalog(), getRecommender(true)])
  const unavailable = await activeUnavailable()
  const missing = missingTrackIds(catalog.tracks, vectors).filter((id) => !(id in unavailable))
  if (missing.length === 0) return
  const auth = await authStatus()
  if (!auth.devMode && !auth.connected) return
  lastAutoFetchAt = Date.now()
  prefetch().catch(() => {})
}

function prefetch(onProgress) {
  if (manualPrefetchPromise) return manualPrefetchPromise
  manualPrefetchPromise = runPrefetch(onProgress).finally(() => {
    manualPrefetchPromise = null
  })
  return manualPrefetchPromise
}

async function runPrefetch(onProgress) {
  await initialize()
  await requireRemoteConsent()
  const emit =
    onProgress ||
    ((progress) => broadcast({ type: 'prefetch-progress', ...progress }))
  const [catalog, { vectors }] = await Promise.all([ensureCatalog(), getRecommender(true)])
  const unavailable = await activeUnavailable()
  const unavailableCount = Object.keys(unavailable).length
  const titles = new Map(catalog.tracks.map((track) => [track.id, track.title]))
  const missingAll = missingTrackIds(catalog.tracks, vectors)
  const missing = missingAll.filter((id) => !(id in unavailable))
  const total = new Set(catalog.tracks.map((track) => track.id)).size
  let done = Math.max(0, total - missingAll.length)
  const baselineDone = done
  const startedAt = Date.now()
  try {
    chrome.alarms?.create(MANUAL_PREFETCH_ALARM, { periodInMinutes: 0.5 })
  } catch {
  }
  let failed = 0
  const persisted = { kind: 'manual', total, done, failed, startedAt }
  await store.setPrefetchJob(persisted).catch(() => {})
  const failures = []

  // Keep a window of 10 ids in flight and refill it as vectors arrive, so the
  // service queue stays full instead of draining between batches.
  const queue = [...missing]
  const batchWindow = new Map()
  let wait = EMBED_POLL_START_MS
  while (queue.length > 0 || batchWindow.size > 0) {
    let refilled = false
    while (batchWindow.size < EMBED_BATCH_SIZE && queue.length > 0) {
      batchWindow.set(queue.shift(), Date.now())
      refilled = true
    }
    if (batchWindow.size === 0) break
    const ids = [...batchWindow.keys()]
    emit({
      id: ids[0],
      done,
      total,
      failed,
      etaSeconds: estimateEta(done - baselineDone, total - done, startedAt),
    })
    let result
    try {
      result = await embedTrackBatch(ids)
    } catch (error) {
      if (error?.code === 'token_expired' || error?.name === 'AuthError') throw error
      const message = error?.message || String(error)
      for (const id of ids) {
        failures.push({ id, message })
        failed += 1
        batchWindow.delete(id)
      }
      continue
    }
    if (result.unsupported) {
      for (const id of ids) {
        try {
          const { vector } = await embedTrack(id)
          await cacheEmbedding(id, vector)
          await store.clearVectorUnavailable(id)
          done += 1
        } catch (error) {
          if (error?.code === 'token_expired' || error?.name === 'AuthError') throw error
          if (error?.code === 'video_unavailable') {
            await store.markVectorUnavailable(id, {
              code: error.code,
              message: error?.message || '',
              title: titles.get(id) || '',
            })
          }
          failures.push({ id, message: error?.message || String(error) })
          failed += 1
        }
        batchWindow.delete(id)
      }
      continue
    }
    for (const [id, item] of result.ready) {
      if (!batchWindow.has(id)) continue
      await cacheEmbedding(id, item.vector)
      await store.clearVectorUnavailable(id)
      batchWindow.delete(id)
      done += 1
    }
    for (const [id, failure] of result.failures) {
      if (!batchWindow.has(id)) continue
      if (failure.code === 'video_unavailable') {
        await store.markVectorUnavailable(id, {
          code: failure.code,
          message: failure.message,
          title: titles.get(id) || '',
        })
      }
      failures.push({ id, message: failure.message, code: failure.code })
      failed += 1
      batchWindow.delete(id)
    }
    if (result.pending.length === 0) {
      for (const id of [...batchWindow.keys()]) {
        failures.push({ id, message: 'the service returned no status' })
        failed += 1
        batchWindow.delete(id)
      }
    }
    const now = Date.now()
    for (const [id, queuedAt] of [...batchWindow.entries()]) {
      if (now - queuedAt > EMBED_ITEM_DEADLINE_MS) {
        failures.push({ id, message: 'timed out waiting for the embedding' })
        failed += 1
        batchWindow.delete(id)
      }
    }
    persisted.done = done
    persisted.failed = failed
    await store.setPrefetchJob(persisted).catch(() => {})
    const etaSeconds = estimateEta(done - baselineDone, total - done, startedAt)
    prefetchState = {
      running: true,
      waitingAuth: false,
      complete: false,
      done,
      total,
      remaining: Math.max(0, total - done),
      startedAt,
      startDone: baselineDone,
      etaSeconds,
      failed,
      unavailable: unavailableCount,
      updatedAt: Date.now(),
    }
    emit({
      id: ids[ids.length - 1],
      done,
      total,
      failed,
      etaSeconds,
    })
    if (batchWindow.size === 0 && queue.length === 0) break
    if (refilled || result.ready.size > 0) wait = EMBED_POLL_START_MS
    await delay(wait)
    wait = Math.min(EMBED_POLL_MAX_MS, Math.round(wait * 1.4))
  }

  await store.clearPrefetchJob().catch(() => {})
  try {
    chrome.alarms?.clear(MANUAL_PREFETCH_ALARM)
  } catch {
  }
  prefetchState = {
    running: false,
    waitingAuth: false,
    complete: true,
    done,
    total,
    remaining: 0,
    startedAt,
    startDone: baselineDone,
    etaSeconds: null,
    failed,
    unavailable: Object.keys(await activeUnavailable()).length,
    updatedAt: Date.now(),
  }
  invalidateCachedEmbeddings()
  invalidateRecommender()
  await getRecommender(true)
  broadcast({ type: 'data-changed', kind: 'embeddings' })
  startLyricsAnalysis().catch(() => {})
  return { ok: true, total, done, failed, failures }
}

// --- Lyrics analysis -------------------------------------------------------
// The service runs FireRedVAD on a track's audio and returns a vocal ratio
// (singing or speech); the extension stores the binary verdict and never
// analyzes audio itself.

function lyricsProgress() {
  return {
    ...lyricsState,
    etaSeconds: lyricsState.running
      ? estimateEta(
          lyricsState.done - lyricsState.startDone,
          lyricsState.remaining,
          lyricsState.startedAt,
        )
      : null,
  }
}

function emitLyrics() {
  broadcast({ type: 'lyrics-progress', ...lyricsProgress() })
}

async function lyricsTargets() {
  const [catalog, lyrics, unavailable] = await Promise.all([
    ensureCatalog(),
    store.getLyrics(),
    activeUnavailable(),
  ])
  const blocked = new Set(Object.keys(unavailable))
  return catalog.tracks
    .map((track) => track.id)
    .filter((id) => {
      if (blocked.has(id)) return false
      // Any stored verdict (manual or detected) is kept; detection only fills
      // tracks that have none.
      if (lyrics.has(id)) return false
      return true
    })
}

// Same lifecycle as the vector prefetch: run automatically when some track
// still has no verdict, with its own cooldown inside.
async function startLyricsFetch() {
  if (lyricsJobPromise || lyricsStarting) return
  const [catalog, lyrics, loaded] = await Promise.all([
    ensureCatalog(),
    store.getLyrics(),
    loadAllVectors(),
  ])
  if (!catalog.tracks.some((track) => !lyrics.has(track.id))) return
  // The vector pass computes a verdict with each vector. Waiting for it keeps a
  // fresh library from being downloaded twice; once vectors are local, the
  // detection-only pass runs on its own.
  if (missingTrackIds(catalog.tracks, loaded.vectors).length > 0) return
  await startLyricsAnalysis()
}

let lyricsVerdictsRefreshed = false

async function refreshLyricsVerdicts() {
  if (lyricsVerdictsRefreshed) return 0
  lyricsVerdictsRefreshed = true
  const threshold =
    (await store.getLyricsThreshold()) ?? LYRICS_THRESHOLD_DEFAULT
  return syncLyricsThreshold(threshold)
}

// The service owns the threshold. When it changes, re-evaluate the verdicts we
// already stored from their saved vocal ratio, so a tuning applies to the whole
// library without another audio pass.
async function syncLyricsThreshold(threshold) {
  if (!Number.isFinite(threshold)) return 0
  const previous = await store.getLyricsThreshold()
  if (previous === threshold) return 0
  const lyrics = await store.getLyrics()
  const updates = new Map()
  for (const [id, entry] of lyrics) {
    if (entry.source === 'manual') continue
    if (typeof entry.confidence !== 'number') continue
    const verdict = entry.confidence >= threshold
    if (verdict !== entry.lyrics) updates.set(id, { ...entry, lyrics: verdict })
  }
  if (updates.size > 0) await store.mergeLyrics(updates)
  await store.setLyricsThreshold(threshold)
  return updates.size
}

async function startLyricsAnalysis() {
  if (lyricsJobPromise || lyricsStarting) {
    return { ok: true, running: true, total: lyricsState.total }
  }
  lyricsStarting = true
  try {
    const targets = await lyricsTargets()
    if (targets.length === 0) {
      lyricsState = {
        ...lyricsState,
        running: false,
        complete: true,
        waitingAuth: false,
        waitingConsent: false,
        done: 0,
        total: 0,
        remaining: 0,
        failed: 0,
        updatedAt: Date.now(),
      }
      return { ok: true, running: false, total: 0 }
    }
    const [consent, auth] = await Promise.all([consentStatus(), authStatus()])
    if (consent.required && !consent.granted) {
      lyricsState = {
        ...lyricsState,
        running: false,
        complete: false,
        waitingConsent: true,
        waitingAuth: false,
        total: targets.length,
        remaining: targets.length,
        updatedAt: Date.now(),
      }
      return { ok: true, running: false, total: targets.length }
    }
    if (!auth.devMode && !auth.connected) {
      lyricsState = {
        ...lyricsState,
        running: false,
        complete: false,
        waitingAuth: true,
        waitingConsent: false,
        total: targets.length,
        remaining: targets.length,
        updatedAt: Date.now(),
      }
      return { ok: true, running: false, total: targets.length }
    }
    // Rate-limit attempts so a failure cannot retry on every status refresh.
    if (Date.now() - lastLyricsAutoStartAt < LYRICS_AUTO_COOLDOWN_MS) {
      return { ok: true, running: false, total: targets.length }
    }
    lastLyricsAutoStartAt = Date.now()
    const run = runLyricsAnalysis(targets)
    lyricsJobPromise = run
      .finally(() => {
        lyricsJobPromise = null
      })
      .catch(() => {})
    return { ok: true, running: true, total: targets.length }
  } finally {
    lyricsStarting = false
  }
}

async function runLyricsAnalysis(targets) {
  const catalog = await ensureCatalog()
  const titles = new Map(catalog.tracks.map((track) => [track.id, track.title]))
  const trackIds = catalog.tracks.map((track) => track.id)
  const total = targets.length
  let done = 0
  let failed = 0
  let failure = null
  const startedAt = Date.now()
  const queue = [...targets]
  const batchWindow = new Map()
  let wait = LYRICS_POLL_START_MS
  try {
    chrome.alarms?.create(LYRICS_ALARM, { periodInMinutes: 0.5 })
  } catch {
  }
  const refreshCounts = async () => {
    lyricsState = {
      ...lyricsState,
      counts: lyricsCounts(await store.getLyrics(), trackIds),
    }
  }
  lyricsState = {
    running: true,
    complete: false,
    waitingAuth: false,
    waitingConsent: false,
    done,
    total,
    remaining: total,
    failed,
    startedAt,
    startDone: 0,
    updatedAt: Date.now(),
    counts: null,
  }
  await refreshCounts()
  await store.setLyricsJob({ kind: 'analysis', total, done, failed, startedAt }).catch(() => {})
  emitLyrics()
  try {
    while (queue.length > 0 || batchWindow.size > 0) {
      let refilled = false
      while (batchWindow.size < LYRICS_BATCH_SIZE && queue.length > 0) {
        batchWindow.set(queue.shift(), Date.now())
        refilled = true
      }
      if (batchWindow.size === 0) break
      const ids = [...batchWindow.keys()]
      let result
      try {
        result = await analyzeVocalsBatch(ids)
      } catch (error) {
        if (error?.code === 'token_expired' || error?.name === 'AuthError') throw error
        if (error?.code === 'unsupported') throw new Error(error.message)
        for (const id of ids) {
          batchWindow.delete(id)
          failed += 1
        }
        continue
      }
      if (result.unsupported) {
        throw new Error('This embedding service does not offer lyrics detection.')
      }
      const updates = new Map()
      const at = new Date().toISOString()
      for (const [id, item] of result.ready) {
        if (!batchWindow.has(id)) continue
        updates.set(id, {
          lyrics: item.lyrics,
          confidence: item.confidence,
          source: 'detected',
          at,
        })
        batchWindow.delete(id)
        done += 1
      }
      if (updates.size > 0) {
        await store.mergeLyrics(updates)
        await syncLyricsThreshold(result.threshold)
        await refreshCounts()
      }
      for (const [id, failure] of result.failures) {
        if (!batchWindow.has(id)) continue
        // Deleted or private videos are skipped by the next run, like the vector
        // prefetch does; transient failures retry after the cooldown.
        if (failure.code === 'video_unavailable') {
          await store.markVectorUnavailable(id, {
            code: failure.code,
            message: failure.message,
            title: titles.get(id) || '',
          })
        }
        batchWindow.delete(id)
        failed += 1
      }
      if (result.pending.length === 0) {
        for (const id of [...batchWindow.keys()]) {
          batchWindow.delete(id)
          failed += 1
        }
      }
      const now = Date.now()
      for (const [id, queuedAt] of [...batchWindow.entries()]) {
        if (now - queuedAt > LYRICS_ITEM_DEADLINE_MS) {
          batchWindow.delete(id)
          failed += 1
        }
      }
      lyricsState = {
        ...lyricsState,
        done,
        total,
        remaining: Math.max(0, total - done),
        failed,
        updatedAt: Date.now(),
      }
      await store.setLyricsJob({ kind: 'analysis', total, done, failed, startedAt }).catch(() => {})
      emitLyrics()
      if (batchWindow.size === 0 && queue.length === 0) break
      if (refilled || result.ready.size > 0) wait = LYRICS_POLL_START_MS
      await delay(wait)
      wait = Math.min(LYRICS_POLL_MAX_MS, Math.round(wait * 1.4))
    }
  } catch (error) {
    failure = error
  } finally {
    await store.clearLyricsJob().catch(() => {})
    try {
      chrome.alarms?.clear(LYRICS_ALARM)
    } catch {
    }
    await refreshCounts().catch(() => {})
    lyricsState = {
      running: false,
      complete: failure === null,
      waitingAuth: false,
      waitingConsent: false,
      done,
      total,
      remaining: Math.max(0, total - done),
      failed,
      startedAt,
      startDone: 0,
      updatedAt: Date.now(),
      counts: lyricsState.counts,
    }
    emitLyrics()
    broadcast({ type: 'data-changed', kind: 'lyrics' })
  }
  if (failure) throw failure
  return { ok: true, total, done, failed }
}

async function resumeLyricsAnalysis() {
  if (lyricsJobPromise) return
  const job = await store.getLyricsJob().catch(() => null)
  if (!job) {
    try {
      chrome.alarms?.clear(LYRICS_ALARM)
    } catch {
    }
    return
  }
  startLyricsAnalysis().catch((error) => {
    console.error('lyrics analysis resume failed', error)
  })
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
  await pruneVectors().catch(() => 0)

  const ids = new Set(playlist.tracks.map((track) => track.id))
  await store.pruneLyrics(ids).catch(() => 0)
  const history = await store.getHistory()
  await store.setHistory(history.filter((id) => ids.has(id)))
  const current = await store.getCurrent()
  if (current && !ids.has(current)) await store.setCurrent(null)
  broadcast({ type: 'data-changed', kind: 'playlist' })
  startVectorFetch().catch(() => {})
  startLyricsFetch().catch(() => {})
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
  broadcast({ type: 'data-changed', kind: 'config' })
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

  // With the share on, the cloud shows the lane the next pick would use (plus
  // the current track as the anchor); tracks the selector cannot pick are gone.
  let lane = { enabled: false }
  let allowedIds = null
  let keep = null
  if (config.lyricsEnabled) {
    const [lyrics, cursor] = await Promise.all([
      store.getLyrics(),
      store.getLyricsCursor(),
    ])
    const share = normalizeLyricsShare(config.lyricsShare)
    const active = cursor.share === share ? cursor : { share, index: 0 }
    const laneName = laneAt(active.index, share)
    allowedIds = laneCandidates(lyrics, recommender.ids, laneName)
    keep = new Set(allowedIds)
    if (currentId) keep.add(currentId)
    points = points.filter((point) => keep.has(point.id))
    lane = { enabled: true, share, lane: laneName, size: allowedIds.size }
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
      lane,
    }
  }
  const { probabilities, maxProbability } = recommender.probabilities(
    currentId,
    history,
    target,
    plays,
    tuning,
    allowedIds ? { allowedIds } : {},
  )
  const visibleProbabilities = keep
    ? new Map([...probabilities].filter(([id]) => keep.has(id)))
    : probabilities
  const raw = recommender.rawSimilarities(currentId)
  const visibleRaw = keep
    ? new Map([...raw].filter(([id]) => keep.has(id)))
    : raw
  return {
    ok: true,
    current: currentId,
    target: targetPercent,
    tuning,
    probabilities: Object.fromEntries(visibleProbabilities),
    max: maxProbability,
    raw: Object.fromEntries(visibleRaw),
    points,
    lane,
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


// ---------- console ----------

let previewController = null

const CONSOLE_HELP = [
  'help                                     this list',
  'status                                   library, staging, session and consent',
  'library [--filter=text]                  list the catalog',
  'staged [--filter=text]                   list the staging space',
  'removed [--filter=text]                  list tombstones',
  'track <id>                               show one track',
  'import video|series|collection|favorites <id|url>',
  '                                         resolve and stage (preview first)',
  'import ... --show-removed                list only the tombstoned entries',
  'stage remove <id...>                     remove from staging and tombstone',
  'stage clear                              discard all staging',
  'merge                                    staged -> catalog (skips removed)',
  'remove <id...>                           tombstone: hidden from playlists and imports',
  'restore <id...>                          undo a tombstone, return to catalog',
  'forget <id...>                           erase track, vector, history and tombstone',
  'remove-unavailable                        tombstone every marked unavailable track',
  'target <0-100>                           set target similarity',
  'auto on|off                              toggle auto advance',
  'login | logout                           manage the account session',
  'consent grant|revoke                     allow or revoke remote service calls',
  'prefetch                                 fetch missing vectors',
  'lyrics [status]                          share, verdict counts and progress',
  'lyrics mix on|off                        enable or disable the lyrics share',
  'lyrics ratio <1:x|percent>               mix: 1:1.5, 0:1, 1:0 or 40%',
  'lyrics on|off [id...]                    mark tracks (default: the current one)',
  'clear                                    clear this transcript',
]

function consoleListing(title, items = []) {
  const mapped = items.map((item) => (typeof item === 'string' ? { text: item } : item))
  return { title, items: mapped, total: mapped.length }
}

function consoleFilter(items, flags) {
  if (flags.filter === true) throw new Error('--filter needs a value: --filter=text')
  const value = typeof flags.filter === 'string' ? flags.filter.trim().toLowerCase() : ''
  if (!value) return items
  return items.filter((item) => String(item.text || '').toLowerCase().includes(value))
}

function trackItem(track, { prefix = '', multi = false, suffix = '', actions } = {}) {
  return {
    text: `${prefix}${trackText(track, { multi })}${suffix}`,
    id: track.id,
    videoId: track.video_id || track.videoId || null,
    page: Number(track.page) || 1,
    url: trackUrl(track),
    ...(actions ? { actions } : {}),
  }
}

async function consoleState() {
  const [catalog, staged, removed] = await Promise.all([
    ensureCatalog(),
    store.getStagedTracks(),
    store.getRemovedTracks(),
  ])
  return { catalog, staged, removed }
}

function consoleIds(args) {
  if (args.length === 0) throw new Error('give at least one track id')
  return args.map((value) => {
    try {
      return parseInternalId(String(value)).id
    } catch (error) {
      throw new Error(`${value}: ${error.message}`)
    }
  })
}

async function consoleStatus() {
  const [catalog, staged, removed, session, currentId, config] = await Promise.all([
    ensureCatalog(),
    store.getStagedTracks(),
    store.getRemovedTracks(),
    authStatus(),
    store.getCurrent(),
    getConfig(),
  ])
  const current = catalog.tracks.find((track) => track.id === currentId)
  const consent = await consentStatus(config)
  const items = [
    `catalog   ${catalog.tracks.length} tracks`,
    `staged    ${staged.size}`,
    `removed   ${removed.size}`,
    current
      ? { text: `current   ${current.id}  ${current.title}`, id: current.id, url: trackUrl(current) }
      : 'current   nothing recorded',
    `session   ${session.connected ? 'connected' : 'signed out'}`,
    `consent   ${consent.required ? (consent.granted ? 'granted' : 'required') : 'local only'}`,
    `target    ${config.targetSimilarity}% · auto advance ${config.autoAdvance ? 'on' : 'off'}`,
  ]
  return consoleListing('status', items)
}

async function consoleLibrary(flags) {
  const catalog = await ensureCatalog()
  const multi = multiPageVideos(catalog.tracks)
  const items = catalog.tracks.map((track) =>
    trackItem(track, {
      multi: multi.has(track.video_id),
      actions: [{ label: 'Remove', command: `remove ${track.id}` }],
    }),
  )
  return consoleListing('library', consoleFilter(items, flags))
}

async function consoleStaged(flags) {
  const staged = await store.getStagedTracks()
  const tracks = [...staged.values()]
  const multi = multiPageVideos(tracks)
  const items = tracks.map((track) =>
    trackItem(track, {
      multi: multi.has(track.video_id),
      actions: [{ label: 'Remove', command: `stage remove ${track.id}` }],
    }),
  )
  return consoleListing('staged', consoleFilter(items, flags))
}

async function consoleRemoved(flags) {
  const removed = await store.getRemovedTracks()
  const multi = multiPageVideos([...removed.values()].map((entry) => entry.track))
  const items = [...removed.entries()].map(([id, entry]) =>
    trackItem(entry.track, {
      multi: multi.has(entry.track.video_id),
      suffix: `  removed ${entry.at ? entry.at.slice(0, 10) : ''}`,
      actions: [
        { label: 'Restore', command: `restore ${id}` },
        { label: 'Forget', command: `forget ${id}` },
      ],
    }),
  )
  return consoleListing('removed', consoleFilter(items, flags))
}

async function consoleTrack(args) {
  const id = consoleIds([args[0]])[0]
  const { catalog, staged, removed } = await consoleState()
  const track =
    catalog.tracks.find((item) => item.id === id) || staged.get(id) || removed.get(id)?.track
  if (!track) throw new Error(`${id} is not in the catalog, staging or removed`)
  const where = catalog.tracks.some((item) => item.id === id)
    ? 'catalog'
    : staged.has(id)
      ? 'staged'
      : 'removed'
  return consoleListing(`track ${id}`, [
    { text: `id        ${track.id}`, id: track.id, url: trackUrl(track) },
    `title     ${track.title}`,
    `provider  ${track.provider}`,
    `video_id  ${track.video_id}`,
    `page      ${track.page}`,
    `state     ${where}`,
  ])
}

async function consoleImport(args, flags, signal) {
  const source = String(args[0] || '').toLowerCase()
  const target = args[1]
  if (!IMPORT_SOURCES.includes(source)) {
    throw new Error('usage: import video|series|collection|favorites <id|url>')
  }
  if (!target) throw new Error('missing id or URL')
  let tracks
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  const forwardAbort = () => controller.abort()
  signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    tracks = await resolveImportTracks(source, target, { signal: controller.signal })
  } catch (error) {
    const message = error?.message || String(error)
    return {
      preview: {
        title: `import ${source} ${target}`,
        summary: message,
        items: [],
        destructive: false,
        blocked: message,
      },
      result: [message],
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
  const { catalog, staged, removed } = await consoleState()
  const catalogIds = new Set(catalog.tracks.map((track) => track.id))
  const stagedIds = new Set(staged.keys())
  const removedHits = tracks.filter((track) => removed.has(track.id))
  const fresh = tracks.filter(
    (track) => !removed.has(track.id) && !stagedIds.has(track.id) && !catalogIds.has(track.id),
  )
  const duplicates = tracks.filter((track) => !removed.has(track.id) && !fresh.includes(track))

  if (flags['show-removed']) {
    const multiRemoved = multiPageVideos(removedHits)
    return {
      preview: {
        title: `import ${source} ${target} · removed only`,
        summary: `${removedHits.length} removed · nothing will be staged`,
        items: consoleFilter(
          removedHits.map((track) =>
            trackItem(track, { prefix: 'removed  ', multi: multiRemoved.has(track.video_id) }),
          ),
          flags,
        ),
        destructive: false,
      },
      result: [`removed only · ${removedHits.length} · nothing staged`],
    }
  }

  const multi = multiPageVideos(tracks)
  const items = [
    ...fresh.map((track) => trackItem(track, { prefix: 'add     ', multi: multi.has(track.video_id) })),
    ...duplicates.map((track) =>
      trackItem(track, {
        prefix: 'skip    ',
        multi: multi.has(track.video_id),
        suffix: '  (already staged or in catalog)',
      }),
    ),
  ]
  return {
    preview: {
      title: `import ${source} ${target}`,
      summary: `add ${fresh.length} · skip ${duplicates.length} duplicates · skip ${removedHits.length} removed`,
      items: consoleFilter(items, flags),
      destructive: false,
    },
    apply: async () => {
      if (fresh.length > 0) {
        const next = new Map(staged)
        for (const track of fresh) next.set(track.id, track)
        await store.setStagedTracks(next)
        broadcast({ type: 'data-changed', kind: 'catalog' })
      }
      return [
        `staged ${fresh.length} track${fresh.length === 1 ? '' : 's'}`,
        `skipped ${duplicates.length} duplicates · ${removedHits.length} removed`,
        `staged total ${staged.size + fresh.length}`,
      ]
    },
  }
}

async function consoleMerge(flags) {
  const { catalog, staged, removed } = await consoleState()
  const catalogIds = new Set(catalog.tracks.map((track) => track.id))
  const add = []
  const removedRows = []
  const duplicateRows = []
  for (const [id, track] of staged) {
    if (removed.has(id)) removedRows.push(track)
    else if (catalogIds.has(id)) duplicateRows.push(track)
    else add.push(track)
  }
  const multi = multiPageVideos([...staged.values()])
  const items = [
    ...add.map((track) => trackItem(track, { prefix: 'add     ', multi: multi.has(track.video_id) })),
    ...removedRows.map((track) =>
      trackItem(track, { prefix: 'skip    ', multi: multi.has(track.video_id), suffix: '  (removed)' }),
    ),
    ...duplicateRows.map((track) =>
      trackItem(track, {
        prefix: 'skip    ',
        multi: multi.has(track.video_id),
        suffix: '  (already in catalog)',
      }),
    ),
  ]
  return {
    preview: {
      title: 'merge staged → catalog',
      summary: `add ${add.length} · skip ${removedRows.length} removed · skip ${duplicateRows.length} duplicates`,
      items: consoleFilter(items, flags),
      destructive: false,
    },
    apply: async () => {
      if (add.length > 0) {
        const next = { format: FORMAT, version: VERSION, tracks: [...catalog.tracks, ...add] }
        await store.setCatalog(next)
        catalogCache = next
        invalidateRecommender()
      }
      await store.setStagedTracks(new Map())
      broadcast({ type: 'data-changed', kind: 'catalog' })
      return [
        `merged ${add.length} track${add.length === 1 ? '' : 's'}`,
        `skipped ${removedRows.length} removed · ${duplicateRows.length} duplicates`,
        'staging cleared',
      ]
    },
  }
}

async function consoleRemove(args, flags) {
  const ids = consoleIds(args)
  const { catalog, removed } = await consoleState()
  const byId = new Map(catalog.tracks.map((track) => [track.id, track]))
  const targets = ids.map((id) => byId.get(id)).filter(Boolean)
  const missing = ids.filter((id) => !byId.has(id))
  const items = [
    ...targets.map((track) => trackItem(track, { prefix: 'remove  ' })),
    ...missing.map((id) => ({ text: `missing ${id}  (not in the catalog)` })),
  ]
  return {
    preview: {
      title: 'remove',
      summary: `remove ${targets.length} · hidden from playlists and future imports`,
      items: consoleFilter(items, flags),
      destructive: targets.length > 0,
    },
    apply: async () => {
      if (targets.length === 0) return ['nothing removed']
      const nextRemoved = new Map(removed)
      const at = new Date().toISOString()
      for (const track of targets) nextRemoved.set(track.id, { track, at })
      await store.setRemovedTracks(nextRemoved)
      const nextCatalog = {
        format: FORMAT,
        version: VERSION,
        tracks: catalog.tracks.filter((track) => !ids.includes(track.id)),
      }
      await store.setCatalog(nextCatalog)
      catalogCache = nextCatalog
      await store.deleteVectorCacheEntries(targets.map((track) => track.id))
      const current = await store.getCurrent()
      if (current && ids.includes(current)) await store.setCurrent(null)
      const history = await store.getHistory()
      await store.setHistory(history.filter((id) => !ids.includes(id)))
      lastDecision = null
      await store.clearLastDecision().catch(() => {})
      invalidateCachedEmbeddings()
      invalidateRecommender()
      broadcast({ type: 'data-changed', kind: 'catalog' })
      return [
        `removed ${targets.length} track${targets.length === 1 ? '' : 's'}`,
        'restore with: restore <id>',
      ]
    },
  }
}

async function consoleRestore(args, flags) {
  const ids = consoleIds(args)
  const { catalog, removed } = await consoleState()
  const entries = ids.map((id) => [id, removed.get(id)]).filter(([, entry]) => Boolean(entry))
  const missing = ids.filter((id) => !removed.has(id))
  const items = [
    ...entries.map(([, entry]) => trackItem(entry.track, { prefix: 'restore  ' })),
    ...missing.map((id) => ({ text: `missing ${id}  (no tombstone)` })),
  ]
  return {
    preview: {
      title: 'restore',
      summary: `restore ${entries.length} · imports may include them again`,
      items: consoleFilter(items, flags),
      destructive: false,
    },
    apply: async () => {
      if (entries.length === 0) return ['nothing restored']
      const nextRemoved = new Map(removed)
      const catalogIds = new Set(catalog.tracks.map((track) => track.id))
      const add = []
      for (const [id, entry] of entries) {
        nextRemoved.delete(id)
        if (!catalogIds.has(id)) add.push(entry.track)
      }
      await store.setRemovedTracks(nextRemoved)
      if (add.length > 0) {
        const next = { format: FORMAT, version: VERSION, tracks: [...catalog.tracks, ...add] }
        await store.setCatalog(next)
        catalogCache = next
        invalidateRecommender()
      }
      broadcast({ type: 'data-changed', kind: 'catalog' })
      return [
        `restored ${entries.length} track${entries.length === 1 ? '' : 's'}`,
        ...(add.length > 0 ? [`${add.length} returned to the catalog`] : []),
      ]
    },
  }
}

async function consoleForget(args, flags) {
  const ids = consoleIds(args)
  const { catalog, staged, removed } = await consoleState()
  const inCatalog = catalog.tracks.filter((track) => ids.includes(track.id))
  const inStaged = [...staged.values()].filter((track) => ids.includes(track.id))
  const tombstones = ids.filter((id) => removed.has(id))
  if (inCatalog.length === 0 && inStaged.length === 0 && tombstones.length === 0) {
    throw new Error('no matching catalog, staged or removed track')
  }
  const history = await store.getHistory()
  const historyHits = history.filter((id) => ids.includes(id)).length
  const items = [
    ...inCatalog.map((track) => trackItem(track, { prefix: 'catalog   ' })),
    ...inStaged.map((track) => trackItem(track, { prefix: 'staged    ' })),
    ...tombstones.map((id) =>
      trackItem(removed.get(id).track, { prefix: 'tombstone ' }),
    ),
    { text: `vector    ${ids.length} entries` },
    { text: `history   ${historyHits} entries` },
    { text: 'a future import may add it again' },
  ]
  return {
    preview: {
      title: 'forget',
      summary: `erase ${ids.length} track${ids.length === 1 ? '' : 's'} completely`,
      items: consoleFilter(items, flags),
      destructive: true,
    },
    apply: async () => {
      const nextCatalog = {
        format: FORMAT,
        version: VERSION,
        tracks: catalog.tracks.filter((track) => !ids.includes(track.id)),
      }
      await store.setCatalog(nextCatalog)
      catalogCache = nextCatalog
      const nextStaged = new Map(staged)
      for (const id of ids) nextStaged.delete(id)
      await store.setStagedTracks(nextStaged)
      const nextRemoved = new Map(removed)
      for (const id of ids) nextRemoved.delete(id)
      await store.setRemovedTracks(nextRemoved)
      await store.deleteVectorCacheEntries(ids)
      await store.deleteLyricsEntries(ids)
      await store.setHistory(history.filter((id) => !ids.includes(id)))
      const plays = await store.getSessionPlays()
      let playsChanged = false
      for (const id of ids) {
        if (Object.prototype.hasOwnProperty.call(plays, id)) {
          delete plays[id]
          playsChanged = true
        }
      }
      if (playsChanged) await store.setSessionPlays(plays)
      const current = await store.getCurrent()
      if (current && ids.includes(current)) await store.setCurrent(null)
      lastDecision = null
      await store.clearLastDecision().catch(() => {})
      invalidateCachedEmbeddings()
      invalidateRecommender()
      broadcast({ type: 'data-changed', kind: 'catalog' })
      return [
        `forgot ${ids.length} track${ids.length === 1 ? '' : 's'}`,
        'catalog, vectors, history and tombstones are gone',
      ]
    },
  }
}

async function consoleRemoveUnavailable(flags) {
  const unavailable = await activeUnavailable()
  const ids = Object.keys(unavailable)
  if (ids.length === 0) {
    return {
      preview: {
        title: 'remove unavailable',
        summary: 'no unavailable vectors are marked',
        items: [],
        destructive: false,
      },
      apply: async () => ['no unavailable vectors'],
    }
  }
  const { catalog, removed } = await consoleState()
  const byId = new Map(catalog.tracks.map((track) => [track.id, track]))
  const targets = ids.map((id) => byId.get(id)).filter(Boolean)
  const missing = ids.filter((id) => !byId.has(id))
  const items = [
    ...targets.map((track) =>
      trackItem(track, {
        prefix: 'remove  ',
        suffix: `  (${unavailable[track.id]?.code || 'unavailable'})`,
      }),
    ),
    ...missing.map((id) => ({ text: `clear   ${id}  (not in the catalog)` })),
  ]
  return {
    preview: {
      title: 'remove unavailable',
      summary: `tombstone ${targets.length} · clear ${ids.length} marks`,
      items: consoleFilter(items, flags),
      destructive: true,
    },
    apply: async () => {
      const at = new Date().toISOString()
      const nextRemoved = new Map(removed)
      for (const track of targets) nextRemoved.set(track.id, { track, at })
      await store.setRemovedTracks(nextRemoved)
      if (targets.length > 0) {
        const nextCatalog = {
          format: FORMAT,
          version: VERSION,
          tracks: catalog.tracks.filter((track) => !ids.includes(track.id)),
        }
        await store.setCatalog(nextCatalog)
        catalogCache = nextCatalog
      }
      await store.deleteVectorCacheEntries(ids)
      const nextUnavailable = { ...unavailable }
      for (const id of ids) delete nextUnavailable[id]
      await store.setUnavailableVectors(nextUnavailable)
      const history = await store.getHistory()
      await store.setHistory(history.filter((id) => !ids.includes(id)))
      const current = await store.getCurrent()
      if (current && ids.includes(current)) await store.setCurrent(null)
      lastDecision = null
      await store.clearLastDecision().catch(() => {})
      invalidateCachedEmbeddings()
      invalidateRecommender()
      broadcast({ type: 'data-changed', kind: 'catalog' })
      return [
        `tombstoned ${targets.length} track${targets.length === 1 ? '' : 's'}`,
        `cleared ${ids.length} unavailable mark${ids.length === 1 ? '' : 's'}`,
      ]
    },
  }
}

async function consoleStage(args, flags) {
  const action = String(args[0] || '').toLowerCase()
  const { staged, removed } = await consoleState()
  const at = new Date().toISOString()

  function tombstone(nextStaged, nextRemoved, targets) {
    for (const track of targets) {
      nextStaged.delete(track.id)
      nextRemoved.set(track.id, { track, at })
    }
  }

  if (action === 'clear') {
    const tracks = [...staged.values()]
    const multi = multiPageVideos(tracks)
    const items = tracks.map((track) =>
      trackItem(track, { prefix: 'remove  ', multi: multi.has(track.video_id) }),
    )
    return {
      preview: {
        title: 'stage clear',
        summary: `remove ${tracks.length} staged track${tracks.length === 1 ? '' : 's'} · tombstones written`,
        items: consoleFilter(items, flags),
        destructive: tracks.length > 0,
      },
      apply: async () => {
        const nextStaged = new Map()
        const nextRemoved = new Map(removed)
        tombstone(nextStaged, nextRemoved, tracks)
        await store.setStagedTracks(nextStaged)
        await store.setRemovedTracks(nextRemoved)
        await store.deleteVectorCacheEntries(tracks.map((track) => track.id))
        invalidateCachedEmbeddings()
        broadcast({ type: 'data-changed', kind: 'catalog' })
        return [
          `removed ${tracks.length} staged track${tracks.length === 1 ? '' : 's'}`,
          'restore with: restore <id>',
        ]
      },
    }
  }

  if (action !== 'remove') throw new Error('usage: stage remove <id...> | stage clear')
  const ids = consoleIds(args.slice(1))
  const targets = ids.map((id) => staged.get(id)).filter(Boolean)
  const missing = ids.filter((id) => !staged.has(id))
  const multi = multiPageVideos(targets)
  const items = [
    ...targets.map((track) =>
      trackItem(track, { prefix: 'remove  ', multi: multi.has(track.video_id) }),
    ),
    ...missing.map((id) => ({ text: `missing ${id}  (not staged)` })),
  ]
  return {
    preview: {
      title: 'stage remove',
      summary: `remove ${targets.length} from staging · tombstoned`,
      items: consoleFilter(items, flags),
      destructive: targets.length > 0,
    },
    apply: async () => {
      if (targets.length === 0) return ['nothing staged to remove']
      const nextStaged = new Map(staged)
      const nextRemoved = new Map(removed)
      tombstone(nextStaged, nextRemoved, targets)
      await store.setStagedTracks(nextStaged)
      await store.setRemovedTracks(nextRemoved)
      await store.deleteVectorCacheEntries(targets.map((track) => track.id))
      invalidateCachedEmbeddings()
      broadcast({ type: 'data-changed', kind: 'catalog' })
      return [
        `removed ${targets.length} staged track${targets.length === 1 ? '' : 's'}`,
        'restore with: restore <id>',
      ]
    },
  }
}

async function consoleTarget(args) {
  const value = Number(args[0])
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('usage: target <0-100>')
  const config = await getConfig()
  return {
    preview: {
      title: 'target',
      summary: `${config.targetSimilarity}% → ${value}%`,
      items: [{ text: `targetSimilarity ${config.targetSimilarity} → ${value}` }],
      destructive: false,
    },
    apply: async () => {
      await setConfig({ ...config, targetSimilarity: value })
      broadcast({ type: 'data-changed', kind: 'config' })
      return [`target similarity ${value}%`]
    },
  }
}

async function consoleAuto(args) {
  const action = String(args[0] || '').toLowerCase()
  if (!['on', 'off'].includes(action)) throw new Error('usage: auto on|off')
  const config = await getConfig()
  const value = action === 'on'
  return {
    preview: {
      title: 'auto',
      summary: `auto advance ${config.autoAdvance ? 'on' : 'off'} → ${value ? 'on' : 'off'}`,
      items: [{ text: `autoAdvance ${config.autoAdvance} → ${value}` }],
      destructive: false,
    },
    apply: async () => {
      await setConfig({ ...config, autoAdvance: value })
      broadcast({ type: 'data-changed', kind: 'config' })
      return [`auto advance ${value ? 'on' : 'off'}`]
    },
  }
}

async function consoleLogin() {
  await requireRemoteConsent()
  const session = await authConnect()
  startVectorFetch().catch(() => {})
  startLyricsFetch().catch(() => {})
  return [`signed in${session?.devMode ? ' (dev mode)' : ''}`]
}

async function consoleLogout() {
  return {
    preview: {
      title: 'logout',
      summary: 'clear the stored session',
      items: [{ text: 'vector fetching stops until you sign in again' }],
      destructive: true,
    },
    apply: async () => {
      await authDisconnect()
      return ['signed out']
    },
  }
}

async function consoleConsent(args) {
  const action = String(args[0] || '').toLowerCase()
  if (!['grant', 'revoke'].includes(action)) throw new Error('usage: consent grant|revoke')
  const config = await getConfig()
  const origins = remoteOrigins(config)
  if (action === 'grant') {
    return {
      preview: {
        title: 'consent grant',
        summary: `allow request data to ${origins.join(', ') || 'no remote services'}`,
        items: origins.map((origin) => ({ text: origin })),
        destructive: false,
      },
      apply: async () => {
        await store.setConsent({ granted: true, at: new Date().toISOString(), origins })
        broadcast({ type: 'data-changed', kind: 'consent' })
        return ['consent granted']
      },
    }
  }
  return {
    preview: {
      title: 'consent revoke',
      summary: 'stop contacting remote services',
      items: origins.map((origin) => ({ text: origin })),
      destructive: true,
    },
    apply: async () => {
      await store.clearConsent()
      broadcast({ type: 'data-changed', kind: 'consent' })
      return ['consent revoked']
    },
  }
}

async function consolePrefetch() {
  const result = await prefetch()
  return [`prefetch ${result.done ?? 0}/${result.total ?? 0}`]
}

function lyricsPatternText(share, length = 10) {
  return lanePreview(share, length)
    .map((lane) => (lane === LANE_LYRICS ? 'L' : 'NL'))
    .join(' ')
}

async function consoleLyrics(args) {
  const sub = String(args[0] || 'status').toLowerCase()
  if (!['status', 'mix', 'ratio', 'on', 'off'].includes(sub)) {
    throw new Error('usage: lyrics [status|mix on|off|ratio <1:x|percent>|on|off [id...]]')
  }
  const config = await getConfig()

  if (sub === 'ratio') {
    if (args.length < 2) throw new Error('usage: lyrics ratio <1:x|percent>')
    const value = parseLyricsRatio(args[1])
    const previous = config.lyricsShare
    return {
      preview: {
        title: 'lyrics ratio',
        summary: `${formatLyricsRatio(previous)} → ${formatLyricsRatio(value)}`,
        items: [{ text: `pattern ${lyricsPatternText(value)}` }],
        destructive: false,
      },
      apply: async () => {
        await setConfig({ ...config, lyricsShare: value })
        await store.setLyricsCursor({ share: value, index: 0 })
        broadcast({ type: 'data-changed', kind: 'config' })
        return [`lyrics ratio ${formatLyricsRatio(value)}`, `pattern ${lyricsPatternText(value)}`]
      },
    }
  }

  if (sub === 'mix') {
    const action = String(args[1] || '').toLowerCase()
    if (!['on', 'off'].includes(action)) throw new Error('usage: lyrics mix on|off')
    const value = action === 'on'
    return {
      preview: {
        title: `lyrics mix ${action}`,
        summary: `lyrics share ${config.lyricsEnabled ? 'on' : 'off'} → ${value ? 'on' : 'off'}`,
        items: [
          {
            text: value
              ? 'the 500 candidates are drawn from the matching lane only'
              : 'the 500 candidates come from every track',
          },
        ],
        destructive: false,
      },
      apply: async () => {
        await setConfig({ ...config, lyricsEnabled: value })
        broadcast({ type: 'data-changed', kind: 'config' })
        if (value) startLyricsFetch().catch(() => {})
        return [`lyrics share ${value ? 'on' : 'off'}`]
      },
    }
  }

  if (sub === 'on' || sub === 'off') {
    const wanted = sub === 'on'
    const ids =
      args.length > 1
        ? consoleIds(args.slice(1))
        : [await store.getCurrent()].filter(Boolean)
    if (ids.length === 0) throw new Error('give a track id or play a track first')
    const lyrics = await store.getLyrics()
    const items = ids.map((id) => {
      const entry = lyrics.get(id)
      const previous = entry ? (entry.lyrics ? 'lyrics' : 'instrumental') : 'unknown'
      return { text: `${id}  ${previous} → ${wanted ? 'lyrics' : 'instrumental'}` }
    })
    return {
      preview: {
        title: `lyrics ${sub}`,
        summary: `${ids.length} track${ids.length === 1 ? '' : 's'} set to ${wanted ? 'lyrics' : 'instrumental'}`,
        items,
        destructive: true,
      },
      apply: async () => {
        const at = new Date().toISOString()
        const updates = new Map(
          ids.map((id) => [
            id,
            { lyrics: wanted, confidence: null, source: 'manual', at },
          ]),
        )
        await store.mergeLyrics(updates)
        broadcast({ type: 'data-changed', kind: 'lyrics' })
        return [
          `${ids.length} track${ids.length === 1 ? '' : 's'} set to ${wanted ? 'lyrics' : 'instrumental'}`,
        ]
      },
    }
  }

  const [catalog, lyrics, currentId] = await Promise.all([
    ensureCatalog(),
    store.getLyrics(),
    store.getCurrent(),
  ])
  const counts = lyricsCounts(lyrics, catalog.tracks.map((track) => track.id))
  const current = currentId ? lyrics.get(currentId) || null : null
  const job = lyricsProgress()
  const items = [
    `mix       ${config.lyricsEnabled ? 'on' : 'off'} · ${formatLyricsRatio(config.lyricsShare)}  ${lyricsPatternText(config.lyricsShare)}`,
    `tracks    ${counts.tracks} · ${counts.withLyrics} with lyrics · ${counts.withoutLyrics} without · ${counts.unknown} unknown`,
    currentId
      ? `current   ${currentId} · ${current ? (current.lyrics ? 'lyrics' : 'instrumental') : 'unknown'}${current?.source === 'manual' ? ' (manual)' : ''}`
      : 'current   nothing recorded',
    job.running
      ? `progress  ${job.done}/${job.total}${job.remaining ? ` · ${job.remaining} left` : ''}${job.failed ? ` · ${job.failed} failed` : ''}`
      : counts.unknown > 0
        ? 'progress  idle — fetching automatically'
        : 'progress  complete',
  ]
  return consoleListing('lyrics', items)
}

const partInfoCache = new Map()
const PART_INFO_TTL = 10 * 60 * 1000
const PART_INFO_FAIL_TTL = 60 * 1000

async function fetchPartInfo(bvid) {
  const cached = partInfoCache.get(bvid)
  if (cached && Date.now() - cached.at < cached.ttl) return cached.value
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    if (body.code !== 0 || !Array.isArray(body.data)) {
      throw new Error(body.message || 'no page list')
    }
    const parts = body.data.map((entry) => String(entry.part || '').trim())
    const info = { count: parts.length, parts }
    if (partInfoCache.size > 400) partInfoCache.clear()
    partInfoCache.set(bvid, { value: info, at: Date.now(), ttl: PART_INFO_TTL })
    return info
  } catch {
    partInfoCache.set(bvid, { value: null, at: Date.now(), ttl: PART_INFO_FAIL_TTL })
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Resolve P names for the first part of a video that only appears as P1 in the
// library, so it can show "P1 <name>" even without P2 being imported.
async function partInfo(ids) {
  const unique = [
    ...new Set(
      (ids || []).filter((id) => typeof id === 'string' && /^BV[0-9A-Za-z]{10}$/.test(id)),
    ),
  ].slice(0, 30)
  const info = {}
  const queue = [...unique]
  const workers = []
  for (let index = 0; index < Math.min(4, queue.length); index += 1) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const bvid = queue.shift()
          const data = await fetchPartInfo(bvid)
          if (data) info[bvid] = data
        }
      })(),
    )
  }
  await Promise.all(workers)
  return { ok: true, info }
}

async function consoleHeader() {
  const [catalog, staged, removed, currentId] = await Promise.all([
    ensureCatalog(),
    store.getStagedTracks(),
    store.getRemovedTracks(),
    store.getCurrent(),
  ])
  return {
    ok: true,
    header: {
      catalog: catalog.tracks.length,
      staged: staged.size,
      removed: removed.size,
      current: currentId,
    },
  }
}

async function runConsoleCommand(message) {
  const line = String(message.line ?? '').trim()
  if (!line) throw new Error('empty command')
  const { name, args, flags } = parseCommand(line)
  const preview = Boolean(message.preview)
  previewController?.abort()
  previewController = preview ? new AbortController() : null
  const previewSignal = preview ? previewController.signal : undefined

  const settle = async (plan) => {
    if (!plan) return {}
    if (plan.listing) return { ok: true, listing: plan.listing }
    // Previews are computed before Enter; running never re-shows one.
    if (preview) return { ok: true, preview: plan.preview }
    if (plan.preview?.blocked) {
      return { ok: true, lines: plan.result || [plan.preview.blocked] }
    }
    const lines = plan.apply ? await plan.apply() : plan.result || []
    return { ok: true, lines }
  }

  switch (name) {
    case 'help':
      return { ok: true, listing: consoleListing('help', CONSOLE_HELP) }
    case 'status':
      return { ok: true, listing: await consoleStatus() }
    case 'library':
      return { ok: true, listing: await consoleLibrary(flags) }
    case 'staged':
      return { ok: true, listing: await consoleStaged(flags) }
    case 'removed':
      return { ok: true, listing: await consoleRemoved(flags) }
    case 'track':
      return { ok: true, listing: await consoleTrack(args) }
    case 'import':
      return settle(await consoleImport(args, flags, previewSignal))
    case 'merge':
      return settle(await consoleMerge(flags))
    case 'remove':
      return settle(await consoleRemove(args, flags))
    case 'restore':
      return settle(await consoleRestore(args, flags))
    case 'forget':
      return settle(await consoleForget(args, flags))
    case 'remove-unavailable':
      return settle(await consoleRemoveUnavailable(flags))
    case 'stage':
      return settle(await consoleStage(args, flags))
    case 'target':
      return settle(await consoleTarget(args))
    case 'auto':
      return settle(await consoleAuto(args))
    case 'login':
      return { ok: true, lines: await consoleLogin() }
    case 'logout':
      return settle(await consoleLogout())
    case 'consent':
      return settle(await consoleConsent(args))
    case 'prefetch':
      return { ok: true, lines: await consolePrefetch() }
    case 'lyrics':
      return settle(await consoleLyrics(args, flags))
    default:
      throw new Error(`unknown command ${JSON.stringify(name)} — try help`)
  }
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'console-run':
      return runConsoleCommand(message)
    case 'console-preview':
      return runConsoleCommand({ ...message, preview: true })
    case 'console-header':
      return consoleHeader()
    case 'part-info':
      return partInfo(message.ids)
    case 'status':
      return status()
    case 'connect':
      await requireRemoteConsent()
      await authConnect()
      startVectorFetch().catch(() => {})
      startLyricsFetch().catch(() => {})
      return status()
    case 'consent-status':
      return { ok: true, consent: await consentStatus() }
    case 'set-consent': {
      const currentConfig = await getConfig()
      if (message.value) {
        await store.setConsent({
          granted: true,
          at: new Date().toISOString(),
          origins: remoteOrigins(currentConfig),
        })
      } else {
        await store.clearConsent()
      }
      broadcast({ type: 'data-changed', kind: 'consent' })
      return { ok: true, consent: await consentStatus(currentConfig) }
    }
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
      return { ok: true, prefetch: prefetchState }
    case 'unavailable-list': {
      const entries = await activeUnavailable()
      const catalog = await ensureCatalog()
      const byId = new Map(catalog.tracks.map((track) => [track.id, track]))
      return {
        ok: true,
        unavailable: Object.entries(entries).map(([id, entry]) => ({
          id,
          title: entry.title || byId.get(id)?.title || '',
          code: entry.code,
          message: entry.message,
          at: entry.at,
        })),
      }
    }
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
        await store.clearVectorUnavailableMany([...accepted.keys()])
        invalidateCachedEmbeddings()
        invalidateRecommender()
        broadcast({ type: 'data-changed', kind: 'embeddings' })
        startVectorFetch().catch(() => {})
      }
      return { ok: true, count, ignored }
    }
    case 'export':
      return exportPlaylist()
    case 'embeddings-changed':
      invalidateCachedEmbeddings()
      invalidateRecommender()
      broadcast({ type: 'data-changed', kind: 'embeddings' })
      startVectorFetch().catch(() => {})
      return { ok: true }
    case 'prefetch':
      return prefetch()
    case 'set-lyrics': {
      const id =
        typeof message.id === 'string' && message.id ? message.id : await store.getCurrent()
      if (!id) throw new Error('No current track to update.')
      const wanted = Boolean(message.value)
      await store.setLyricsEntry(id, {
        lyrics: wanted,
        confidence: null,
        source: 'manual',
        at: new Date().toISOString(),
      })
      broadcast({ type: 'data-changed', kind: 'lyrics' })
      return { ok: true, id, lyrics: wanted }
    }
    case 'import-lyrics': {
      const entries = parseLyricsText(message.text)
      const catalog = await ensureCatalog()
      const known = new Set(catalog.tracks.map((track) => track.id))
      const updates = new Map()
      let ignored = 0
      for (const [id, entry] of entries) {
        if (known.has(id)) updates.set(id, entry)
        else ignored += 1
      }
      const count = await store.mergeLyrics(updates)
      broadcast({ type: 'data-changed', kind: 'lyrics' })
      return { ok: true, count, ignored }
    }
    case 'lyrics-changed':
      broadcast({ type: 'data-changed', kind: 'lyrics' })
      return { ok: true }
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
    .then(() => startVectorFetch())
    .then(() => startLyricsFetch())
    .catch((error) => console.error('initialization failed', error))
})

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === MANUAL_PREFETCH_ALARM) {
      resumeManualPrefetch().catch((error) => console.error('manual prefetch alarm failed', error))
    }
    if (alarm?.name === LYRICS_ALARM) {
      resumeLyricsAnalysis().catch((error) => console.error('lyrics analysis alarm failed', error))
    }
  })
}

chrome.runtime.onStartup.addListener(() => {
  // Tab ids are not stable across browser restarts, so the election starts fresh.
  updateTabs(() => ({})).catch(() => {})
  initialize()
    .then(() => store.resetSessionPlays())
    .then(() => resumeManualPrefetch())
    .then(() => startVectorFetch())
    .then(() => startLyricsFetch())
    .catch((error) => console.error('initialization failed', error))
})
