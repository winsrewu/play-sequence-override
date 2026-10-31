// Runtime derivations for builds that ship no data: style clusters for the
// recommender and a 2-D layout for the sequence map, both computed from the
// embedding vectors already stored in IndexedDB.
//
// These approximate the Python generator (sklearn KMeans and KernelPCA), they
// are not byte-for-byte ports: clusters are recomputed lazily and the layout
// uses PCA. Style labels only group similar tracks, so their identity does not
// matter across runs; the layout only affects the visualization.

export const DERIVED_VERSION = 1
export const STYLE_CLUSTERS = 30

const STYLE_ITERATIONS = 30
const STYLE_SEED = 42
const PROJECTION_ITERATIONS = 60
const PROJECTION_SEED = 7

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

// Sorted ids plus an L2-normalized row-major matrix, shared by both derivations.
function normalizedMatrix(vectors) {
  const ids = [...vectors.keys()].sort()
  if (ids.length === 0) return null
  const dim = vectors.get(ids[0])?.length || 0
  if (dim === 0) return null
  const rows = new Float32Array(ids.length * dim)
  for (let index = 0; index < ids.length; index += 1) {
    const vector = vectors.get(ids[index])
    if (!vector || vector.length !== dim) return null
    const base = index * dim
    let norm = 0
    for (let i = 0; i < dim; i += 1) norm += vector[i] * vector[i]
    norm = Math.sqrt(norm)
    if (norm <= 1e-12) return null
    for (let i = 0; i < dim; i += 1) rows[base + i] = vector[i] / norm
  }
  return { ids, dim, rows }
}

function rowDot(a, aBase, b, bBase, dim) {
  let sum = 0
  for (let i = 0; i < dim; i += 1) sum += a[aBase + i] * b[bBase + i]
  return sum
}

function normalizeRow(row, offset, dim) {
  let norm = 0
  for (let i = 0; i < dim; i += 1) norm += row[offset + i] * row[offset + i]
  norm = Math.sqrt(norm)
  if (norm <= 1e-12) return
  for (let i = 0; i < dim; i += 1) row[offset + i] /= norm
}

export function computeStyleModel(
  vectors,
  { clusters = STYLE_CLUSTERS, iterations = STYLE_ITERATIONS, seed = STYLE_SEED } = {},
) {
  const matrix = normalizedMatrix(vectors)
  if (!matrix) return null
  const { ids, dim, rows } = matrix
  const count = ids.length
  const k = Math.max(1, Math.min(clusters, count))
  const random = mulberry32(seed)
  const centroids = new Float32Array(k * dim)
  const labels = new Int32Array(count).fill(-1)
  const closest = new Float64Array(count).fill(Infinity)

  // k-means++ seeding: independent of input order and deterministic.
  const first = Math.floor(random() * count) * dim
  centroids.set(rows.subarray(first, first + dim), 0)
  for (let cluster = 1; cluster < k; cluster += 1) {
    const previous = (cluster - 1) * dim
    let total = 0
    for (let index = 0; index < count; index += 1) {
      const distance = 1 - rowDot(rows, index * dim, centroids, previous, dim)
      if (distance < closest[index]) closest[index] = distance
      total += closest[index] * closest[index]
    }
    let chosen = count - 1
    if (total > 0) {
      let target = random() * total
      for (let index = 0; index < count; index += 1) {
        target -= closest[index] * closest[index]
        if (target <= 0) {
          chosen = index
          break
        }
      }
    }
    const base = chosen * dim
    centroids.set(rows.subarray(base, base + dim), cluster * dim)
  }

  const sums = new Float64Array(k * dim)
  const counts = new Int32Array(k)
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let changed = false
    for (let index = 0; index < count; index += 1) {
      let best = 0
      let bestSimilarity = -Infinity
      for (let cluster = 0; cluster < k; cluster += 1) {
        const similarity = rowDot(rows, index * dim, centroids, cluster * dim, dim)
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity
          best = cluster
        }
      }
      if (labels[index] !== best) {
        labels[index] = best
        changed = true
      }
    }
    if (!changed && iteration > 0) break
    sums.fill(0)
    counts.fill(0)
    for (let index = 0; index < count; index += 1) {
      const cluster = labels[index]
      counts[cluster] += 1
      const base = cluster * dim
      const rowBase = index * dim
      for (let i = 0; i < dim; i += 1) sums[base + i] += rows[rowBase + i]
    }
    for (let cluster = 0; cluster < k; cluster += 1) {
      const base = cluster * dim
      if (counts[cluster] === 0) {
        const replacement = Math.floor(random() * count) * dim
        centroids.set(rows.subarray(replacement, replacement + dim), base)
        continue
      }
      for (let i = 0; i < dim; i += 1) centroids[base + i] = sums[base + i] / counts[cluster]
      normalizeRow(centroids, base, dim)
    }
  }

  const centroidRows = Array.from({ length: k }, (_, cluster) =>
    Array.from(centroids.subarray(cluster * dim, (cluster + 1) * dim)),
  )
  return { ids, clusters: k, labels: Array.from(labels), centroids: centroidRows }
}

// PCA over the normalized vectors: two orthogonal components by power iteration
// with deflation, then coordinates for every tracked id.
export function computeProjectionModel(
  vectors,
  { iterations = PROJECTION_ITERATIONS, seed = PROJECTION_SEED } = {},
) {
  const matrix = normalizedMatrix(vectors)
  if (!matrix) return null
  const { ids, dim, rows } = matrix
  const count = ids.length

  const mean = new Float64Array(dim)
  for (let index = 0; index < count; index += 1) {
    const base = index * dim
    for (let i = 0; i < dim; i += 1) mean[i] += rows[base + i]
  }
  for (let i = 0; i < dim; i += 1) mean[i] /= count

  const centered = new Float32Array(count * dim)
  for (let index = 0; index < count; index += 1) {
    const base = index * dim
    for (let i = 0; i < dim; i += 1) centered[base + i] = rows[base + i] - mean[i]
  }

  const random = mulberry32(seed)
  const components = []
  const work = new Float64Array(count)
  const next = new Float64Array(dim)
  for (let component = 0; component < 2; component += 1) {
    for (let i = 0; i < dim; i += 1) next[i] = random() * 2 - 1
    normalizeRow(next, 0, dim)
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (let index = 0; index < count; index += 1) {
        work[index] = rowDot(centered, index * dim, next, 0, dim)
      }
      next.fill(0)
      for (let index = 0; index < count; index += 1) {
        const weight = work[index]
        const base = index * dim
        for (let i = 0; i < dim; i += 1) next[i] += weight * centered[base + i]
      }
      for (const previous of components) {
        let projection = 0
        for (let i = 0; i < dim; i += 1) projection += next[i] * previous[i]
        for (let i = 0; i < dim; i += 1) next[i] -= projection * previous[i]
      }
      normalizeRow(next, 0, dim)
    }
    const farthest = next.reduce((best, value, i) => (Math.abs(value) > Math.abs(next[best]) ? i : best), 0)
    const sign = next[farthest] < 0 ? -1 : 1
    components.push(Array.from(next, (value) => value * sign))
  }

  const x = new Array(count)
  const y = new Array(count)
  for (let index = 0; index < count; index += 1) {
    let px = 0
    let py = 0
    const base = index * dim
    for (let i = 0; i < dim; i += 1) {
      const value = centered[base + i]
      px += value * components[0][i]
      py += value * components[1][i]
    }
    x[index] = px
    y[index] = py
  }
  return { ids, x, y, mean: Array.from(mean), components }
}

export function projectPoint(model, vector) {
  if (!model || !Array.isArray(model.mean) || !Array.isArray(model.components)) {
    return { x: 0, y: 0 }
  }
  const [first, second] = model.components
  let x = 0
  let y = 0
  for (let i = 0; i < vector.length; i += 1) {
    const centered = vector[i] - model.mean[i]
    x += centered * first[i]
    y += centered * second[i]
  }
  return { x, y }
}

// Reuse a derived model while the vector set only grows; rebuild after a reset
// or when the count doubles, which bounds the k-means work per session.
export function shouldReuseDerived(record, count, dim) {
  if (!record || record.version !== DERIVED_VERSION) return false
  if (record.dim !== dim) return false
  if (!(record.count <= count)) return false
  return count < Math.max(8, record.count * 2)
}
