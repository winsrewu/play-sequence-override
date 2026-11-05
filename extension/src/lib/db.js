// Copy vector views into exact backing stores; Chromium rejects subarray views in IndexedDB.
const DB_NAME = 'jawbts-play-sequence'
const DB_VERSION = 1
export const KV_STORE = 'kv'
export const VECTOR_STORE = 'vectors'

let dbPromise = null

export function openDatabase() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this context'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE)
      if (!db.objectStoreNames.contains(VECTOR_STORE)) {
        db.createObjectStore(VECTOR_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'))
    request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another tab'))
  }).catch((error) => {
    dbPromise = null
    throw error
  })
  return dbPromise
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'))
  })
}

export async function kvGet(key, fallback = null) {
  const db = await openDatabase()
  const tx = db.transaction(KV_STORE, 'readonly')
  const result = await requestResult(tx.objectStore(KV_STORE).get(key))
  return result === undefined ? fallback : result
}

export async function kvSet(key, value) {
  const db = await openDatabase()
  const tx = db.transaction(KV_STORE, 'readwrite')
  tx.objectStore(KV_STORE).put(value, key)
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'))
  })
}

export async function kvDelete(key) {
  const db = await openDatabase()
  const tx = db.transaction(KV_STORE, 'readwrite')
  tx.objectStore(KV_STORE).delete(key)
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('IndexedDB delete aborted'))
  })
}

export async function vectorGet(id) {
  const db = await openDatabase()
  const tx = db.transaction(VECTOR_STORE, 'readonly')
  const row = await requestResult(tx.objectStore(VECTOR_STORE).get(id))
  return row?.vector || null
}

export async function vectorGetAll() {
  const db = await openDatabase()
  const tx = db.transaction(VECTOR_STORE, 'readonly')
  const rows = await requestResult(tx.objectStore(VECTOR_STORE).getAll())
  const vectors = new Map()
  for (const row of rows || []) {
    if (row && typeof row.id === 'string' && row.vector) {
      vectors.set(row.id, row.vector instanceof Float32Array ? row.vector : Float32Array.from(row.vector))
    }
  }
  return vectors
}

export async function vectorSetMany(vectors) {
  if (!(vectors instanceof Map) || vectors.size === 0) return 0
  const db = await openDatabase()
  const tx = db.transaction(VECTOR_STORE, 'readwrite')
  const store = tx.objectStore(VECTOR_STORE)
  for (const [id, vector] of vectors) {
    store.put({ id, vector: Float32Array.from(vector) })
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('IndexedDB vector write aborted'))
  })
  return vectors.size
}

export async function vectorDelete(ids) {
  const list = [...new Set(ids)].filter((id) => typeof id === 'string' && id)
  if (list.length === 0) return 0
  const db = await openDatabase()
  const tx = db.transaction(VECTOR_STORE, 'readwrite')
  const store = tx.objectStore(VECTOR_STORE)
  for (const id of list) store.delete(id)
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('IndexedDB vector delete aborted'))
  })
  return list.length
}

export async function vectorDeleteAll() {
  const db = await openDatabase()
  const tx = db.transaction(VECTOR_STORE, 'readwrite')
  tx.objectStore(VECTOR_STORE).clear()
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('IndexedDB vector clear aborted'))
  })
}

export async function databaseGetAll() {
  const db = await openDatabase()
  const tx = db.transaction(KV_STORE, 'readonly')
  const rows = await requestResult(tx.objectStore(KV_STORE).getAll())
  return rows || []
}
