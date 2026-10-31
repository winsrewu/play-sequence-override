// 960-D vectors live only in IndexedDB; the extension imports or fetches them.
import {
  getVectorCache,
  setVectorCacheEntries,
  setVectorCacheEntry,
} from './storage.js'

const DEFAULT_DIM = 960

let cachedPromise = null

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
  const vectors = await loadCachedEmbeddings()
  const dim = vectors.values().next().value?.length || DEFAULT_DIM
  return { vectors, dim }
}

export function missingTrackIds(tracks, vectors) {
  return tracks.filter((track) => !vectors.has(track.id)).map((track) => track.id)
}
