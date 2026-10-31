import { buildInternalId, parseInternalId } from './playlist.js'

export const EMBEDDING_DIM = 960

const MEDIA_EXTENSION = /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i

export function internalIdFromEmbeddingName(name) {
  if (typeof name !== 'string' || !name) throw new Error('embedding entry is missing name')
  const stem = name.replace(MEDIA_EXTENSION, '')
  if (stem.startsWith('BBV')) return parseInternalId(stem).id
  if (stem.startsWith('BV')) {
    const [base, pageText] = stem.split('_')
    const page = pageText ? Number(pageText) : 1
    if (!Number.isInteger(page) || page < 1) throw new Error(`invalid page in ${name}`)
    return buildInternalId('bilibili', base, page)
  }
  return null
}

export function parseEmbeddingJson(document, { dim = EMBEDDING_DIM } = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('embedding JSON root must be an object')
  }
  if (!Array.isArray(document.data)) {
    throw new Error('embedding JSON is missing a data array')
  }
  const vectors = new Map()
  for (let index = 0; index < document.data.length; index += 1) {
    const entry = document.data[index]
    if (!entry || typeof entry !== 'object') {
      throw new Error(`data[${index}] is not an object`)
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    // A legacy data folder mixes music.json in; entries without a file name are
    // not vectors and are skipped rather than failing the whole import.
    if (!name) continue
    const internalId = internalIdFromEmbeddingName(name)
    if (internalId === null) continue
    if (!Array.isArray(entry.embed)) {
      throw new Error(`${entry.name}: embed is not an array`)
    }
    if (entry.embed.length !== dim) {
      throw new Error(`${entry.name}: expected ${dim} dimensions, got ${entry.embed.length}`)
    }
    const vector = Float32Array.from(entry.embed)
    if (!vector.every(Number.isFinite)) {
      throw new Error(`${entry.name}: contains non-finite values`)
    }
    const previous = vectors.get(internalId)
    if (previous && (previous.length !== vector.length || previous.some((value, i) => value !== vector[i]))) {
      throw new Error(`conflicting embeddings for ${internalId}`)
    }
    vectors.set(internalId, vector)
  }
  return vectors
}

export function parseEmbeddingText(text, options = {}) {
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`embedding JSON is invalid: ${error.message}`)
  }
  return parseEmbeddingJson(document, options)
}
