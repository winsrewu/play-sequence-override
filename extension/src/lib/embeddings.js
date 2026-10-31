// Bundled 960-D vectors plus the IndexedDB cache; the backend never stores vectors.
import {
  getVectorCache,
  setVectorCacheEntries,
  setVectorCacheEntry,
} from './storage.js'

const BUNDLED_INDEX = 'data/embeddings-index.json'
const BUNDLED_BIN = 'data/embeddings.bin'

let bundlePromise = null
let cachedPromise = null

export async function loadBundledEmbeddings() {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const [indexResponse, binResponse] = await Promise.all([
        fetch(chrome.runtime.getURL(BUNDLED_INDEX), { cache: 'no-store' }),
        fetch(chrome.runtime.getURL(BUNDLED_BIN), { cache: 'no-store' }),
      ])
      if (!indexResponse.ok || !binResponse.ok) {
        throw new Error('bundled embeddings are unavailable')
      }
      const index = await indexResponse.json()
      const buffer = await binResponse.arrayBuffer()
      const dim = Number(index.dim)
      const ids = Array.isArray(index.ids) ? index.ids : []
      if (!Number.isInteger(dim) || dim <= 0) throw new Error('invalid embedding dimension')
      if (buffer.byteLength !== ids.length * dim * 4) {
        throw new Error('embedding bundle size does not match its index')
      }
      const data = new Float32Array(buffer)
      const map = new Map()
      for (let i = 0; i < ids.length; i += 1) {
        map.set(ids[i], data.subarray(i * dim, (i + 1) * dim))
      }
      return {
        dim,
        model: index.model || null,
        ids,
        vectors: map,
        sha256: typeof index.sha256 === 'string' ? index.sha256 : null,
      }
    })().catch((error) => {
      bundlePromise = null
      throw error
    })
  }
  return bundlePromise
}

export async function loadCachedEmbeddings() {
  if (!cachedPromise) {
    cachedPromise = (async () => {
      return await getVectorCache()
    })().catch((error) => {
      cachedPromise = null
      throw error
    })
  }
  return cachedPromise
}

export function invalidateCachedEmbeddings() {
  cachedPromise = null
}

export async function cacheEmbedding(id, vector) {
  await setVectorCacheEntry(id, vector)
  if (cachedPromise) {
    const resolved = await cachedPromise.catch(() => null)
    if (resolved) resolved.set(id, vector)
  }
}

export async function cacheEmbeddings(vectors) {
  if (!(vectors instanceof Map) || vectors.size === 0) return 0
  const count = await setVectorCacheEntries(vectors)
  if (cachedPromise) {
    const resolved = await cachedPromise.catch(() => null)
    if (resolved) {
      for (const [id, vector] of vectors) resolved.set(id, vector)
    }
  }
  return count
}

export async function loadAllVectors() {
  const [bundle, cached] = await Promise.all([
    loadBundledEmbeddings().catch(() => ({ vectors: new Map(), dim: 960, ids: [] })),
    loadCachedEmbeddings(),
  ])
  const merged = new Map(bundle.vectors)
  for (const [id, vector] of cached) merged.set(id, vector)
  return { vectors: merged, dim: bundle.dim || 960, bundledCount: bundle.vectors.size }
}

export function missingTrackIds(tracks, vectors) {
  return tracks.filter((track) => !vectors.has(track.id)).map((track) => track.id)
}
