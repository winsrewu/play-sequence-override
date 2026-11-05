// Export/import file for the vectors: a plain JSON object whose keys are track
// ids and whose values are the vectors. The same shape is stored in the KV
// store, so an exported file is exactly the stored data.
import { parseInternalId } from './playlist.js'

export function serializeVectors(vectors, { dim = null } = {}) {
  if (!(vectors instanceof Map)) throw new Error('vectors must be a Map')
  const ids = [...vectors.keys()].sort()
  const document = {}
  let detected = null
  for (const id of ids) {
    const vector = vectors.get(id)
    if (!vector) throw new Error(`${id}: missing vector`)
    const length = vector.length
    if (length === 0) throw new Error(`${id}: vector is empty`)
    if (detected === null) detected = length
    else if (length !== detected) {
      throw new Error(`mixed vector lengths: ${id} has ${length}, expected ${detected}`)
    }
    if (dim != null && length !== dim) {
      throw new Error(`${id}: expected ${dim} dimensions, got ${length}`)
    }
    document[id] = Array.from(vector)
  }
  return { text: `${JSON.stringify(document)}\n`, count: ids.length, dim: detected ?? dim ?? 0 }
}

export function parseVectors(text, { dim = null } = {}) {
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`vector file is not valid JSON: ${error.message}`)
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('vector file root must be an object of id: vector')
  }
  const vectors = new Map()
  let fileDim = null
  for (const [id, value] of Object.entries(document)) {
    try {
      parseInternalId(id)
    } catch (error) {
      throw new Error(`${id}: ${error.message}`)
    }
    if (!Array.isArray(value)) throw new Error(`${id}: vector must be an array`)
    if (value.length === 0) throw new Error(`${id}: vector is empty`)
    if (fileDim === null) fileDim = value.length
    else if (value.length !== fileDim) {
      throw new Error(`${id}: vector length differs from the others`)
    }
    if (dim != null && value.length !== dim) {
      throw new Error(`expected ${dim} dimensions, got ${value.length}`)
    }
    const vector = new Float32Array(value.length)
    for (let index = 0; index < value.length; index += 1) {
      const number = value[index]
      if (typeof number !== 'number' || !Number.isFinite(number)) {
        throw new Error(`${id}: contains a non-finite value`)
      }
      vector[index] = number
    }
    vectors.set(id, vector)
  }
  return { dim: fileDim ?? dim ?? 0, vectors }
}
